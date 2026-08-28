"""The position fold.

Every claim here is about what a sequence of fills produces, because that is
what recovery and replay depend on.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from garuda.domain import Currency, CurrencyMismatchError, Direction, DomainError, Money
from garuda.domain.instrument import InstrumentId
from garuda.domain.order import ClientOrderId, Fill, Side
from garuda.domain.position import Position, opening_side

INSTRUMENT = InstrumentId("NSE:NIFTY26AUG25000CE")
INR = Currency.INR


def fill(side: Side, quantity: int, price: str) -> Fill:
    return Fill(
        client_order_id=ClientOrderId("gar-0001"),
        instrument=INSTRUMENT,
        side=side,
        quantity=quantity,
        price=Money.of(price, INR),
        timestamp=datetime(2026, 8, 27, 9, 20, tzinfo=UTC),
    )


def flat(multiplier: str = "1") -> Position:
    return Position.flat(INSTRUMENT, INR, Decimal(multiplier))


def rupees(value: str) -> Money:
    return Money.of(value, INR)


class TestOpening:
    def test_a_buy_opens_a_long_at_the_fill_price(self):
        position = flat().apply(fill(Side.BUY, 75, "120"))
        assert position.quantity == 75
        assert position.average_price == rupees("120")
        assert position.direction is Direction.LONG
        assert position.realized_pnl.is_zero

    def test_a_sell_opens_a_short(self):
        position = flat().apply(fill(Side.SELL, 75, "120"))
        assert position.quantity == -75
        assert position.direction is Direction.SHORT

    def test_adding_moves_the_average_to_the_weighted_mean(self):
        position = flat().apply(fill(Side.BUY, 50, "100")).apply(fill(Side.BUY, 100, "130"))
        assert position.quantity == 150
        assert position.average_price == rupees("120")
        assert position.realized_pnl.is_zero

    def test_adding_to_a_short_averages_the_same_way(self):
        position = flat().apply(fill(Side.SELL, 50, "100")).apply(fill(Side.SELL, 100, "130"))
        assert position.quantity == -150
        assert position.average_price == rupees("120")


class TestReducingAndClosing:
    def test_closing_a_long_realizes_the_gain_and_goes_flat(self):
        position = flat().apply(fill(Side.BUY, 75, "100")).apply(fill(Side.SELL, 75, "120"))
        assert position.is_flat
        assert position.realized_pnl == rupees("1500")
        assert position.average_price.is_zero

    def test_closing_a_short_realizes_the_gain_the_other_way(self):
        position = flat().apply(fill(Side.SELL, 75, "120")).apply(fill(Side.BUY, 75, "100"))
        assert position.is_flat
        assert position.realized_pnl == rupees("1500")

    def test_a_loss_is_realized_as_a_negative(self):
        position = flat().apply(fill(Side.BUY, 75, "120")).apply(fill(Side.SELL, 75, "100"))
        assert position.realized_pnl == rupees("-1500")
        assert position.realized_pnl.is_negative

    def test_a_partial_reduction_leaves_the_average_untouched(self):
        position = flat().apply(fill(Side.BUY, 100, "100")).apply(fill(Side.SELL, 40, "120"))
        assert position.quantity == 60
        assert position.average_price == rupees("100")
        assert position.realized_pnl == rupees("800")

    def test_the_multiplier_scales_realized_pnl(self):
        position = flat("50").apply(fill(Side.BUY, 2, "100")).apply(fill(Side.SELL, 2, "110"))
        assert position.realized_pnl == rupees("1000")  # 2 * 10 * 50


class TestCrossingThroughZero:
    """The case that gets written wrongly."""

    def test_the_remainder_opens_at_the_fill_price_not_a_blend(self):
        position = flat().apply(fill(Side.SELL, 100, "200")).apply(fill(Side.BUY, 150, "180"))
        assert position.quantity == 50
        assert position.average_price == rupees("180")

    def test_only_the_closed_quantity_is_realized(self):
        position = flat().apply(fill(Side.SELL, 100, "200")).apply(fill(Side.BUY, 150, "180"))
        assert position.realized_pnl == rupees("2000")  # 100 * 20, not 150 * 20

    def test_crossing_the_other_way_behaves_the_same(self):
        position = flat().apply(fill(Side.BUY, 100, "180")).apply(fill(Side.SELL, 150, "200"))
        assert position.quantity == -50
        assert position.average_price == rupees("200")
        assert position.realized_pnl == rupees("2000")

    def test_crossing_is_not_the_same_as_reducing_then_opening_being_blended(self):
        crossed = flat().apply(fill(Side.SELL, 100, "200")).apply(fill(Side.BUY, 150, "180"))
        stepwise = (
            flat()
            .apply(fill(Side.SELL, 100, "200"))
            .apply(fill(Side.BUY, 100, "180"))
            .apply(fill(Side.BUY, 50, "180"))
        )
        assert crossed == stepwise


class TestValuation:
    def test_a_flat_position_has_no_unrealized_pnl_at_any_mark(self):
        assert flat().unrealized_pnl(rupees("99999")).is_zero

    def test_a_long_gains_when_the_mark_rises(self):
        position = flat().apply(fill(Side.BUY, 75, "100"))
        assert position.unrealized_pnl(rupees("110")) == rupees("750")

    def test_a_short_gains_when_the_mark_falls(self):
        position = flat().apply(fill(Side.SELL, 75, "100"))
        assert position.unrealized_pnl(rupees("90")) == rupees("750")

    def test_total_pnl_adds_realized_and_unrealized(self):
        position = flat().apply(fill(Side.BUY, 100, "100")).apply(fill(Side.SELL, 40, "120"))
        assert position.total_pnl(rupees("110")) == rupees("800") + rupees("600")

    def test_exposure_is_absolute_whichever_way_the_position_faces(self):
        long_position = flat().apply(fill(Side.BUY, 75, "100"))
        short_position = flat().apply(fill(Side.SELL, 75, "100"))
        assert long_position.exposure(rupees("100")) == short_position.exposure(rupees("100"))

    def test_a_mark_in_another_currency_is_refused(self):
        with pytest.raises(CurrencyMismatchError):
            flat().unrealized_pnl(Money.of(100, Currency.USD))


class TestFoldProperties:
    sides = st.sampled_from([Side.BUY, Side.SELL])
    quantities = st.integers(min_value=1, max_value=500)
    prices = st.decimals(
        min_value=Decimal("0.05"),
        max_value=Decimal("5000"),
        allow_nan=False,
        allow_infinity=False,
        places=2,
    )

    @given(sequence=st.lists(st.tuples(sides, quantities, prices), min_size=1, max_size=12))
    def test_folding_one_at_a_time_equals_folding_the_sequence(self, sequence):
        """apply_all is exactly repeated apply — what replay relies on."""
        fills = [
            Fill(
                client_order_id=ClientOrderId("gar-0001"),
                instrument=INSTRUMENT,
                side=side,
                quantity=quantity,
                price=Money(price, INR),
                timestamp=datetime(2026, 8, 27, 9, 20, tzinfo=UTC),
            )
            for side, quantity, price in sequence
        ]
        stepwise = flat()
        for one in fills:
            stepwise = stepwise.apply(one)
        assert flat().apply_all(fills) == stepwise

    @given(sequence=st.lists(st.tuples(sides, quantities, prices), min_size=1, max_size=12))
    def test_the_net_quantity_is_the_signed_sum_of_the_fills(self, sequence):
        fills = [
            Fill(
                client_order_id=ClientOrderId("gar-0001"),
                instrument=INSTRUMENT,
                side=side,
                quantity=quantity,
                price=Money(price, INR),
                timestamp=datetime(2026, 8, 27, 9, 20, tzinfo=UTC),
            )
            for side, quantity, price in sequence
        ]
        expected = sum(f.quantity * f.side.sign for f in fills)
        assert flat().apply_all(fills).quantity == expected

    @given(quantity=quantities, price=prices, mark=prices)
    def test_a_round_trip_at_the_same_price_realizes_nothing(self, quantity, price, mark):
        opened = flat().apply(fill(Side.BUY, quantity, str(price)))
        closed = opened.apply(fill(Side.SELL, quantity, str(price)))
        assert closed.is_flat
        assert closed.realized_pnl.is_zero
        assert closed.unrealized_pnl(Money(mark, INR)).is_zero


class TestRejections:
    def test_a_fill_for_another_instrument_is_refused(self):
        other = Fill(
            client_order_id=ClientOrderId("gar-0001"),
            instrument=InstrumentId("NSE:OTHER"),
            side=Side.BUY,
            quantity=1,
            price=rupees("100"),
            timestamp=datetime(2026, 8, 27, 9, 20, tzinfo=UTC),
        )
        with pytest.raises(DomainError, match="fill is for"):
            flat().apply(other)

    def test_a_flat_position_cannot_carry_an_average_price(self):
        with pytest.raises(DomainError, match="flat position"):
            Position(
                instrument=INSTRUMENT,
                currency=INR,
                quantity=0,
                average_price=rupees("100"),
                realized_pnl=Money.zero(INR),
            )

    def test_the_opening_side_matches_the_direction(self):
        assert opening_side(Direction.LONG) is Side.BUY
        assert opening_side(Direction.SHORT) is Side.SELL
