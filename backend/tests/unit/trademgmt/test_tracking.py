"""Advancing a trade as its orders move.

What an update means depends on which order it belongs to: filled on the entry
opened a position, filled on the stop closed it at a loss.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from garuda.alerts.manager import AlertManager
from garuda.core.clock import ReplayClock
from garuda.domain import Direction, OrderStatus, ProductType
from garuda.domain.intent import LegRole
from garuda.domain.order import BrokerOrderId, ClientOrderId, Side
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_signal import EntryRules
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.account import OrderUpdate
from garuda.protocols.broker import BrokerOrder
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.tracking import (
    TrackOutcome,
    TradeTracker,
    update_from_broker_order,
)
from tests.support import next_published
from tests.unit.trademgmt.conftest import (
    CALL,
    CLIENT,
    FAR_CALL,
    LABEL,
    TODAY,
    a_signal,
    a_trade,
    hedge_of,
    rupees,
)

ENTRY_ORDER = BrokerOrderId("260831000001")
STOP_ORDER = BrokerOrderId("260831000002")
TARGET_ORDER = BrokerOrderId("260831000003")


class FakeCanceller:
    def __init__(self) -> None:
        self.cancelled: list[BrokerOrderId] = []
        self.fail_with: Exception | None = None

    async def cancel(self, order_id: BrokerOrderId) -> None:
        self.cancelled.append(order_id)
        if self.fail_with is not None:
            raise self.fail_with


def build(
    instruments: InstrumentLookup, alerts: AlertManager, canceller: FakeCanceller
) -> tuple[TradeTracker, TradingClientManager]:
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    return TradeTracker(book, canceller.cancel, ReplayClock(TODAY), alerts), book


def an_update(
    order_id: BrokerOrderId,
    *,
    filled: int = 0,
    quantity: int = 75,
    status: OrderStatus | None = OrderStatus.NEW,
    price: str | None = "120",
    message: str | None = None,
) -> OrderUpdate:
    return OrderUpdate(
        broker_order_id=order_id,
        broker_client_id="AB1234",
        client_order_id=ClientOrderId("gar-1"),
        instrument=CALL,
        side=Side.SELL,
        quantity=quantity,
        filled_quantity=filled,
        status=status,
        average_price=rupees(price) if price else None,
        message=message,
        at=TODAY,
    )


def placed(book: TradingClientManager, trade: Trade | None = None) -> Trade:
    trade = trade or a_trade()
    book.add_trade(trade)
    book.link_order(ENTRY_ORDER, trade.id, OrderRole.ENTRY)
    return trade


class TestTheEntryOrder:
    async def test_a_fill_opens_the_position(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)

        result = await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        assert result is not None
        assert result.outcome is TrackOutcome.ENTERED
        assert result.trade.state is TradeState.ACTIVE
        assert result.trade.entry == rupees("120")

    async def test_a_partial_fill_opens_it_too(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)

        result = await tracker.on_order_update(an_update(ENTRY_ORDER, filled=25))
        assert result is not None
        assert result.trade.state is TradeState.ACTIVE
        assert result.trade.filled_quantity == 25

    async def test_only_the_increment_is_applied(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The broker counts cumulatively; the trade accumulates."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book, a_trade(quantity=100))

        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=40, quantity=100))
        result = await tracker.on_order_update(an_update(ENTRY_ORDER, filled=100, quantity=100))
        assert result is not None
        assert result.trade.filled_quantity == 100

    async def test_a_fill_without_a_price_is_not_applied(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A quantity with no price puts a zero into the average, and a wrong
        average is a wrong P&L on every report after it."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)

        result = await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price=None))
        assert result is not None
        assert result.outcome is TrackOutcome.UNCHANGED
        assert result.trade.state is TradeState.OPEN

    async def test_a_rejected_entry_cancels_the_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)

        result = await tracker.on_order_update(
            an_update(ENTRY_ORDER, status=OrderStatus.REJECTED, message="insufficient margin")
        )
        assert result is not None
        assert result.outcome is TrackOutcome.ENTRY_FAILED
        assert result.trade.state is TradeState.CANCELLED
        assert "margin" in (result.trade.failure_reason or "")

    async def test_a_partly_filled_entry_that_is_cancelled_keeps_its_position(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """What filled is a real position, whatever happened to the remainder."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book, a_trade(quantity=100))
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=40, quantity=100))

        result = await tracker.on_order_update(
            an_update(ENTRY_ORDER, filled=40, quantity=100, status=OrderStatus.CANCELLED)
        )
        assert result is not None
        assert result.trade.state is TradeState.ACTIVE
        assert result.trade.filled_quantity == 40

    async def test_a_rejected_entry_withdraws_its_protective_orders(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        trade = placed(book)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await tracker.on_order_update(an_update(ENTRY_ORDER, status=OrderStatus.REJECTED))
        assert STOP_ORDER in canceller.cancelled
        assert ENTRY_ORDER not in canceller.cancelled

    async def test_a_rejected_entry_orphans_its_hedge(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        hedge = a_trade(
            "t-hedge",
            instrument=FAR_CALL,
            direction=Direction.LONG,
            relationships=hedge_of("h-1", role=LegRole.HEDGE),
            signal_id="sig-h",
        ).with_entry_fill(75, rupees("5"), TODAY)
        book.add_trade(hedge)

        main = a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN))
        placed(book, main)
        await tracker.on_order_update(an_update(ENTRY_ORDER, status=OrderStatus.REJECTED))

        stored = book.trade(TradeId("t-hedge"))
        assert stored is not None
        assert stored.relationships.main_entry_failed


class TestTheWayOut:
    async def test_a_stop_filling_closes_the_position_at_a_loss(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        result = await tracker.on_order_update(
            an_update(STOP_ORDER, filled=75, price="150", status=OrderStatus.FILLED)
        )
        assert result is not None
        assert result.outcome is TrackOutcome.EXITED
        assert result.trade.exit_reason is TradeExitReason.STOP_LOSS
        assert result.trade.exit == rupees("150")

    async def test_a_target_filling_closes_it_at_a_profit(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The same status on a different order means the opposite thing."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(TARGET_ORDER, trade.id, OrderRole.TARGET)

        result = await tracker.on_order_update(
            an_update(TARGET_ORDER, filled=75, price="90", status=OrderStatus.FILLED)
        )
        assert result is not None
        assert result.trade.exit_reason is TradeExitReason.TARGET

    async def test_the_other_way_out_is_withdrawn(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A stop left live after the target filled is a naked position in the
        opposite direction the moment it triggers."""
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        book.link_order(TARGET_ORDER, trade.id, OrderRole.TARGET)

        await tracker.on_order_update(
            an_update(TARGET_ORDER, filled=75, price="90", status=OrderStatus.FILLED)
        )
        assert canceller.cancelled == [STOP_ORDER]

    async def test_a_superseded_stop_is_withdrawn_too(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A trailing stop leaves one behind every time it moves, and it may
        still be live until its cancel confirms."""
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        moved_stop = BrokerOrderId("260831000009")
        book.link_order(moved_stop, trade.id, OrderRole.STOP)
        book.link_order(TARGET_ORDER, trade.id, OrderRole.TARGET)

        await tracker.on_order_update(
            an_update(TARGET_ORDER, filled=75, price="90", status=OrderStatus.FILLED)
        )
        assert set(canceller.cancelled) == {moved_stop, STOP_ORDER}

    async def test_a_square_off_keeps_its_own_reason(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """An operator who asked for a manual exit should see that, not
        "target", merely because the exit routed through the target order."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        exiting = (book.trade(trade.id) or trade).exiting(TradeExitReason.MANUAL_SQUARE_OFF)
        book.replace_trade(exiting)
        book.link_order(TARGET_ORDER, trade.id, OrderRole.TARGET)

        result = await tracker.on_order_update(
            an_update(TARGET_ORDER, filled=75, price="90", status=OrderStatus.FILLED)
        )
        assert result is not None
        assert result.trade.exit_reason is TradeExitReason.MANUAL_SQUARE_OFF

    async def test_a_rejected_stop_says_the_position_is_unprotected(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        from garuda.domain.alert import AlertLevel
        from garuda.protocols.topics import Topic

        tracker, book = build(instruments, alerts, FakeCanceller())
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        seen = alerts.bus.subscribe(Topic.ALERTS, name="test")

        await tracker.on_order_update(
            an_update(STOP_ORDER, status=OrderStatus.REJECTED, message="price band")
        )
        alert = await next_published(seen)
        assert alert.level is AlertLevel.CRITICAL  # type: ignore[attr-defined]
        assert "UNPROTECTED" in alert.message  # type: ignore[attr-defined]

    async def test_a_cancel_that_fails_does_not_stop_the_cleanup(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        canceller = FakeCanceller()
        canceller.fail_with = RuntimeError("the broker refused")
        tracker, book = build(instruments, alerts, canceller)
        trade = placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        book.link_order(TARGET_ORDER, trade.id, OrderRole.TARGET)

        result = await tracker.on_order_update(
            an_update(TARGET_ORDER, filled=75, price="90", status=OrderStatus.FILLED)
        )
        assert result is not None
        assert result.outcome is TrackOutcome.EXITED, "the exit is recorded regardless"


class TestOrdersThatAreNotOurs:
    async def test_an_unknown_order_is_ignored(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A manual order in the same account is not the engine's to track."""
        tracker, _ = build(instruments, alerts, FakeCanceller())
        assert await tracker.on_order_update(an_update(BrokerOrderId("999"))) is None

    async def test_a_finished_trade_ignores_further_updates(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)
        await tracker.on_order_update(an_update(ENTRY_ORDER, status=OrderStatus.REJECTED))

        result = await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="120"))
        assert result is not None
        assert result.outcome is TrackOutcome.UNCHANGED


class TestThePollIsTheSameFold:
    def test_a_polled_row_becomes_the_update_the_stream_would_send(self) -> None:
        """Both reach the trade through one set of rules, which is what makes
        the poll a backstop rather than a second implementation."""
        row = BrokerOrder(
            broker_order_id=ENTRY_ORDER,
            client_order_id=ClientOrderId("gar-1"),
            instrument=CALL,
            side=Side.SELL,
            quantity=75,
            filled_quantity=75,
            status=OrderStatus.FILLED,
            product=ProductType.NRML,
            average_price=rupees("120"),
        )
        update = update_from_broker_order(row)
        assert update.broker_order_id == ENTRY_ORDER
        assert update.filled_quantity == 75
        assert update.status is OrderStatus.FILLED
        assert update.average_price == rupees("120")

    async def test_a_fill_seen_only_by_the_poll_still_opens_the_position(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The stream dropped the frame; the poll is what catches it."""
        tracker, book = build(instruments, alerts, FakeCanceller())
        placed(book)
        row = BrokerOrder(
            broker_order_id=ENTRY_ORDER,
            client_order_id=ClientOrderId("gar-1"),
            instrument=CALL,
            side=Side.SELL,
            quantity=75,
            filled_quantity=75,
            status=OrderStatus.FILLED,
            product=ProductType.NRML,
            average_price=rupees("120"),
        )
        result = await tracker.on_order_update(update_from_broker_order(row))
        assert result is not None
        assert result.trade.state is TradeState.ACTIVE


class TestUnfilledEntries:
    async def test_an_entry_past_its_cut_off_is_withdrawn(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A limit resting all day is an entry at a price the strategy no
        longer believes in."""
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        cutoff = TODAY + timedelta(minutes=5)
        await book.add_signal(
            replace(
                a_signal(),
                entry=EntryRules(trigger=rupees("120"), cancel_unfilled_order_at=cutoff),
            )
        )
        placed(book)

        results = await tracker.cancel_stale_entries(cutoff + timedelta(minutes=1))
        assert [r.outcome for r in results] == [TrackOutcome.ENTRY_FAILED]
        assert ENTRY_ORDER in canceller.cancelled

    async def test_before_the_cut_off_it_is_left_alone(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        cutoff = TODAY + timedelta(minutes=5)
        await book.add_signal(
            replace(
                a_signal(),
                entry=EntryRules(trigger=rupees("120"), cancel_unfilled_order_at=cutoff),
            )
        )
        placed(book)

        assert await tracker.cancel_stale_entries(TODAY) == []
        assert canceller.cancelled == []

    async def test_a_partly_filled_entry_is_never_withdrawn(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        cutoff = TODAY + timedelta(minutes=5)
        await book.add_signal(
            replace(
                a_signal(),
                entry=EntryRules(trigger=rupees("120"), cancel_unfilled_order_at=cutoff),
            )
        )
        placed(book, a_trade(quantity=100))
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=40, quantity=100))

        assert await tracker.cancel_stale_entries(cutoff + timedelta(minutes=1)) == []

    async def test_a_signal_with_no_cut_off_rests_indefinitely(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        canceller = FakeCanceller()
        tracker, book = build(instruments, alerts, canceller)
        await book.add_signal(a_signal())
        placed(book)

        assert await tracker.cancel_stale_entries(TODAY + timedelta(hours=6)) == []
