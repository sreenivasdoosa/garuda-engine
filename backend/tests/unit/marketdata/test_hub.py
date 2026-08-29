"""The tick hub and the feed supervisor.

The claims are about what survives a reconnection, what happens under a
backlog, and how a feed that stalls without disconnecting is noticed.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta

import pytest

from garuda.core.backoff import ReconnectPolicy
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.marketdata.hub import TickHub
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.protocols.feed import (
    FeedConnected,
    FeedDisconnected,
    FeedEvent,
    FeedProblem,
    MarketDataFeed,
    TicksReceived,
)
from garuda.protocols.topics import Topic
from tests.support import next_published

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
NIFTY = InstrumentId("NSE:NIFTY")
CALL = InstrumentId("NFO:NIFTY26AUG25000CE")
PUT = InstrumentId("NFO:NIFTY26AUG25000PE")


def tick(instrument: InstrumentId, price: str, at: datetime = T0) -> Tick:
    return Tick(instrument, Money.of(price, Currency.INR), at)


class FakeFeed:
    """A feed that records what it was told and emits what it is given."""

    def __init__(self, name: str = "fake", events: Sequence[FeedEvent] = ()) -> None:
        self._name = name
        self._events = list(events)
        self.subscribed: list[InstrumentId] = []
        self.unsubscribed: list[InstrumentId] = []
        self.connected = False
        self.closed = False
        self.connect_calls = 0

    @property
    def name(self) -> str:
        return self._name

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connect_calls += 1
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        self.closed = True

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None:
        self.subscribed.extend(instruments)

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None:
        self.unsubscribed.extend(instruments)

    async def events(self) -> AsyncIterator[FeedEvent]:
        for event in self._events:
            yield event


@pytest.fixture
def clock() -> ReplayClock:
    return ReplayClock(T0)


@pytest.fixture
def bus() -> InProcessEventBus:
    return InProcessEventBus()


@pytest.fixture
def hub(bus: InProcessEventBus, clock: ReplayClock) -> TickHub:
    return TickHub(bus, clock)


class TestSubscriptions:
    async def test_a_subscription_reaches_the_attached_feed(self, hub: TickHub) -> None:
        feed = FakeFeed()
        await hub.attach(feed)
        await hub.subscribe([NIFTY, CALL])
        assert set(feed.subscribed) == {NIFTY, CALL}

    async def test_a_subscription_made_while_down_is_not_lost(self, hub: TickHub) -> None:
        """The feed being down is when a strategy starts, not a reason to fail."""
        await hub.subscribe([NIFTY, CALL])
        assert hub.subscriptions == frozenset({NIFTY, CALL})

        feed = FakeFeed()
        await hub.attach(feed)
        assert set(feed.subscribed) == {NIFTY, CALL}

    async def test_a_new_connection_is_told_everything_again(self, hub: TickHub) -> None:
        """A feed that came back and forgot is a strategy blind while green."""
        await hub.subscribe([NIFTY, CALL, PUT])
        first = FakeFeed("first")
        await hub.attach(first)

        hub.detach()
        second = FakeFeed("second")
        await hub.attach(second)
        assert set(second.subscribed) == {NIFTY, CALL, PUT}

    async def test_subscribing_twice_tells_the_feed_once(self, hub: TickHub) -> None:
        feed = FakeFeed()
        await hub.attach(feed)
        await hub.subscribe([NIFTY])
        await hub.subscribe([NIFTY])
        assert feed.subscribed == [NIFTY]

    async def test_unsubscribing_removes_it_from_the_set_and_the_feed(self, hub: TickHub) -> None:
        feed = FakeFeed()
        await hub.attach(feed)
        await hub.subscribe([NIFTY, CALL])
        await hub.unsubscribe([NIFTY])
        assert hub.subscriptions == frozenset({CALL})
        assert feed.unsubscribed == [NIFTY]


class TestDispatch:
    async def test_a_tick_reaches_the_bus(self, hub: TickHub, bus: InProcessEventBus) -> None:
        subscription = bus.subscribe(Topic.TICKS, name="test")
        await hub.consume([TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()

        received = await next_published(subscription)
        assert isinstance(received, Tick)
        assert received.last_price == Money.of("25000", Currency.INR)

    async def test_only_the_latest_tick_per_instrument_is_dispatched(
        self, hub: TickHub, bus: InProcessEventBus
    ) -> None:
        """Under a backlog the engine works on current prices, not old ones."""
        subscription = bus.subscribe(Topic.TICKS, name="test")
        await hub.consume(
            [
                TicksReceived((tick(NIFTY, "25000"), tick(CALL, "120"))),
                TicksReceived((tick(NIFTY, "25010"),)),
                TicksReceived((tick(NIFTY, "25020"),)),
            ]
        )
        assert await hub.dispatch_once() == 2

        prices = {}
        for _ in range(2):
            received = await next_published(subscription)
            assert isinstance(received, Tick)
            prices[received.instrument] = received.last_price
        assert prices[NIFTY] == Money.of("25020", Currency.INR)
        assert prices[CALL] == Money.of("120", Currency.INR)

    async def test_superseded_ticks_are_counted_not_silently_dropped(self, hub: TickHub) -> None:
        """A feed quietly shedding load looks healthy until a price is stale."""
        await hub.consume(
            [TicksReceived((tick(NIFTY, "25000"),)), TicksReceived((tick(NIFTY, "25010"),))]
        )
        await hub.dispatch_once()
        assert hub.health.ticks_superseded == 1
        assert hub.health.ticks_received == 2
        assert hub.health.ticks_published == 1

    async def test_dispatching_with_nothing_staged_publishes_nothing(self, hub: TickHub) -> None:
        assert await hub.dispatch_once() == 0


class TestTheLatestPrice:
    async def test_the_latest_tick_is_readable_without_waiting(self, hub: TickHub) -> None:
        await hub.consume([TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()
        latest = hub.latest(NIFTY)
        assert latest is not None
        assert latest.last_price == Money.of("25000", Currency.INR)

    async def test_an_instrument_that_never_ticked_has_no_price(self, hub: TickHub) -> None:
        """No price, never a zero standing in for one."""
        assert hub.latest(NIFTY) is None

    async def test_clearing_forgets_yesterdays_prices(self, hub: TickHub) -> None:
        """Yesterday's last trade is not today's open, and nothing expires it."""
        await hub.consume([TicksReceived((tick(NIFTY, "25000"), tick(CALL, "120")))])
        await hub.dispatch_once()
        assert hub.clear_latest() == 2
        assert hub.latest(NIFTY) is None


class TestStaleness:
    async def test_a_feed_that_stalls_without_disconnecting_is_noticed(
        self, hub: TickHub, clock: ReplayClock
    ) -> None:
        """No frames, no error, no disconnect -- prices simply stop."""
        feed = FakeFeed()
        await feed.connect()
        await hub.attach(feed)
        await hub.subscribe([NIFTY])
        await hub.consume([FeedConnected(T0), TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()

        assert hub.staleness(T0 + timedelta(seconds=5)).instruments == ()

        stale = hub.staleness(T0 + timedelta(minutes=1))
        assert stale.instruments == (NIFTY,)
        assert stale.feed_is_silent
        assert feed.is_connected, "the socket is still open, which is the whole problem"

    async def test_a_subscription_that_never_ticked_counts_as_stale(self, hub: TickHub) -> None:
        await hub.subscribe([NIFTY, CALL])
        await hub.consume([TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()
        assert hub.staleness(T0).instruments == (CALL,)

    async def test_nothing_subscribed_is_not_silence(self, hub: TickHub) -> None:
        """A feed with no subscriptions is idle, not broken."""
        assert not hub.staleness(T0 + timedelta(hours=1)).feed_is_silent


class TestHealth:
    async def test_connection_events_are_recorded_with_their_reason(self, hub: TickHub) -> None:
        """An outage with no cause is an investigation from scratch."""
        await hub.consume([FeedConnected(T0)])
        while_up = hub.health.connected_since

        await hub.consume([FeedDisconnected("token expired", T0 + timedelta(minutes=1))])
        assert while_up == T0
        assert hub.health.connected_since is None
        assert hub.health.last_disconnect_reason == "token expired"

    async def test_a_problem_is_recorded_without_dropping_the_connection(
        self, hub: TickHub
    ) -> None:
        """One instrument's packets going missing looks like an illiquid symbol."""
        await hub.consume([FeedConnected(T0), FeedProblem("token 999 is not in the master", T0)])
        assert hub.health.connected_since == T0
        assert hub.health.unresolved_tokens == 1


class TestTheSupervisor:
    def supervisor(self, hub: TickHub, clock: ReplayClock, feeds: list[FakeFeed]) -> FeedSupervisor:
        async def factory() -> MarketDataFeed:
            feed = FakeFeed(f"feed-{len(feeds)}")
            feeds.append(feed)
            return feed

        return FeedSupervisor(hub, factory, clock, policy=ReconnectPolicy())

    async def test_starting_connects_and_restores_subscriptions(
        self, hub: TickHub, clock: ReplayClock
    ) -> None:
        await hub.subscribe([NIFTY, CALL])
        feeds: list[FakeFeed] = []
        assert await self.supervisor(hub, clock, feeds).start()
        assert feeds[0].is_connected
        assert set(feeds[0].subscribed) == {NIFTY, CALL}

    async def test_a_connect_failure_is_reported_not_raised(
        self, hub: TickHub, clock: ReplayClock
    ) -> None:
        """A feed down at nine is a condition to retry, not a lost day-init."""

        async def factory() -> MarketDataFeed:
            raise ConnectionError("the provider is unreachable")

        supervisor = FeedSupervisor(hub, factory, clock)
        assert await supervisor.start() is False
        assert supervisor.state.consecutive_failures == 1

    async def test_the_old_connection_is_closed_before_a_new_one_is_made(
        self, hub: TickHub, clock: ReplayClock
    ) -> None:
        """A half-dead socket left alive holds the account's one feed session."""
        feeds: list[FakeFeed] = []
        supervisor = self.supervisor(hub, clock, feeds)
        await hub.subscribe([NIFTY])
        await supervisor.start()

        feeds[0].connected = False  # the socket dropped underneath
        assert await supervisor.reconcile()

        assert feeds[0].closed, "the old feed must be torn down, not merely dereferenced"
        assert len(feeds) == 2
        assert feeds[1].is_connected
        assert set(feeds[1].subscribed) == {NIFTY}

    async def test_silence_alone_forces_a_reconnect(self, hub: TickHub, clock: ReplayClock) -> None:
        """The socket is open and nothing is arriving. Only ticks say otherwise."""
        feeds: list[FakeFeed] = []
        supervisor = self.supervisor(hub, clock, feeds)
        await hub.subscribe([NIFTY])
        await supervisor.start()
        await hub.consume([TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()

        assert supervisor.needs_reconnect(T0 + timedelta(seconds=10)) is None

        reason = supervisor.needs_reconnect(T0 + timedelta(minutes=5))
        assert reason is not None
        assert "no ticks" in reason

    async def test_a_healthy_feed_is_left_alone(self, hub: TickHub, clock: ReplayClock) -> None:
        feeds: list[FakeFeed] = []
        supervisor = self.supervisor(hub, clock, feeds)
        await hub.subscribe([NIFTY])
        await supervisor.start()
        await hub.consume([TicksReceived((tick(NIFTY, "25000"),))])
        await hub.dispatch_once()

        assert await supervisor.reconcile() is False
        assert len(feeds) == 1

    async def test_backoff_grows_and_then_stops_growing(self) -> None:
        """A provider that is down stays down; retrying every second rate limits."""
        policy = ReconnectPolicy(
            initial=timedelta(seconds=1), maximum=timedelta(seconds=30), factor=2
        )
        delays = [policy.delay_after(n).total_seconds() for n in range(1, 8)]
        assert delays == [1, 2, 4, 8, 16, 30, 30]

    async def test_a_backoff_that_shortens_each_time_is_refused(self) -> None:
        with pytest.raises(DomainError, match="shortens the wait"):
            ReconnectPolicy(factor=0)
