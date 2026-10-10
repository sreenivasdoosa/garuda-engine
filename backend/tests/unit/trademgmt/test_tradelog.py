"""The trade log, as the services write it.

Behavioural: each service is driven through its real path -- a signal
placed, an order update folded in, a stop moved, an exit queued -- and the
claims are about what reached the sink: which event, in which category,
carrying the order and the levels the operator will read on the timeline.
And that a sink that fails costs the timeline and never the trade.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

from garuda.alerts.manager import AlertManager
from garuda.core.clock import ReplayClock
from garuda.domain import Direction, OrderStatus, OrderType
from garuda.domain.market import PriceBand, Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_log import (
    TERMINAL_EVENTS,
    TradeLogEntry,
    TradeLogEventCategory,
    TradeLogEventType,
)
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason
from garuda.domain.trailing import TrailConfig
from garuda.protocols.account import OrderUpdate
from garuda.protocols.broker import OrderRejectedError
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.entry import EntryService
from garuda.trademgmt.protective import ProtectiveOrderService
from garuda.trademgmt.squareoff import SquareOffService
from garuda.trademgmt.squareoff_rules import ExitWindow
from garuda.trademgmt.tracking import TradeTracker
from garuda.trademgmt.tradelog import TradeLogger
from garuda.trademgmt.trailing import TrailingService
from tests.unit.trademgmt.conftest import CALL, CLIENT, LABEL, TODAY, a_signal, a_trade, rupees

ENTRY_ORDER = BrokerOrderId("260831000001")
STOP_ORDER = BrokerOrderId("260831000002")
WINDOW = ExitWindow(
    market_close=TODAY + timedelta(hours=6), intraday_block=TODAY + timedelta(hours=5)
)
WIDE_BAND = PriceBand(lower=rupees("1"), upper=rupees("5000"))


class Recorded:
    """The sink: keeps every entry, or refuses them all."""

    def __init__(self, *, failing: bool = False) -> None:
        self.entries: list[TradeLogEntry] = []
        self.failing = failing

    async def write(self, entry: TradeLogEntry) -> None:
        if self.failing:
            raise RuntimeError("the database is away")
        self.entries.append(entry)

    def types(self) -> list[TradeLogEventType]:
        return [e.event_type for e in self.entries]

    def only(self, event: TradeLogEventType) -> TradeLogEntry:
        matching = [e for e in self.entries if e.event_type is event]
        assert len(matching) == 1, f"expected one {event}, got {self.types()}"
        return matching[0]


class FakeBroker:
    def __init__(self) -> None:
        self.placed: list[OrderRequest] = []
        self.cancelled: list[BrokerOrderId] = []
        self.modified: list[BrokerOrderId] = []
        self.fail_with: Exception | None = None
        self._next = 1

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.placed.append(request)
        if self.fail_with is not None:
            raise self.fail_with
        order_id = BrokerOrderId(f"2608310000{self._next:02d}")
        self._next += 1
        return order_id

    async def find(self, client_order_id: ClientOrderId) -> BrokerOrderId | None:
        return None

    async def cancel(self, order_id: BrokerOrderId) -> None:
        self.cancelled.append(order_id)

    async def modify(self, order_id: BrokerOrderId, changes: object) -> None:
        self.modified.append(order_id)


def a_logger(
    sink: Recorded, instruments: InstrumentLookup, clock: ReplayClock | None = None
) -> TradeLogger:
    return TradeLogger(sink, instruments, clock or ReplayClock(TODAY), label=LABEL)


def an_update(
    order_id: BrokerOrderId,
    *,
    filled: int = 0,
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
        quantity=75,
        filled_quantity=filled,
        status=status,
        average_price=rupees(price) if price else None,
        message=message,
        at=TODAY,
    )


def open_position(*, stop: str = "150", target: str | None = "80") -> Trade:
    trade = replace(
        a_trade(),
        protection=Protection(stop_loss=rupees(stop), target=rupees(target) if target else None),
    )
    return trade.with_entry_fill(75, rupees("120"), TODAY)


# -- the entry ----------------------------------------------------------------


class TestTheEntry:
    def _service(
        self,
        instruments: InstrumentLookup,
        alerts: AlertManager,
        broker: FakeBroker,
        sink: Recorded,
    ) -> tuple[EntryService, TradingClientManager]:
        book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
        service = EntryService(
            book,
            broker.place,
            broker.find,
            instruments,
            ReplayClock(TODAY),
            alerts,
            max_attempts=1,
            log=a_logger(sink, instruments),
        )
        return service, book

    async def test_a_placed_entry_is_logged_with_its_order(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        service, book = self._service(instruments, alerts, FakeBroker(), sink)
        await book.add_signal(a_signal())

        result = await service.consider(a_signal(), Tick(CALL, rupees("120"), TODAY))

        entry = sink.only(TradeLogEventType.ENTRY_ORDER_PLACED)
        assert result.trade is not None
        assert entry.trade_id == result.trade.id.value
        assert entry.category is TradeLogEventCategory.ENTRY
        assert entry.trading_client == CLIENT
        assert entry.strategy == "straddle"
        assert entry.trading_symbol == "NIFTY26AUG25000CE", "the master's name, not the id"
        assert entry.order_id == "260831000001"
        assert entry.order_type == str(OrderType.LIMIT)
        assert entry.quantity == 75
        assert entry.price == Decimal("120")
        assert "260831000001" in entry.message

    async def test_an_entry_the_broker_refused_is_logged_as_failed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("margin")
        service, book = self._service(instruments, alerts, broker, sink)
        await book.add_signal(a_signal())

        await service.consider(a_signal(), Tick(CALL, rupees("120"), TODAY))

        entry = sink.only(TradeLogEventType.ENTRY_FAILED)
        assert entry.error_message == "margin"
        assert entry.event_type in TERMINAL_EVENTS, "a failed entry ends the timeline"
        assert TradeLogEventType.ENTRY_ORDER_PLACED not in sink.types()

    async def test_a_sink_that_fails_does_not_fail_the_entry(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The record is an account of the trade, not part of it."""
        broker = FakeBroker()
        service, book = self._service(instruments, alerts, broker, Recorded(failing=True))
        await book.add_signal(a_signal())

        result = await service.consider(a_signal(), Tick(CALL, rupees("120"), TODAY))

        assert result.trade is not None
        assert len(broker.placed) == 1
        assert book.trade(result.trade.id) is not None


# -- the tracker --------------------------------------------------------------


class TestTheTracker:
    def _tracker(
        self, instruments: InstrumentLookup, alerts: AlertManager, sink: Recorded
    ) -> tuple[TradeTracker, TradingClientManager]:
        book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
        broker = FakeBroker()
        tracker = TradeTracker(
            book, broker.cancel, ReplayClock(TODAY), alerts, log=a_logger(sink, instruments)
        )
        return tracker, book

    async def test_a_partial_fill_and_the_last_fill_are_told_apart(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        tracker, book = self._tracker(instruments, alerts, sink)
        trade = a_trade()
        book.add_trade(trade)
        book.link_order(ENTRY_ORDER, trade.id, OrderRole.ENTRY)

        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=25, price="120"))
        await tracker.on_order_update(an_update(ENTRY_ORDER, filled=75, price="122"))

        partial = sink.only(TradeLogEventType.ENTRY_PARTIAL_FILL)
        assert partial.filled_quantity == 25
        assert "25/75" in partial.message
        filled = sink.only(TradeLogEventType.ENTRY_FILLED)
        assert filled.filled_quantity == 75
        assert filled.order_status == str(OrderStatus.NEW)
        assert filled.price == Decimal("122"), "the broker's average, as it reported it"

    async def test_a_rejected_entry_carries_the_brokers_reason(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        tracker, book = self._tracker(instruments, alerts, sink)
        trade = a_trade()
        book.add_trade(trade)
        book.link_order(ENTRY_ORDER, trade.id, OrderRole.ENTRY)

        await tracker.on_order_update(
            an_update(ENTRY_ORDER, status=OrderStatus.REJECTED, price=None, message="RMS block")
        )

        entry = sink.only(TradeLogEventType.ENTRY_REJECTED)
        assert entry.error_message == "RMS block"
        assert entry.order_id == ENTRY_ORDER.value
        assert entry.order_status == str(OrderStatus.REJECTED)

    async def test_an_exit_fill_completes_the_timeline_with_the_reason(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        tracker, book = self._tracker(instruments, alerts, sink)
        trade = open_position()
        book.add_trade(trade)
        book.link_order(ENTRY_ORDER, trade.id, OrderRole.ENTRY)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await tracker.on_order_update(an_update(STOP_ORDER, filled=75, price="150"))

        entry = sink.only(TradeLogEventType.TRADE_COMPLETED)
        assert entry.category is TradeLogEventCategory.EXIT
        assert str(TradeExitReason.STOP_LOSS) in entry.message
        assert "entry=120" in entry.message
        assert "exit=150" in entry.message
        assert "pnl=-2250" in entry.message, "short 75 at 120, out at 150"

    async def test_a_rejected_stop_is_logged_against_the_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        tracker, book = self._tracker(instruments, alerts, sink)
        trade = open_position()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await tracker.on_order_update(
            an_update(STOP_ORDER, status=OrderStatus.REJECTED, price=None, message="no margin")
        )

        entry = sink.only(TradeLogEventType.SL_REJECTED)
        assert entry.category is TradeLogEventCategory.SL
        assert entry.error_message == "no margin"
        assert entry.order_id == STOP_ORDER.value


# -- the protective orders ----------------------------------------------------


class TestTheProtectiveOrders:
    def _service(
        self,
        instruments: InstrumentLookup,
        alerts: AlertManager,
        broker: FakeBroker,
        sink: Recorded,
    ) -> tuple[ProtectiveOrderService, TradingClientManager]:
        book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
        service = ProtectiveOrderService(
            book,
            broker.place,
            instruments,
            lambda instrument: Tick(CALL, rupees("120"), TODAY),
            lambda instrument: WIDE_BAND,
            lambda trade: Decimal(18),
            ReplayClock(TODAY),
            alerts,
            replacement_interval=timedelta(0),
            log=a_logger(sink, instruments),
        )
        return service, book

    async def test_a_stop_is_logged_at_its_level(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        service, book = self._service(instruments, alerts, FakeBroker(), sink)
        trade = open_position(stop="150")
        book.add_trade(trade)

        await service.place_stop(trade)

        entry = sink.only(TradeLogEventType.SL_ORDER_PLACED)
        assert entry.sl_price == Decimal("150")
        assert "150" in entry.message
        assert entry.order_id == "260831000001"
        assert entry.order_type == str(OrderType.SL_LIMIT)

    async def test_a_stop_the_broker_refused_is_logged_as_rejected(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("too far")
        service, book = self._service(instruments, alerts, broker, sink)
        trade = open_position()
        book.add_trade(trade)

        await service.place_stop(trade)

        assert sink.only(TradeLogEventType.SL_REJECTED).error_message == "too far"

    async def test_the_same_order_is_a_target_while_held_and_an_exit_when_leaving(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The reference's own split, by whether a square-off is under way."""
        sink = Recorded()
        service, book = self._service(instruments, alerts, FakeBroker(), sink)
        held = open_position(target="80")
        book.add_trade(held)
        await service.place_target(held)

        leaving = held.exiting(TradeExitReason.SQUARE_OFF)
        book.replace_trade(leaving)
        await service.place_target(leaving, at_market=True)

        target = sink.only(TradeLogEventType.TARGET_ORDER_PLACED)
        assert target.target_price == Decimal("80")
        exit_order = sink.only(TradeLogEventType.EXIT_ORDER_PLACED)
        assert exit_order.order_type == str(OrderType.MARKET)
        assert exit_order.category is TradeLogEventCategory.EXIT

    async def test_a_refused_exit_is_logged_as_an_exit_failure(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("closed")
        service, book = self._service(instruments, alerts, broker, sink)
        leaving = open_position().exiting(TradeExitReason.SQUARE_OFF)
        book.add_trade(leaving)

        await service.place_target(leaving, at_market=True)

        assert sink.only(TradeLogEventType.EXIT_FAILED).error_message == "closed"
        assert TradeLogEventType.TARGET_ORDER_REJECTED not in sink.types()


# -- trailing -----------------------------------------------------------------


class TestTrailing:
    async def test_a_moved_stop_is_logged_with_both_levels(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        broker = FakeBroker()
        book = TradingClientManager(CLIENT, LABEL, instruments, alerts)

        async def place_stop(trade: Trade) -> BrokerOrderId | None:
            return None

        service = TrailingService(
            book,
            broker.modify,
            broker.cancel,
            place_stop,
            instruments,
            alerts,
            ReplayClock(TODAY),
            log=a_logger(sink, instruments),
        )
        trade = replace(
            a_trade(direction=Direction.LONG),
            protection=Protection(
                stop_loss=rupees("90"),
                initial_stop_loss=rupees("90"),
                is_trailing=True,
                trail=TrailConfig(),
            ),
        ).with_entry_fill(75, rupees("100"), TODAY)
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await service.on_tick(trade, Tick(CALL, rupees("110"), TODAY))

        entry = sink.only(TradeLogEventType.SL_TRAIL_UPDATED)
        assert entry.category is TradeLogEventCategory.SL
        assert "from 90 to 100" in entry.message
        assert entry.sl_price == Decimal("100"), "the row carries the new level"
        assert entry.order_id == STOP_ORDER.value


# -- square-off ---------------------------------------------------------------


class TestSquareOff:
    def _service(
        self,
        instruments: InstrumentLookup,
        alerts: AlertManager,
        broker: FakeBroker,
        sink: Recorded,
        *,
        window: ExitWindow = WINDOW,
    ) -> tuple[SquareOffService, TradingClientManager]:
        book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
        clock = ReplayClock(TODAY)
        protection = ProtectiveOrderService(
            book,
            broker.place,
            instruments,
            lambda i: Tick(CALL, rupees("120"), TODAY),
            lambda i: WIDE_BAND,
            lambda t: Decimal(18),
            clock,
            alerts,
            replacement_interval=timedelta(0),
            log=a_logger(sink, instruments, clock),
        )
        service = SquareOffService(
            book,
            protection,
            broker.cancel,
            instruments,
            lambda i: Tick(CALL, rupees("120"), TODAY),
            lambda t: window,
            lambda t: False,
            clock,
            alerts,
            recheck=timedelta(0),
            max_placements=1,
            log=a_logger(sink, instruments, clock),
        )
        return service, book

    async def test_an_exit_is_logged_once_however_often_it_is_asked_for(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Every sweep finds the trade still leaving; the reference logs the first."""
        sink = Recorded()
        service, book = self._service(instruments, alerts, FakeBroker(), sink)
        trade = open_position()
        book.add_trade(trade)

        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.request(trade, TradeExitReason.DAILY_LOSS_BREACH)

        entry = sink.only(TradeLogEventType.EXIT_TRIGGERED)
        assert str(TradeExitReason.SQUARE_OFF) in entry.message

    async def test_giving_up_is_on_the_timeline(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A timeline that stops at "exit triggered" with the position open is
        the one an operator most needs to read."""
        sink = Recorded()
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("closed")
        service, book = self._service(instruments, alerts, broker, sink)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await service.run_once()

        assert sink.only(TradeLogEventType.EXIT_FAILED).error_message == "closed"
        assert TradeLogEventType.EXIT_ORDER_PLACED not in sink.types()

    async def test_a_closed_window_ends_the_timeline_with_why(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        shut = ExitWindow(
            market_close=TODAY - timedelta(minutes=1), intraday_block=TODAY - timedelta(minutes=2)
        )
        service, book = self._service(instruments, alerts, FakeBroker(), sink, window=shut)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await service.run_once()

        entry = sink.only(TradeLogEventType.EXIT_FAILED)
        assert entry.event_type in TERMINAL_EVENTS
        assert "window" in (entry.error_message or "")


# -- what every entry carries -------------------------------------------------


class TestTheRow:
    async def test_a_trade_with_no_master_row_is_named_by_its_symbol(
        self, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        logger = TradeLogger(sink, lambda instrument: None, ReplayClock(TODAY))

        await logger.exit_triggered(a_trade(), TradeExitReason.SQUARE_OFF)

        assert sink.entries[0].trading_symbol == "NIFTY26AUG25000CE"

    async def test_the_moment_is_the_clocks(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        sink = Recorded()
        later = TODAY + timedelta(minutes=7)
        logger = TradeLogger(sink, instruments, ReplayClock(later))

        await logger.entry_failed(a_trade(), "no master")

        assert sink.entries[0].at == later

    def test_every_event_belongs_to_one_category(self) -> None:
        for event in TradeLogEventType:
            assert isinstance(event.category, TradeLogEventCategory)
        assert TradeLogEventType.SL_TRAIL_UPDATED.category is TradeLogEventCategory.SL
        assert TradeLogEventType.TRADE_COMPLETED.category is TradeLogEventCategory.EXIT
        assert TradeLogEventType.GENERIC_ERROR.category is TradeLogEventCategory.ERROR

    async def test_a_hedge_carries_its_correlation(self, instruments: InstrumentLookup) -> None:
        from garuda.domain.intent import LegRole
        from garuda.domain.trade import Relationships

        sink = Recorded()
        logger = TradeLogger(sink, instruments, ReplayClock(TODAY))
        hedge = a_trade(
            relationships=Relationships(hedge_correlation_id="corr-9", leg_role=LegRole.HEDGE)
        )

        await logger.entry_failed(hedge, "no master")

        assert sink.entries[0].hedge_correlation_id == "corr-9"
