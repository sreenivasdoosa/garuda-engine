"""The order manager: placement, retries, and folding broker events."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime

import pytest

from garuda.brokers.paper import PaperBroker
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.journal import EventType, JournalEvent
from garuda.domain.market import DepthLevel, Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.ordermgmt import ClientOrderIdSequence, OrderManager, OrderManagerError
from garuda.protocols.broker import (
    OrderAccepted,
    OrderCancelled,
    OrderRejected,
    OrderRejectedError,
    RateLimitedError,
)
from garuda.protocols.topics import Topic

T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
DAY = date(2026, 8, 27)
CLIENT = TradingClientId("appa-zerodha-paper")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


class RecordingJournal:
    """Captures what would have been appended."""

    def __init__(self) -> None:
        self.events: list[JournalEvent] = []

    async def __call__(self, events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        written = [event.with_sequence(len(self.events) + i + 1) for i, event in enumerate(events)]
        self.events.extend(written)
        return written

    @property
    def types(self) -> list[EventType]:
        return [event.event_type for event in self.events]


class FlakyBroker:
    """Fails a set number of times, then succeeds. Records what it was sent."""

    def __init__(self, failures: int = 0, reject: bool = False) -> None:
        self._failures = failures
        self._reject = reject
        self.received: list[OrderRequest] = []

    @property
    def trading_client(self) -> TradingClientId:
        return CLIENT

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.received.append(request)
        if self._reject:
            raise OrderRejectedError("insufficient margin")
        if self._failures > 0:
            self._failures -= 1
            raise RateLimitedError("slow down")
        return BrokerOrderId(f"b-{len(self.received)}")

    async def cancel(self, broker_order_id: BrokerOrderId) -> None:
        return None


@pytest.fixture
def clock() -> ReplayClock:
    return ReplayClock(T0)


@pytest.fixture
def bus() -> InProcessEventBus:
    return InProcessEventBus()


@pytest.fixture
def journal() -> RecordingJournal:
    return RecordingJournal()


@pytest.fixture
def ids() -> ClientOrderIdSequence:
    return ClientOrderIdSequence(DAY)


def manager(
    adapter: object,
    clock: ReplayClock,
    bus: InProcessEventBus,
    journal: RecordingJournal,
    **kwargs: object,
) -> OrderManager:
    return OrderManager(
        adapter=adapter,  # type: ignore[arg-type]
        clock=clock,
        bus=bus,
        journal=journal,
        trading_day_for=lambda _: DAY,
        **kwargs,  # type: ignore[arg-type]
    )


def request(instrument: Instrument, order_id: ClientOrderId) -> OrderRequest:
    return OrderRequest(
        client_order_id=order_id,
        trading_client=CLIENT,
        instrument=instrument.id,
        side=Side.SELL,
        quantity=75,
        order_type=OrderType.MARKET,
        product=ProductType.NRML,
    )


class TestIds:
    def test_ids_are_sequential_and_dated(self):
        sequence = ClientOrderIdSequence(DAY)
        assert str(sequence.next()) == "gar-20260827-000001"
        assert str(sequence.next()) == "gar-20260827-000002"

    def test_ids_are_deterministic_so_a_replay_reproduces_them(self):
        first = [ClientOrderIdSequence(DAY).next() for _ in range(1)]
        second = [ClientOrderIdSequence(DAY).next() for _ in range(1)]
        assert first == second

    def test_a_restart_resumes_after_the_highest_id_already_issued(self):
        existing = [ClientOrderId("gar-20260827-000001"), ClientOrderId("gar-20260827-000007")]
        resumed = ClientOrderIdSequence.resuming_from(DAY, existing)
        assert str(resumed.next()) == "gar-20260827-000008"

    def test_an_empty_journal_starts_at_one(self):
        assert str(ClientOrderIdSequence.resuming_from(DAY, []).next()) == "gar-20260827-000001"


class TestPlacement:
    async def test_the_intent_is_journalled_before_the_request_is_sent(
        self, clock, bus, journal, nifty_call
    ):
        """A crash between the two must leave evidence."""
        broker = FlakyBroker()
        order_manager = manager(broker, clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))

        assert journal.types[0] is EventType.ORDER_PLACED
        assert broker.received, "and only then is it sent"

    async def test_the_order_enters_the_book_as_pending(self, clock, bus, journal, nifty_call):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        result = await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        assert result.order.status is OrderStatus.PENDING_NEW
        assert order_manager.order(ClientOrderId("gar-1")) is not None

    async def test_placing_the_same_id_twice_is_refused(self, clock, bus, journal, nifty_call):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        order_request = request(nifty_call, ClientOrderId("gar-1"))
        await order_manager.place(order_request)
        with pytest.raises(OrderManagerError, match="already placed"):
            await order_manager.place(order_request)


class TestRetries:
    async def test_a_transient_failure_is_retried(self, clock, bus, journal, nifty_call):
        broker = FlakyBroker(failures=1)
        order_manager = manager(broker, clock, bus, journal)
        result = await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        assert result.attempts == 2
        assert result.order.status is OrderStatus.PENDING_NEW

    async def test_every_retry_reuses_the_same_client_order_id(
        self, clock, bus, journal, nifty_call
    ):
        """A fresh id on retry is how one intent becomes two positions."""
        broker = FlakyBroker(failures=2)
        order_manager = manager(broker, clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))

        sent_ids = {sent.client_order_id for sent in broker.received}
        assert len(broker.received) == 3
        assert sent_ids == {ClientOrderId("gar-1")}

    async def test_exhausting_the_retries_rejects_the_order(self, clock, bus, journal, nifty_call):
        broker = FlakyBroker(failures=99)
        order_manager = manager(broker, clock, bus, journal, max_retries=1)
        result = await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        assert result.order.status is OrderStatus.REJECTED
        assert "gave up after 2 attempts" in (result.order.rejection_reason or "")
        assert EventType.ORDER_REJECTED in journal.types

    async def test_an_outright_rejection_is_not_retried(self, clock, bus, journal, nifty_call):
        broker = FlakyBroker(reject=True)
        order_manager = manager(broker, clock, bus, journal)
        result = await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        assert len(broker.received) == 1, "retrying a rejection cannot help"
        assert result.order.status is OrderStatus.REJECTED


class TestBrokerEvents:
    async def test_acceptance_records_the_broker_id(self, clock, bus, journal, nifty_call):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        await order_manager.handle(
            OrderAccepted(ClientOrderId("gar-1"), BrokerOrderId("b-1"), at=T0)
        )
        order = order_manager.order(ClientOrderId("gar-1"))
        assert order is not None
        assert order.status is OrderStatus.NEW
        assert order.broker_order_id == BrokerOrderId("b-1")
        assert EventType.ORDER_ACCEPTED in journal.types

    async def test_a_rejection_event_is_journalled_with_its_reason(
        self, clock, bus, journal, nifty_call
    ):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        await order_manager.handle(OrderRejected(ClientOrderId("gar-1"), "circuit limit", at=T0))
        order = order_manager.order(ClientOrderId("gar-1"))
        assert order is not None
        assert order.rejection_reason == "circuit limit"

    async def test_a_cancellation_is_folded_in(self, clock, bus, journal, nifty_call):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        await order_manager.handle(
            OrderAccepted(ClientOrderId("gar-1"), BrokerOrderId("b-1"), at=T0)
        )
        await order_manager.handle(OrderCancelled(ClientOrderId("gar-1"), at=T0))
        order = order_manager.order(ClientOrderId("gar-1"))
        assert order is not None
        assert order.status is OrderStatus.CANCELLED

    async def test_an_event_for_an_unknown_order_is_refused(self, clock, bus, journal):
        order_manager = manager(FlakyBroker(), clock, bus, journal)
        with pytest.raises(OrderManagerError, match="not in the order book"):
            await order_manager.handle(OrderCancelled(ClientOrderId("ghost"), at=T0))


class TestWithThePaperBroker:
    """The loop closing: request, fill, position, journal."""

    async def test_a_market_order_fills_and_is_journalled(self, clock, bus, journal, nifty_call):
        paper = PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})
        await paper.on_tick(
            Tick(
                nifty_call.id,
                rupees("120.00"),
                T0,
                bids=(DepthLevel(rupees("119.90"), 75),),
                asks=(DepthLevel(rupees("120.10"), 75),),
            )
        )
        order_manager = manager(paper, clock, bus, journal)

        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        for event in paper.drain_events():
            await order_manager.handle(event)

        order = order_manager.order(ClientOrderId("gar-1"))
        assert order is not None
        assert order.status is OrderStatus.FILLED
        assert order.filled_quantity == 75
        assert journal.types == [
            EventType.ORDER_PLACED,
            EventType.ORDER_ACCEPTED,
            EventType.ORDER_FILLED,
        ]

    async def test_the_fill_price_reflects_crossing_the_spread(
        self, clock, bus, journal, nifty_call
    ):
        paper = PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})
        await paper.on_tick(
            Tick(
                nifty_call.id,
                rupees("120.00"),
                T0,
                bids=(DepthLevel(rupees("119.90"), 75),),
                asks=(DepthLevel(rupees("120.10"), 75),),
            )
        )
        order_manager = manager(paper, clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        for event in paper.drain_events():
            await order_manager.handle(event)

        order = order_manager.order(ClientOrderId("gar-1"))
        assert order is not None
        assert order.average_fill_price == rupees("119.85")

    async def test_fills_are_published_for_anything_downstream(
        self, clock, bus, journal, nifty_call
    ):
        subscription = bus.subscribe(Topic.FILLS)
        paper = PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})
        await paper.on_tick(
            Tick(
                nifty_call.id,
                rupees("120.00"),
                T0,
                bids=(DepthLevel(rupees("119.90"), 75),),
                asks=(DepthLevel(rupees("120.10"), 75),),
            )
        )
        order_manager = manager(paper, clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        for event in paper.drain_events():
            await order_manager.handle(event)

        published = await anext(subscription)
        assert published.price == rupees("119.85")

    async def test_working_orders_exclude_the_filled_ones(self, clock, bus, journal, nifty_call):
        paper = PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})
        await paper.on_tick(
            Tick(
                nifty_call.id,
                rupees("120.00"),
                T0,
                bids=(DepthLevel(rupees("119.90"), 75),),
                asks=(DepthLevel(rupees("120.10"), 75),),
            )
        )
        order_manager = manager(paper, clock, bus, journal)
        await order_manager.place(request(nifty_call, ClientOrderId("gar-1")))
        for event in paper.drain_events():
            await order_manager.handle(event)
        assert order_manager.working_orders == {}
