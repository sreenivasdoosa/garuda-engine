"""The risk gate.

Each check has a case that triggers it and a case that must not, because a
gate that vetoes correct orders gets switched off and then protects nothing.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.market import DepthLevel, Tick
from garuda.domain.order import ClientOrderId, OrderRequest, Side
from garuda.rms import (
    Breach,
    BreachFamily,
    BreachType,
    KillSwitch,
    RiskContext,
    RiskGate,
    RiskLimits,
    default_checks,
)
from garuda.rms.checks import (
    FreezeQuantityCheck,
    KillSwitchCheck,
    OrderQuantityCheck,
    OrderValueCheck,
    PriceNonZeroCheck,
    QuoteAvailableCheck,
    SpreadCheck,
    StaleQuoteCheck,
    VolumeCheck,
)

T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_request(instrument: Instrument, quantity: int = 75) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId("gar-1"),
        trading_client=CLIENT,
        instrument=instrument.id,
        side=Side.SELL,
        quantity=quantity,
        order_type=OrderType.MARKET,
        product=ProductType.NRML,
    )


def a_quote(
    instrument: Instrument,
    last: str = "120.00",
    at: datetime = T0,
    bid: str | None = None,
    ask: str | None = None,
    volume: int | None = None,
) -> Tick:
    return Tick(
        instrument=instrument.id,
        last_price=rupees(last),
        timestamp=at,
        bids=(DepthLevel(rupees(bid), 50),) if bid else (),
        asks=(DepthLevel(rupees(ask), 50),) if ask else (),
        volume=volume,
    )


def context(instrument: Instrument, **overrides: object) -> RiskContext:
    base: dict[str, object] = {
        "request": a_request(instrument),
        "instrument": instrument,
        "now": T0,
        "limits": RiskLimits(),
        "quote": a_quote(instrument),
    }
    return RiskContext(**{**base, **overrides})  # type: ignore[arg-type]


class TestVocabulary:
    @pytest.mark.parametrize("breach", list(BreachType))
    def test_every_breach_type_belongs_to_a_family(self, breach):
        assert isinstance(breach.family, BreachFamily)

    def test_the_families_group_by_what_they_protect(self):
        assert BreachType.PRICE_STALE.family is BreachFamily.PRICE_QUALITY
        assert BreachType.KILL_SWITCH_ACTIVE.family is BreachFamily.SYSTEM
        assert BreachType.EXIT_QTY_EXCEEDS_POSITION.family is BreachFamily.EXIT_SAFETY


class TestKillSwitch:
    def test_an_active_switch_vetoes(self, nifty_call):
        breach = KillSwitchCheck()(context(nifty_call, kill_switch_reason="operator stopped"))
        assert breach is not None
        assert breach.type is BreachType.KILL_SWITCH_ACTIVE

    def test_no_switch_says_nothing(self, nifty_call):
        assert KillSwitchCheck()(context(nifty_call)) is None

    def test_the_global_switch_covers_every_client(self):
        switch = KillSwitch(global_reason="market-wide halt")
        assert switch.reason_for(CLIENT) is not None
        assert switch.reason_for(TradingClientId("someone-else")) is not None

    def test_a_client_switch_covers_only_that_client(self):
        switch = KillSwitch(client_reasons=frozenset({(CLIENT, "margin call")}))
        assert switch.reason_for(CLIENT) is not None
        assert switch.reason_for(TradingClientId("someone-else")) is None

    def test_a_fresh_switch_is_inactive(self):
        assert not KillSwitch().is_active


class TestPriceQuality:
    def test_a_missing_quote_vetoes(self, nifty_call):
        assert QuoteAvailableCheck()(context(nifty_call, quote=None)) is not None

    def test_a_present_quote_passes(self, nifty_call):
        assert QuoteAvailableCheck()(context(nifty_call)) is None

    def test_a_zero_price_vetoes(self, nifty_call):
        """A feed defect that reads as a free trade."""
        ctx = context(nifty_call, quote=a_quote(nifty_call, last="0"))
        assert PriceNonZeroCheck()(ctx) is not None

    def test_a_stale_quote_vetoes(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, at=T0 - timedelta(minutes=5)),
            limits=RiskLimits(stale_quote_after=timedelta(seconds=30)),
        )
        breach = StaleQuoteCheck()(ctx)
        assert breach is not None
        assert "300s old" in breach.detail

    def test_a_fresh_quote_passes(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, at=T0 - timedelta(seconds=5)),
            limits=RiskLimits(stale_quote_after=timedelta(seconds=30)),
        )
        assert StaleQuoteCheck()(ctx) is None

    def test_staleness_is_not_enforced_when_no_limit_is_set(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, at=T0 - timedelta(days=2)),
            limits=RiskLimits(stale_quote_after=None),
        )
        assert StaleQuoteCheck()(ctx) is None


class TestOrderShape:
    def test_an_oversized_order_vetoes(self, nifty_call):
        ctx = context(
            nifty_call,
            request=a_request(nifty_call, quantity=1000),
            limits=RiskLimits(max_order_quantity=750),
        )
        assert OrderQuantityCheck()(ctx) is not None

    def test_an_order_at_the_limit_passes(self, nifty_call):
        ctx = context(
            nifty_call,
            request=a_request(nifty_call, quantity=750),
            limits=RiskLimits(max_order_quantity=750),
        )
        assert OrderQuantityCheck()(ctx) is None

    def test_an_order_worth_too_much_vetoes(self, nifty_call):
        """The guard against a sizing bug turning one lot into a hundred."""
        ctx = context(
            nifty_call,
            request=a_request(nifty_call, quantity=7500),
            limits=RiskLimits(max_order_value=rupees("500000")),
        )
        breach = OrderValueCheck()(ctx)
        assert breach is not None
        assert breach.type is BreachType.ORDER_VALUE_EXCEEDED

    def test_a_modest_order_passes_the_value_check(self, nifty_call):
        ctx = context(nifty_call, limits=RiskLimits(max_order_value=rupees("500000")))
        assert OrderValueCheck()(ctx) is None

    def test_exceeding_the_freeze_limit_vetoes(self, nifty_call):
        """Reaching the gate at all means sizing failed to slice the entry."""
        ctx = context(nifty_call, request=a_request(nifty_call, quantity=1801))
        breach = FreezeQuantityCheck()(ctx)
        assert breach is not None
        assert "should have been sliced" in breach.detail

    def test_an_instrument_with_no_freeze_limit_never_trips_it(self, reliance):
        ctx = context(reliance, request=a_request(reliance, quantity=1_000_000))
        assert FreezeQuantityCheck()(ctx) is None


class TestLiquidity:
    def test_a_wide_spread_vetoes(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, bid="114.00", ask="126.00"),
            limits=RiskLimits(max_spread_fraction=Decimal("0.05")),
        )
        assert SpreadCheck()(ctx) is not None

    def test_a_tight_spread_passes(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, bid="119.90", ask="120.10"),
            limits=RiskLimits(max_spread_fraction=Decimal("0.05")),
        )
        assert SpreadCheck()(ctx) is None

    def test_a_quote_without_depth_cannot_breach_the_spread_check(self, nifty_call):
        ctx = context(nifty_call, limits=RiskLimits(max_spread_fraction=Decimal("0.05")))
        assert SpreadCheck()(ctx) is None

    def test_thin_volume_vetoes(self, nifty_call):
        ctx = context(
            nifty_call,
            quote=a_quote(nifty_call, volume=100),
            limits=RiskLimits(min_volume=50_000),
        )
        assert VolumeCheck()(ctx) is not None


class TestTheGate:
    def test_a_clean_order_is_allowed(self, nifty_call):
        decision = RiskGate(default_checks()).evaluate(context(nifty_call))
        assert decision.allowed
        assert decision.breaches == ()

    def test_every_breach_is_reported_not_just_the_first(self, nifty_call):
        """Reporting only the first would hide the kill switch behind a spread."""
        ctx = context(
            nifty_call,
            request=a_request(nifty_call, quantity=5000),
            kill_switch_reason="operator stopped",
            market_open=False,
            limits=RiskLimits(max_order_quantity=750),
        )
        decision = RiskGate(default_checks()).evaluate(ctx)
        assert not decision.allowed
        assert decision.has(BreachType.KILL_SWITCH_ACTIVE)
        assert decision.has(BreachType.MARKET_CLOSED)
        assert decision.has(BreachType.ORDER_QTY_EXCEEDED)

    def test_the_reason_names_every_breach(self, nifty_call):
        ctx = context(nifty_call, kill_switch_reason="stopped", market_open=False)
        decision = RiskGate(default_checks()).evaluate(ctx)
        assert "KILL_SWITCH_ACTIVE" in decision.reason
        assert "MARKET_CLOSED" in decision.reason

    def test_a_check_that_raises_is_a_veto_not_a_shrug(self, nifty_call):
        """A gate that cannot answer must not wave the order through."""

        class BrokenCheck:
            breach_type = BreachType.CHECK_FAILED

            def __call__(self, context: RiskContext) -> Breach | None:
                raise ZeroDivisionError("this check has a bug")

        decision = RiskGate([BrokenCheck()]).evaluate(context(nifty_call))
        assert not decision.allowed
        assert decision.has(BreachType.CHECK_FAILED)
        assert "ZeroDivisionError" in decision.reason

    def test_one_broken_check_does_not_stop_the_others(self, nifty_call):
        class BrokenCheck:
            breach_type = BreachType.CHECK_FAILED

            def __call__(self, context: RiskContext) -> Breach | None:
                raise ValueError("bug")

        gate = RiskGate([BrokenCheck(), KillSwitchCheck()])
        decision = gate.evaluate(context(nifty_call, kill_switch_reason="stopped"))
        assert decision.has(BreachType.CHECK_FAILED)
        assert decision.has(BreachType.KILL_SWITCH_ACTIVE)

    def test_an_empty_gate_allows_everything(self, nifty_call):
        """Stated so nobody mistakes an unconfigured gate for a safe one."""
        assert RiskGate([]).evaluate(context(nifty_call)).allowed


class TestLimitComposition:
    def test_an_override_narrows_the_inherited_limit(self):
        system = RiskLimits(max_order_quantity=1000, max_order_value=rupees("1000000"))
        client = RiskLimits(max_order_quantity=500)
        merged = system.merged_with(client)
        assert merged.max_order_quantity == 500
        assert merged.max_order_value == rupees("1000000")

    def test_an_unset_override_inherits(self):
        system = RiskLimits(min_volume=50_000)
        assert system.merged_with(RiskLimits()).min_volume == 50_000

    def test_composition_is_layered_not_replaced(self):
        system = RiskLimits(max_order_quantity=1000, min_volume=50_000)
        client = RiskLimits(max_order_quantity=500)
        strategy = RiskLimits(min_volume=10_000)
        merged = system.merged_with(client).merged_with(strategy)
        assert merged.max_order_quantity == 500
        assert merged.min_volume == 10_000
