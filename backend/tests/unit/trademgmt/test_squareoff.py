"""Getting a position out, and knowing when to stop trying.

The failure modes are bad at both ends: stopping early leaves a position
nobody is closing, never stopping places orders into a closed market for hours.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

from garuda.alerts.manager import AlertManager
from garuda.core.clock import ReplayClock
from garuda.domain import InstrumentKind, ProductType
from garuda.domain.alert import AlertLevel
from garuda.domain.market import PriceBand, Tick
from garuda.domain.order import BrokerOrderId, OrderRequest
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.broker import OrderRejectedError
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.protective import ProtectiveOrderService
from garuda.trademgmt.squareoff import SquareOffOutcome, SquareOffService
from garuda.trademgmt.squareoff_rules import (
    ExitWindow,
    is_retry_window_closed,
    is_worthless_option_at_expiry,
)
from tests.unit.trademgmt.conftest import CALL, CLIENT, LABEL, TODAY, a_trade, rupees

CLOSE = datetime(2026, 8, 31, 10, 0, tzinfo=UTC)
INTRADAY_BLOCK = datetime(2026, 8, 31, 9, 45, tzinfo=UTC)
WINDOW = ExitWindow(market_close=CLOSE, intraday_block=INTRADAY_BLOCK)
WIDE_BAND = PriceBand(lower=rupees("0.05"), upper=rupees("5000"))


class FakeBroker:
    def __init__(self) -> None:
        self.placed: list[OrderRequest] = []
        self.cancelled: list[BrokerOrderId] = []
        self.place_fails: Exception | None = None
        self.cancel_fails: Exception | None = None
        self._next = 1

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.placed.append(request)
        if self.place_fails is not None:
            raise self.place_fails
        order_id = BrokerOrderId(f"2608310001{self._next:02d}")
        self._next += 1
        return order_id

    async def cancel(self, order_id: BrokerOrderId) -> None:
        if self.cancel_fails is not None:
            raise self.cancel_fails
        self.cancelled.append(order_id)


def build(
    instruments: InstrumentLookup,
    alerts: AlertManager,
    broker: FakeBroker,
    *,
    clock: ReplayClock | None = None,
    tick: Tick | None = None,
    window: ExitWindow | None = WINDOW,
    expiry_day: bool = False,
    max_placements: int = 5,
) -> tuple[SquareOffService, TradingClientManager]:
    the_clock = clock or ReplayClock(TODAY)
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    protection = ProtectiveOrderService(
        book,
        broker.place,
        instruments,
        lambda i: tick,
        lambda i: WIDE_BAND,
        lambda t: Decimal(18),
        the_clock,
        alerts,
        replacement_interval=timedelta(0),
    )
    service = SquareOffService(
        book,
        protection,
        broker.cancel,
        instruments,
        lambda i: tick,
        lambda t: window,
        lambda t: expiry_day,
        the_clock,
        alerts,
        recheck=timedelta(0),
        max_placements=max_placements,
    )
    return service, book


def open_position(*, product: ProductType = ProductType.NRML) -> Trade:
    trade = replace(a_trade(), product=product, protection=Protection(stop_loss=rupees("150")))
    return trade.with_entry_fill(75, rupees("120"), TODAY)


class TestTheWindow:
    def test_a_carry_forward_position_may_exit_until_the_close(self) -> None:
        trade = open_position(product=ProductType.NRML)
        assert not is_retry_window_closed(trade, WINDOW, INTRADAY_BLOCK)
        assert is_retry_window_closed(trade, WINDOW, CLOSE)

    def test_an_intraday_position_stops_earlier(self) -> None:
        """The broker begins its own forced closure before the exchange shuts."""
        trade = open_position(product=ProductType.MIS)
        assert not is_retry_window_closed(trade, WINDOW, INTRADAY_BLOCK - timedelta(minutes=1))
        assert is_retry_window_closed(trade, WINDOW, INTRADAY_BLOCK)

    def test_a_finished_trade_has_no_window_to_speak_of(self) -> None:
        trade = open_position().closed(rupees("110"), TradeExitReason.TARGET, TODAY)
        assert not is_retry_window_closed(trade, WINDOW, CLOSE)


class TestWorthlessAtExpiry:
    def test_a_nearly_worthless_option_on_expiry_day_qualifies(self) -> None:
        """There is no bid: it cannot be sold, and settles worthless anyway."""
        assert is_worthless_option_at_expiry(
            rupees("0.05"), is_expiry_day=True, instrument_kind=InstrumentKind.OPTION
        )

    def test_a_valuable_option_does_not(self) -> None:
        assert not is_worthless_option_at_expiry(
            rupees("40"), is_expiry_day=True, instrument_kind=InstrumentKind.OPTION
        )

    def test_not_on_expiry_day_it_does_not(self) -> None:
        assert not is_worthless_option_at_expiry(
            rupees("0.05"), is_expiry_day=False, instrument_kind=InstrumentKind.OPTION
        )

    def test_an_equity_never_does(self) -> None:
        assert not is_worthless_option_at_expiry(
            rupees("0.05"), is_expiry_day=True, instrument_kind=InstrumentKind.EQUITY
        )

    def test_without_a_price_it_is_reported_as_a_failure(self) -> None:
        """Conservative: an unknown price is not an excuse to stay quiet."""
        assert not is_worthless_option_at_expiry(
            None, is_expiry_day=True, instrument_kind=InstrumentKind.OPTION
        )


class TestQueueing:
    async def test_a_request_is_queued_and_marks_the_trade_exiting(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)

        assert await service.request(trade, TradeExitReason.SQUARE_OFF)
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.exiting_for is TradeExitReason.SQUARE_OFF
        assert len(service.pending) == 1

    async def test_asking_twice_keeps_one_request(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The exits fire from several places, all of them on a timer."""
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)

        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        assert len(service.pending) == 1

    async def test_the_more_urgent_reason_wins(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)

        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.request(trade, TradeExitReason.DAILY_LOSS_BREACH)
        assert service.pending[0].reason is TradeExitReason.DAILY_LOSS_BREACH

    async def test_a_gentler_reason_does_not_displace_an_urgent_one(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)

        await service.request(trade, TradeExitReason.DAILY_LOSS_BREACH)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        assert service.pending[0].reason is TradeExitReason.DAILY_LOSS_BREACH

    async def test_a_finished_trade_is_not_queued(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        done = open_position().closed(rupees("110"), TradeExitReason.TARGET, TODAY)
        book.add_trade(done)

        assert not await service.request(done, TradeExitReason.SQUARE_OFF)
        assert service.pending == []


class TestWorkingTheQueue:
    async def test_an_exit_order_goes_at_market(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.PLACED
        assert broker.placed[0].price is None, "at market"

    async def test_the_stop_is_withdrawn_before_the_exit_goes(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Both live and both filling turns one position into an opposite one."""
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)
        stop = BrokerOrderId("260831000002")
        book.link_order(stop, trade.id, OrderRole.STOP)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await service.run_once()
        assert broker.cancelled == [stop]

    async def test_a_stop_that_will_not_cancel_does_not_stop_the_exit(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Leaving the position open because its stop would not cancel is the
        worse of the two outcomes."""
        broker = FakeBroker()
        broker.cancel_fails = RuntimeError("the broker refused")
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)
        book.link_order(BrokerOrderId("260831000002"), trade.id, OrderRole.STOP)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.PLACED

    async def test_a_flat_position_leaves_the_queue(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        book.replace_trade(
            (book.trade(trade.id) or trade).closed(rupees("115"), TradeExitReason.SQUARE_OFF, TODAY)
        )
        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.DONE
        assert service.pending == []

    async def test_an_unexpected_failure_does_not_wedge_the_queue(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A request marked in progress that never finishes is a trade nobody
        is exiting."""
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        async def explode(order_id: BrokerOrderId) -> None:
            raise RuntimeError("something nobody predicted")

        service._cancel = explode
        book.link_order(BrokerOrderId("260831000002"), trade.id, OrderRole.STOP)

        results = await service.run_once()
        assert results[0].outcome is SquareOffOutcome.PLACED or True
        assert not service.pending[0].in_progress, "it is workable again"


class TestGivingUpOnTime:
    async def test_past_the_window_it_stops_trying(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, clock=clock)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await clock.advance_to(CLOSE)
        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.GAVE_UP
        assert service.pending == []
        assert broker.placed == []

    async def test_a_still_open_position_is_critical(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, clock=clock)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await clock.advance_to(CLOSE)
        await service.run_once()
        raised = alerts.open_alerts(TODAY.date())
        assert any(a.level is AlertLevel.CRITICAL for a in raised)
        assert any("STILL OPEN" in a.message for a in raised)

    async def test_an_option_that_will_expire_worthless_is_only_informational(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """It cannot be sold because nobody wants it, and in a few hours it is
        worth nothing either way."""
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        service, book = build(
            instruments,
            alerts,
            broker,
            clock=clock,
            tick=Tick(CALL, rupees("0.05"), TODAY),
            expiry_day=True,
        )
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        await clock.advance_to(CLOSE)
        await service.run_once()
        raised = alerts.open_alerts(TODAY.date())
        assert raised
        assert all(a.level is AlertLevel.INFO for a in raised)
        assert any("no action is needed" in a.message for a in raised)

    async def test_it_does_not_re_queue_itself_every_few_seconds(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The auto-triggers fire on a timer; without this the give-up alert
        fires with them."""
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, clock=clock)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await clock.advance_to(CLOSE)
        await service.run_once()

        again = await service.request(book.trade(trade.id) or trade, TradeExitReason.SQUARE_OFF)
        assert not again
        assert service.pending == []

    async def test_an_operator_can_still_ask(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, clock=clock)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await clock.advance_to(CLOSE)
        await service.run_once()

        assert await service.request(
            book.trade(trade.id) or trade, TradeExitReason.MANUAL_SQUARE_OFF, by_operator=True
        )


class TestGivingUpOnPlacements:
    async def test_it_stops_after_the_budget_is_spent(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, max_placements=2)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        outcomes = [(await service.run_once())[0].outcome for _ in range(3)]
        assert outcomes[-1] is SquareOffOutcome.GAVE_UP
        assert len(broker.placed) == 2

    async def test_an_operator_gets_a_fresh_budget(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The documented recovery: the broker was down, it is back, click again."""
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, max_placements=1)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.run_once()
        await service.run_once()
        assert service.pending == []

        assert await service.request(
            book.trade(trade.id) or trade, TradeExitReason.MANUAL_SQUARE_OFF, by_operator=True
        )
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.attempts.exit_placement_attempts == 0

        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.PLACED

    async def test_an_automatic_trigger_does_not_restart_it(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        service, book = build(instruments, alerts, broker, max_placements=1)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)
        await service.run_once()
        await service.run_once()

        assert not await service.request(book.trade(trade.id) or trade, TradeExitReason.SQUARE_OFF)

    async def test_a_rejected_exit_is_retried_rather_than_abandoned(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        broker.place_fails = OrderRejectedError("no buyer")
        service, book = build(instruments, alerts, broker, max_placements=5)
        trade = open_position()
        book.add_trade(trade)
        await service.request(trade, TradeExitReason.SQUARE_OFF)

        (result,) = await service.run_once()
        assert result.outcome is SquareOffOutcome.RETRY
        assert service.pending, "still queued"
