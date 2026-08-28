"""Sizing: allocation, leg ratios, and slicing for the freeze limit."""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from garuda.capital import (
    AllocationRequest,
    CapitalLotAllocator,
    FixedLotAllocator,
    RiskAwareLotAllocator,
    Sizer,
    slice_for_freeze_limit,
)
from garuda.domain import Currency, Direction, DomainError, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.intent import Intent, IntentKind, LegRole

CLIENT = TradingClientId("appa-zerodha")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def an_intent(instrument: Instrument, **overrides: object) -> Intent:
    base: dict[str, object] = {
        "kind": IntentKind.ENTER,
        "strategy": "short-straddle",
        "trading_client": CLIENT,
        "instrument": instrument.id,
        "direction": Direction.SHORT,
        "product": ProductType.NRML,
        "correlation_id": "corr-1",
    }
    return Intent(**{**base, **overrides})  # type: ignore[arg-type]


class TestIntent:
    def test_an_intent_carries_no_quantity(self, nifty_call):
        """Sizing is the engine's job, which is what makes a strategy portable."""
        intent = an_intent(nifty_call)
        assert not hasattr(intent, "quantity")

    def test_an_intent_must_name_its_strategy(self, nifty_call):
        with pytest.raises(DomainError, match="name its strategy"):
            an_intent(nifty_call, strategy="")

    def test_an_intent_must_carry_a_correlation_id(self, nifty_call):
        """Without it a decision cannot be reconstructed end to end."""
        with pytest.raises(DomainError, match="correlation id"):
            an_intent(nifty_call, correlation_id="")

    def test_a_market_intent_takes_no_limit_price(self, nifty_call):
        with pytest.raises(DomainError, match="takes no limit price"):
            an_intent(nifty_call, limit_price=rupees("120"))


class TestFixedAllocation:
    def test_it_returns_what_it_was_configured_with(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(3)).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("1000000")
        )
        assert sizing.lots == 3
        assert sizing.quantity == 225  # 3 lots of 75

    def test_it_ignores_the_capital_entirely(self, nifty_call):
        rich = Sizer(FixedLotAllocator(3)).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("10000000")
        )
        poor = Sizer(FixedLotAllocator(3)).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("1000")
        )
        assert rich.lots == poor.lots == 3


class TestCapitalAllocation:
    def test_it_buys_as_many_whole_lots_as_the_capital_affords(self, nifty_call):
        # one lot costs 120 * 75 = 9,000
        sizing = Sizer(CapitalLotAllocator()).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("50000")
        )
        assert sizing.lots == 5
        assert sizing.notional == rupees("45000")

    def test_it_rounds_down_never_up(self, nifty_call):
        """Rounding up puts on a position the account cannot fund."""
        sizing = Sizer(CapitalLotAllocator()).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("17999")
        )
        assert sizing.lots == 1

    def test_capital_short_of_one_lot_trades_nothing(self, nifty_call):
        sizing = Sizer(CapitalLotAllocator()).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("100")
        )
        assert sizing.lots == 0
        assert not sizing.is_tradable
        assert sizing.refusal is not None
        assert "affords no whole lot" in sizing.refusal

    def test_utilisation_holds_capital_back(self, nifty_call):
        sizing = Sizer(CapitalLotAllocator(utilisation=Decimal("0.5"))).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("50000")
        )
        assert sizing.lots == 2

    @given(capital=st.integers(min_value=0, max_value=10_000_000))
    def test_the_position_never_costs_more_than_the_capital(self, nifty_call, capital):
        sizing = Sizer(CapitalLotAllocator()).size(
            an_intent(nifty_call),
            nifty_call,
            rupees("120"),
            Money.of(capital, Currency.INR),
        )
        assert sizing.notional <= Money.of(capital, Currency.INR)


class TestRiskAwareAllocation:
    def test_a_wider_stop_gives_a_smaller_position(self, nifty_call):
        """Risk per trade stays constant while volatility does not."""
        sizer = Sizer(RiskAwareLotAllocator(risk_fraction=Decimal("0.02")))
        tight = sizer.size(
            an_intent(nifty_call),
            nifty_call,
            rupees("120"),
            rupees("1000000"),
            stop_distance=rupees("5"),
        )
        wide = sizer.size(
            an_intent(nifty_call),
            nifty_call,
            rupees("120"),
            rupees("1000000"),
            stop_distance=rupees("20"),
        )
        assert tight.lots > wide.lots

    def test_the_loss_at_the_stop_is_the_risk_budget(self, nifty_call):
        # 2% of 10,00,000 = 20,000; a 5-point stop on 75 units risks 375 a lot
        sizer = Sizer(RiskAwareLotAllocator(risk_fraction=Decimal("0.02")))
        sizing = sizer.size(
            an_intent(nifty_call),
            nifty_call,
            rupees("120"),
            rupees("1000000"),
            stop_distance=rupees("5"),
        )
        assert sizing.lots == 53  # floor(20000 / 375)
        assert nifty_call.notional(rupees("5"), sizing.quantity) <= rupees("20000")

    def test_without_a_stop_it_refuses_rather_than_inventing_one(self, nifty_call):
        """A risk-aware allocator with a guessed stop is not risk-aware."""
        sizing = Sizer(RiskAwareLotAllocator()).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("1000000")
        )
        assert sizing.lots == 0


class TestLegRatios:
    def test_a_half_size_hedge_is_half_the_lots(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(10)).size(
            an_intent(nifty_call, role=LegRole.HEDGE, ratio_numerator=1, ratio_denominator=2),
            nifty_call,
            rupees("120"),
            rupees("1000000"),
        )
        assert sizing.lots == 5

    def test_a_ratio_that_does_not_divide_evenly_rounds_down(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(11)).size(
            an_intent(nifty_call, ratio_numerator=1, ratio_denominator=3),
            nifty_call,
            rupees("120"),
            rupees("1000000"),
        )
        assert sizing.lots == 3  # exact rational arithmetic, not a float question

    def test_the_default_ratio_changes_nothing(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(7)).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("1000000")
        )
        assert sizing.lots == 7


class TestFreezeSlicing:
    def test_a_small_order_is_one_slice(self, nifty_call):
        assert slice_for_freeze_limit(750, nifty_call) == (750,)

    def test_an_order_at_the_limit_is_still_one_slice(self, nifty_call):
        assert slice_for_freeze_limit(1800, nifty_call) == (1800,)

    def test_a_large_order_is_split_below_the_limit(self, nifty_call):
        slices = slice_for_freeze_limit(5025, nifty_call)  # 67 lots
        assert slices == (1800, 1800, 1425)
        assert all(size <= 1800 for size in slices)

    def test_every_slice_is_a_whole_number_of_lots(self, nifty_call):
        """A part-lot slice would be rejected by the exchange."""
        for size in slice_for_freeze_limit(5025, nifty_call):
            assert size % nifty_call.lot_size == 0

    def test_the_slices_add_up_to_the_original_quantity(self, nifty_call):
        assert sum(slice_for_freeze_limit(5025, nifty_call)) == 5025

    def test_a_quantity_that_is_not_a_whole_number_of_lots_is_refused(self, nifty_call):
        """Reaching slicing unaligned means the sizing layer has a bug."""
        with pytest.raises(DomainError, match="not a whole number"):
            slice_for_freeze_limit(5000, nifty_call)

    @given(quantity=st.integers(min_value=1, max_value=100).map(lambda lots: lots * 75))
    def test_slicing_conserves_quantity_and_respects_the_limit(self, nifty_call, quantity):
        slices = slice_for_freeze_limit(quantity, nifty_call)
        assert sum(slices) == quantity
        assert all(0 < size <= 1800 for size in slices)
        assert all(size % 75 == 0 for size in slices)

    def test_an_instrument_with_no_freeze_limit_is_never_sliced(self, reliance):
        assert slice_for_freeze_limit(1_000_000, reliance) == (1_000_000,)

    def test_sizing_produces_the_slices_that_will_be_sent(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(67)).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("100000000")
        )
        assert sizing.quantity == 5025
        assert sizing.order_count == 3
        assert sum(sizing.slices) == sizing.quantity


class TestGuards:
    def test_sizing_an_intent_for_another_instrument_is_refused(self, nifty_call, reliance):
        with pytest.raises(DomainError, match="intent is for"):
            Sizer(FixedLotAllocator(1)).size(
                an_intent(reliance), nifty_call, rupees("120"), rupees("100000")
            )

    def test_a_max_lots_cap_is_applied_after_allocation(self, nifty_call):
        sizing = Sizer(FixedLotAllocator(100), max_lots=10).size(
            an_intent(nifty_call), nifty_call, rupees("120"), rupees("100000000")
        )
        assert sizing.lots == 10

    def test_capital_in_another_currency_is_refused(self, nifty_call):
        with pytest.raises(DomainError, match="capital is USD"):
            AllocationRequest(
                instrument=nifty_call,
                price=rupees("120"),
                capital=Money.of(1000, Currency.USD),
            )

    def test_a_non_positive_price_cannot_be_sized_against(self, nifty_call):
        with pytest.raises(DomainError, match="cannot size against"):
            AllocationRequest(instrument=nifty_call, price=rupees("0"), capital=rupees("100000"))
