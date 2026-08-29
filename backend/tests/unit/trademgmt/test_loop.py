"""The cycle that keeps one account's trades moving."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta
from decimal import Decimal

from garuda.alerts.manager import AlertManager
from garuda.core.clock import ReplayClock
from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain import OrderStatus, ProductType
from garuda.domain.alert import AlertLevel
from garuda.domain.exchange import Exchange
from garuda.domain.market import PriceBand, Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.phases import DayPhase
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.broker import BrokerOrder
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.coordination import LegCoordinator
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.loop import CycleReport, TradeLoop, TradeLoops
from garuda.trademgmt.protective import ProtectiveOrderService
from garuda.trademgmt.squareoff import SquareOffService
from garuda.trademgmt.squareoff_rules import ExitWindow
from garuda.trademgmt.tasks import register_trade_loops
from garuda.trademgmt.tracking import TradeTracker
from tests.unit.trademgmt.conftest import CALL, CLIENT, LABEL, TODAY, a_trade, rupees

ENTRY_ORDER = BrokerOrderId("260831000001")
LATE = TODAY + timedelta(hours=4)
WIDE_BAND = PriceBand(lower=rupees("0.05"), upper=rupees("5000"))


class FakeBroker:
    def __init__(self) -> None:
        self.book: list[BrokerOrder] = []
        self.placed: list[OrderRequest] = []
        self.cancelled: list[BrokerOrderId] = []
        self.fetch_fails: Exception | None = None
        self.fetches = 0
        self._next = 50

    async def fetch(self) -> list[BrokerOrder]:
        self.fetches += 1
        if self.fetch_fails is not None:
            raise self.fetch_fails
        return self.book

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.placed.append(request)
        order_id = BrokerOrderId(f"2608310000{self._next}")
        self._next += 1
        return order_id

    async def cancel(self, order_id: BrokerOrderId) -> None:
        self.cancelled.append(order_id)


def a_row(filled: int, status: OrderStatus, price: str = "120") -> BrokerOrder:
    return BrokerOrder(
        broker_order_id=ENTRY_ORDER,
        client_order_id=ClientOrderId("gar-1"),
        instrument=CALL,
        side=Side.SELL,
        quantity=75,
        filled_quantity=filled,
        status=status,
        product=ProductType.NRML,
        average_price=rupees(price),
    )


def build(
    instruments: InstrumentLookup,
    alerts: AlertManager,
    broker: FakeBroker,
    *,
    clock: ReplayClock | None = None,
    cutoff: datetime | None = None,
) -> tuple[TradeLoop, TradingClientManager, SquareOffService]:
    the_clock = clock or ReplayClock(TODAY)
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    tracker = TradeTracker(book, broker.cancel, the_clock, alerts)
    protection = ProtectiveOrderService(
        book,
        broker.place,
        instruments,
        lambda i: Tick(CALL, rupees("120"), TODAY),
        lambda i: WIDE_BAND,
        lambda t: Decimal(18),
        the_clock,
        alerts,
        replacement_interval=timedelta(0),
    )
    square_off = SquareOffService(
        book,
        protection,
        broker.cancel,
        instruments,
        lambda i: None,
        lambda t: ExitWindow(market_close=TODAY + timedelta(hours=12)),
        lambda t: False,
        the_clock,
        alerts,
        recheck=timedelta(0),
    )
    coordinator = LegCoordinator(book, square_off.request, alerts)
    loop = TradeLoop(
        book,
        tracker,
        coordinator,
        square_off,
        broker.fetch,
        lambda t: cutoff,
        the_clock,
        alerts,
        interval=timedelta(0),
    )
    return loop, book, square_off


def placed(book: TradingClientManager, trade: Trade | None = None) -> Trade:
    trade = trade or a_trade()
    book.add_trade(trade)
    book.link_order(ENTRY_ORDER, trade.id, OrderRole.ENTRY)
    return trade


class TestThePoll:
    async def test_a_fill_only_the_poll_saw_advances_the_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The backstop: the stream dropped the frame, the cycle catches it."""
        broker = FakeBroker()
        loop, book, _ = build(instruments, alerts, broker)
        trade = placed(book)
        broker.book = [a_row(75, OrderStatus.FILLED)]

        report = await loop.run_once()
        assert report.orders_seen == 1
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.state is TradeState.ACTIVE

    async def test_an_order_belonging_to_nothing_is_ignored(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        loop, _book, _ = build(instruments, alerts, broker)
        broker.book = [a_row(75, OrderStatus.FILLED)]

        report = await loop.run_once()
        assert report.orders_seen == 1
        assert report.trades_advanced == 0


class TestExitingOnTime:
    def active(self, book: TradingClientManager, **changes: object) -> Trade:
        trade = replace(a_trade(), protection=Protection(stop_loss=rupees("150")), **changes)  # type: ignore[arg-type]
        trade = trade.with_entry_fill(75, rupees("120"), TODAY)
        book.add_trade(trade)
        return trade

    async def test_a_strategys_own_exit_time_is_honoured(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        loop, book, _square_off = build(instruments, alerts, broker, clock=clock)
        self.active(book, square_off_at=TODAY + timedelta(hours=1))

        assert (await loop.run_once()).exits_requested == 0

        await clock.advance_to(TODAY + timedelta(hours=2))
        assert (await loop.run_once()).exits_requested == 1

    async def test_the_venue_cut_off_applies_to_intraday(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=3)
        )
        self.active(book, product=ProductType.MIS)

        assert (await loop.run_once()).exits_requested == 1

    async def test_a_carry_forward_position_ignores_the_intraday_cut_off(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The venue only forces intraday products out."""
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=3)
        )
        self.active(book, product=ProductType.NRML)

        assert (await loop.run_once()).exits_requested == 0

    async def test_the_earlier_deadline_wins(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Past the venue's cut-off the broker starts closing positions itself,
        so holding out for a later time gets neither the price nor the moment."""
        clock = ReplayClock(TODAY + timedelta(hours=2))
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=1)
        )
        self.active(book, product=ProductType.MIS, square_off_at=TODAY + timedelta(hours=6))

        assert (await loop.run_once()).exits_requested == 1

    async def test_an_exempt_position_is_left_alone(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=1)
        )
        self.active(book, product=ProductType.MIS, no_square_off=True)

        assert (await loop.run_once()).exits_requested == 0

    async def test_a_position_already_exiting_is_not_asked_twice(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=1)
        )
        trade = self.active(book, product=ProductType.MIS)
        book.replace_trade(trade.exiting(TradeExitReason.MANUAL_SQUARE_OFF))

        assert (await loop.run_once()).exits_requested == 0

    async def test_an_unfilled_order_has_no_position_to_exit(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        loop, book, _ = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=1)
        )
        book.add_trade(replace(a_trade(), product=ProductType.MIS))

        assert (await loop.run_once()).exits_requested == 0


class TestOneStepFailingDoesNotStopTheRest:
    async def test_a_failed_poll_still_lets_the_queue_run(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The queue is what gets positions out, and it is least excusable for
        it to stop because something unrelated broke."""
        clock = ReplayClock(LATE)
        broker = FakeBroker()
        broker.fetch_fails = RuntimeError("the broker is down")
        loop, book, _square_off = build(
            instruments, alerts, broker, clock=clock, cutoff=TODAY + timedelta(hours=1)
        )
        trade = replace(a_trade(), product=ProductType.MIS, protection=Protection())
        book.add_trade(trade.with_entry_fill(75, rupees("120"), TODAY))

        report = await loop.run_once()
        assert report.failures, "the poll failed"
        assert report.exits_requested == 1, "and the exit still happened"

    async def test_a_failed_step_is_reported_to_the_operator(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        broker.fetch_fails = RuntimeError("the broker is down")
        loop, _, _ = build(instruments, alerts, broker)

        await loop.run_once()
        raised = alerts.open_alerts(TODAY.date())
        assert any(a.level is AlertLevel.CRITICAL for a in raised)

    async def test_the_cycle_reports_what_it_did(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        loop, book, _ = build(instruments, alerts, broker)
        placed(book)
        broker.book = [a_row(75, OrderStatus.FILLED)]

        report = await loop.run_once()
        assert isinstance(report, CycleReport)
        assert report.did_anything


class TestAcrossAccounts:
    async def test_each_account_gets_its_own_cycle(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        loop, _, _ = build(instruments, alerts, broker)
        loops = TradeLoops(ReplayClock(TODAY), alerts)
        loops.add(loop)

        await loops.start()
        try:
            assert loops.running == frozenset({str(CLIENT)})
        finally:
            await loops.stop()
        assert loops.running == frozenset()

    async def test_an_account_that_cannot_settle_still_starts_trading(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """One account failing to reconcile must not stop the others."""
        broker = FakeBroker()
        broker.fetch_fails = RuntimeError("the broker is down")
        loop, _, _ = build(instruments, alerts, broker)
        loops = TradeLoops(ReplayClock(TODAY), alerts)
        loops.add(loop)

        await loops.start()
        try:
            assert loops.running == frozenset({str(CLIENT)})
        finally:
            await loops.stop()


def _context(exchange: Exchange, phase: DayPhase, now: datetime) -> PhaseContext:
    return PhaseContext(
        exchange=exchange,
        trading_day=now.astimezone(exchange.timezone).date(),
        phase=phase,
        now=now,
    )


class TestWhenSettlingItselfFails:
    async def test_an_account_whose_pre_open_raises_still_starts(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The cycle guards each of its own steps, so this is the outer belt:
        anything that escapes anyway must not leave an account with open
        positions and nothing tending them."""
        broker = FakeBroker()
        loop, _book, _ = build(instruments, alerts, broker)

        async def explode() -> CycleReport:
            raise RuntimeError("something outside a guarded step")

        loop.pre_open = explode  # type: ignore[method-assign]
        loops = TradeLoops(ReplayClock(TODAY), alerts)
        loops.add(loop)

        await loops.start()
        try:
            assert loops.running == frozenset({str(CLIENT)})
            raised = alerts.open_alerts(TODAY.date())
            assert any(a.level is AlertLevel.CRITICAL for a in raised)
        finally:
            await loops.stop()


class TestTheTradingDay:
    async def test_it_starts_once_a_day_not_once_a_venue(
        self, instruments: InstrumentLookup, alerts: AlertManager, nse: Exchange, mcx: Exchange
    ) -> None:
        """The engine walks each venue through its whole day in turn, so the
        second venue's pre-open arrives after the first has started the cycles.
        Starting again would reconcile accounts that are already trading."""
        broker = FakeBroker()
        loop, book, _ = build(instruments, alerts, broker)
        placed(book)
        broker.book = [a_row(75, OrderStatus.FILLED)]
        loops = TradeLoops(ReplayClock(TODAY), alerts)
        loops.add(loop)

        registry = TaskRegistry()
        register_trade_loops(registry, loops, [nse, mcx])
        starts = registry.tasks_for(DayPhase.PRE_OPEN, nse.code)
        assert starts, "the start task is registered"

        try:
            for exchange in (nse, mcx):
                for _, task in registry.tasks_for(DayPhase.PRE_OPEN, exchange.code):
                    await task(_context(exchange, DayPhase.PRE_OPEN, TODAY))

            assert len(loops.running) == 1
            # One reconciliation pass, not two. The second venue found the
            # cycles already running and did not re-read the broker.
            assert broker.fetches == 1
        finally:
            await loops.stop()

    async def test_equities_closing_does_not_stop_commodity_trading(
        self, instruments: InstrumentLookup, alerts: AlertManager, nse: Exchange, mcx: Exchange
    ) -> None:
        """One account holds positions across venues."""
        broker = FakeBroker()
        loop, _, _ = build(instruments, alerts, broker)
        loops = TradeLoops(ReplayClock(TODAY), alerts)
        loops.add(loop)
        await loops.start()

        registry = TaskRegistry()
        register_trade_loops(registry, loops, [nse, mcx])
        after_equities = datetime(2026, 8, 31, 10, 30, tzinfo=TODAY.tzinfo)
        assert not nse.is_open(after_equities)
        assert mcx.is_open(after_equities)

        try:
            for _, task in registry.tasks_for(DayPhase.SESSION_CLOSE, nse.code):
                await task(_context(nse, DayPhase.SESSION_CLOSE, after_equities))
            assert loops.running, "commodities are still trading"
        finally:
            await loops.stop()
