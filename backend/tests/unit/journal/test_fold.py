"""Folding a journal back into state.

Every claim is about what a replayed event stream produces, because that is
what recovery, audit and the replay harness all rest on.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from garuda.domain import Currency, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.journal import (
    Actor,
    AggregateType,
    EventType,
    JournalEvent,
    decode_fill,
    decode_order_request,
    encode_fill,
    encode_order_request,
    order_accepted,
    order_filled,
    order_placed,
    order_rejected,
    trading_halted,
)
from garuda.domain.order import BrokerOrderId, ClientOrderId, Fill, OrderRequest, Side
from garuda.domain.position import Position
from garuda.journal import (
    FoldedState,
    JournalFoldError,
    PositionBasis,
    PositionKey,
    compare_positions,
    fold,
)

DAY = date(2026, 8, 27)
T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")
OTHER_CLIENT = TradingClientId("amma-fyers")
INSTRUMENT = InstrumentId("NSE:NIFTY26AUG25000CE")
BASES = {INSTRUMENT: PositionBasis(Currency.INR, Decimal(1))}


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def request(order_id: str = "gar-1", side: Side = Side.SELL, quantity: int = 75) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId(order_id),
        trading_client=CLIENT,
        instrument=INSTRUMENT,
        side=side,
        quantity=quantity,
        order_type=OrderType.LIMIT,
        product=ProductType.NRML,
        price=rupees("120.50"),
    )


def fill(order_id: str, side: Side, quantity: int, price: str, at: datetime = T0) -> Fill:
    return Fill(
        client_order_id=ClientOrderId(order_id),
        instrument=INSTRUMENT,
        side=side,
        quantity=quantity,
        price=rupees(price),
        timestamp=at,
    )


def sequenced(*events: JournalEvent) -> list[JournalEvent]:
    return [event.with_sequence(i) for i, event in enumerate(events, start=1)]


class TestCodecRoundTrips:
    """A journal that cannot reproduce its own values is not a journal."""

    def test_an_order_request_survives_encoding(self):
        original = request()
        assert decode_order_request(encode_order_request(original)) == original

    def test_a_fill_survives_encoding(self):
        original = fill("gar-1", Side.SELL, 75, "120.55")
        assert decode_fill(encode_fill(original)) == original

    @given(
        amount=st.decimals(
            min_value=Decimal("0.01"),
            max_value=Decimal("100000"),
            allow_nan=False,
            allow_infinity=False,
            places=4,
        )
    )
    def test_no_price_loses_precision_through_the_journal(self, amount):
        original = fill("gar-1", Side.BUY, 1, str(amount))
        assert decode_fill(encode_fill(original)).price.amount == amount

    def test_amounts_are_encoded_as_strings_not_json_numbers(self):
        """A JSON number is a float, and a float cannot hold a paisa."""
        encoded = encode_fill(fill("gar-1", Side.BUY, 1, "0.10"))
        price = encoded["price"]
        assert isinstance(price, dict)
        assert price["amount"] == "0.10"
        assert isinstance(price["amount"], str)


class TestOrderLifecycle:
    def test_a_placed_order_folds_to_pending(self):
        state = fold(sequenced(order_placed(request(), occurred_at=T0, trading_day=DAY)), BASES)
        order = state.orders[ClientOrderId("gar-1")]
        assert order.status is OrderStatus.PENDING_NEW
        assert order.request == request()

    def test_acceptance_records_the_broker_id(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_accepted(
                ClientOrderId("gar-1"),
                BrokerOrderId("250827000123"),
                occurred_at=T0,
                trading_day=DAY,
            ),
        )
        order = fold(events, BASES).orders[ClientOrderId("gar-1")]
        assert order.status is OrderStatus.NEW
        assert order.broker_order_id == BrokerOrderId("250827000123")

    def test_a_rejection_keeps_its_reason(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_rejected(
                ClientOrderId("gar-1"), "insufficient margin", occurred_at=T0, trading_day=DAY
            ),
        )
        order = fold(events, BASES).orders[ClientOrderId("gar-1")]
        assert order.status is OrderStatus.REJECTED
        assert order.rejection_reason == "insufficient margin"

    def test_partial_then_full_fill_completes_the_order(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_accepted(
                ClientOrderId("gar-1"), BrokerOrderId("b1"), occurred_at=T0, trading_day=DAY
            ),
            order_filled(fill("gar-1", Side.SELL, 25, "120"), trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 50, "121"), trading_day=DAY),
        )
        order = fold(events, BASES).orders[ClientOrderId("gar-1")]
        assert order.status is OrderStatus.FILLED
        assert order.filled_quantity == 75

    def test_open_orders_exclude_terminal_ones(self):
        events = sequenced(
            order_placed(request("gar-1"), occurred_at=T0, trading_day=DAY),
            order_placed(request("gar-2"), occurred_at=T0, trading_day=DAY),
            order_rejected(ClientOrderId("gar-2"), "rejected", occurred_at=T0, trading_day=DAY),
        )
        state = fold(events, BASES)
        assert set(state.open_orders) == {ClientOrderId("gar-1")}


class TestPositions:
    def test_fills_fold_into_a_position(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_accepted(
                ClientOrderId("gar-1"), BrokerOrderId("b1"), occurred_at=T0, trading_day=DAY
            ),
            order_filled(fill("gar-1", Side.SELL, 75, "120"), trading_day=DAY),
        )
        position = fold(events, BASES).position(PositionKey(CLIENT, INSTRUMENT))
        assert position is not None
        assert position.quantity == -75
        assert position.average_price == rupees("120")

    def test_positions_are_kept_per_account(self):
        """Netting two accounts would report a flat book while both carry risk."""
        mine = request("gar-1", Side.SELL, 75)
        theirs = OrderRequest(
            client_order_id=ClientOrderId("gar-2"),
            trading_client=OTHER_CLIENT,
            instrument=INSTRUMENT,
            side=Side.BUY,
            quantity=75,
            order_type=OrderType.MARKET,
            product=ProductType.NRML,
        )
        events = sequenced(
            order_placed(mine, occurred_at=T0, trading_day=DAY),
            order_placed(theirs, occurred_at=T0, trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 75, "120"), trading_day=DAY),
            order_filled(fill("gar-2", Side.BUY, 75, "120"), trading_day=DAY),
        )
        state = fold(events, BASES)
        mine_position = state.position(PositionKey(CLIENT, INSTRUMENT))
        theirs_position = state.position(PositionKey(OTHER_CLIENT, INSTRUMENT))
        assert mine_position is not None
        assert theirs_position is not None
        assert mine_position.quantity == -75
        assert theirs_position.quantity == 75

    def test_a_round_trip_realizes_pnl_and_goes_flat(self):
        events = sequenced(
            order_placed(request("gar-1", Side.SELL), occurred_at=T0, trading_day=DAY),
            order_placed(request("gar-2", Side.BUY), occurred_at=T0, trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 75, "120"), trading_day=DAY),
            order_filled(fill("gar-2", Side.BUY, 75, "100"), trading_day=DAY),
        )
        position = fold(events, BASES).position(PositionKey(CLIENT, INSTRUMENT))
        assert position is not None
        assert position.is_flat
        assert position.realized_pnl == rupees("1500")

    def test_an_instrument_with_no_basis_is_refused(self):
        """A guessed multiplier produces a plausible, wrong P&L."""
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 75, "120"), trading_day=DAY),
        )
        with pytest.raises(JournalFoldError, match="no currency or multiplier"):
            fold(events, {})


class TestDeterminism:
    def test_the_same_journal_always_folds_to_the_same_state(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_accepted(
                ClientOrderId("gar-1"), BrokerOrderId("b1"), occurred_at=T0, trading_day=DAY
            ),
            order_filled(fill("gar-1", Side.SELL, 25, "120"), trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 50, "121"), trading_day=DAY),
        )
        assert fold(events, BASES) == fold(events, BASES)

    def test_folding_a_prefix_then_the_rest_matches_folding_the_whole(self):
        """Recovery from a snapshot must land where a full replay would."""
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_accepted(
                ClientOrderId("gar-1"), BrokerOrderId("b1"), occurred_at=T0, trading_day=DAY
            ),
            order_filled(fill("gar-1", Side.SELL, 25, "120"), trading_day=DAY),
            order_filled(fill("gar-1", Side.SELL, 50, "121"), trading_day=DAY),
        )
        whole = fold(events, BASES)
        assert whole.last_sequence == 4
        assert fold(events[:2] + events[2:], BASES) == whole


class TestOrdering:
    def test_an_out_of_order_journal_is_refused(self):
        first = order_placed(request(), occurred_at=T0, trading_day=DAY).with_sequence(5)
        second = order_rejected(
            ClientOrderId("gar-1"), "x", occurred_at=T0, trading_day=DAY
        ).with_sequence(2)
        with pytest.raises(JournalFoldError, match="out of order"):
            fold([first, second], BASES)

    def test_a_fill_for_an_order_never_placed_is_refused(self):
        with pytest.raises(JournalFoldError, match="referenced before it was placed"):
            fold(sequenced(order_filled(fill("ghost", Side.BUY, 1, "1"), trading_day=DAY)), BASES)

    def test_the_same_order_placed_twice_is_refused(self):
        events = sequenced(
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_placed(request(), occurred_at=T0 + timedelta(seconds=1), trading_day=DAY),
        )
        with pytest.raises(JournalFoldError, match="placed twice"):
            fold(events, BASES)


class TestHalt:
    def test_a_halt_is_visible_in_the_folded_state(self):
        events = sequenced(
            trading_halted("reconciliation mismatch", occurred_at=T0, trading_day=DAY)
        )
        state = fold(events, BASES)
        assert state.halted
        assert state.halt_reason == "reconciliation mismatch"

    def test_a_fresh_journal_is_not_halted(self):
        assert not fold([], BASES).halted


class TestReconciliation:
    def key(self) -> PositionKey:
        return PositionKey(CLIENT, INSTRUMENT)

    def position(self, quantity: int, average: str, realized: str = "0") -> Position:
        return Position(
            instrument=INSTRUMENT,
            currency=Currency.INR,
            quantity=quantity,
            average_price=rupees(average) if quantity else Money.zero(Currency.INR),
            realized_pnl=rupees(realized),
        )

    def test_agreement_produces_no_mismatch(self):
        both = {self.key(): self.position(-75, "120")}
        assert compare_positions(both, both) == []

    def test_a_quantity_difference_is_a_mismatch(self):
        folded = {self.key(): self.position(-75, "120")}
        stored = {self.key(): self.position(-50, "120")}
        assert len(compare_positions(folded, stored)) == 1

    def test_a_realized_pnl_difference_is_a_mismatch(self):
        folded = {self.key(): self.position(-75, "120", "1500")}
        stored = {self.key(): self.position(-75, "120", "1400")}
        assert len(compare_positions(folded, stored)) == 1

    def test_a_position_missing_from_the_tables_is_a_mismatch(self):
        folded = {self.key(): self.position(-75, "120")}
        assert len(compare_positions(folded, {})) == 1

    def test_flat_on_one_side_and_absent_on_the_other_is_not_a_mismatch(self):
        """Both mean the same thing: no risk in that instrument."""
        folded = {self.key(): self.position(0, "0")}
        assert compare_positions(folded, {}) == []
        assert compare_positions({}, folded) == []

    def test_a_mismatch_says_what_each_side_believes(self):
        folded = {self.key(): self.position(-75, "120")}
        stored = {self.key(): self.position(-50, "120")}
        message = str(compare_positions(folded, stored)[0])
        assert "journal says" in message
        assert "tables say" in message


class TestEmpty:
    def test_an_empty_journal_folds_to_nothing(self):
        state = fold([], BASES)
        assert state == FoldedState()
        assert state.last_sequence == 0

    def test_a_reconciliation_mismatch_event_changes_no_state(self):
        event = JournalEvent(
            event_type=EventType.RECONCILIATION_MISMATCH,
            aggregate_type=AggregateType.SYSTEM,
            aggregate_id="SYSTEM",
            occurred_at=T0,
            trading_day=DAY,
            actor=Actor.ENGINE,
            payload={"detail": "recorded for the audit trail"},
        ).with_sequence(1)
        state = fold([event], BASES)
        assert state.orders == {}
        assert state.positions == {}
        assert not state.halted
