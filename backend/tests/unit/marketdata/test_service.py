"""Market data across the trading day.

The claims are about lifetime: what a restart-shaped day does to a connection
shared by venues that open and close at different times.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime

from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.core.runner import (
    EngineRunner,
    InMemoryPhaseRecorder,
    PhaseContext,
    TaskRegistry,
)
from garuda.domain import Currency, Money
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.phases import DayPhase
from garuda.marketdata.hub import TickHub
from garuda.marketdata.service import MarketDataService
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.marketdata.tasks import register_feed_lifecycle
from garuda.protocols.feed import FeedEvent, MarketDataFeed, TicksReceived

NIFTY = InstrumentId("NSE:NIFTY")
GOLD = InstrumentId("MCX:GOLD")

#: A Monday. Equities are closed by 10:00 UTC (15:30 IST); commodities are not.
AFTER_EQUITY_CLOSE = datetime(2026, 8, 31, 10, 30, tzinfo=UTC)
DURING_SESSION = datetime(2026, 8, 31, 5, 0, tzinfo=UTC)


def yesterdays_close() -> Tick:
    return Tick(NIFTY, Money.of("24000", Currency.INR), DURING_SESSION)


class SilentFeed:
    def __init__(self, name: str = "silent") -> None:
        self._name = name
        self.connected = False
        self.closed = False
        self.subscribed: list[InstrumentId] = []

    @property
    def name(self) -> str:
        return self._name

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        self.closed = True

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None:
        self.subscribed.extend(instruments)

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None:
        for instrument in instruments:
            self.subscribed.remove(instrument)

    async def events(self) -> AsyncIterator[FeedEvent]:
        return
        yield  # pragma: no cover


def build(clock: ReplayClock, feeds: list[SilentFeed]) -> tuple[MarketDataService, TickHub]:
    hub = TickHub(InProcessEventBus(), clock)

    async def factory() -> MarketDataFeed:
        feed = SilentFeed(f"feed-{len(feeds)}")
        feeds.append(feed)
        return feed

    supervisor = FeedSupervisor(hub, factory, clock)
    service = MarketDataService(hub, supervisor, clock, standing_subscriptions=lambda: [NIFTY])
    return service, hub


class TestTheService:
    async def test_starting_connects_and_takes_the_standing_subscriptions(self) -> None:
        """The index list comes from the master, which day-init has just built."""
        feeds: list[SilentFeed] = []
        service, _ = build(ReplayClock(DURING_SESSION), feeds)
        try:
            assert await service.start()
            assert feeds[0].is_connected
            assert feeds[0].subscribed == [NIFTY]
        finally:
            await service.stop()

    async def test_starting_twice_does_not_open_a_second_connection(self) -> None:
        feeds: list[SilentFeed] = []
        service, _ = build(ReplayClock(DURING_SESSION), feeds)
        try:
            await service.start()
            await service.start()
            assert len(feeds) == 1
        finally:
            await service.stop()

    async def test_stopping_closes_the_connection_and_is_safe_to_repeat(self) -> None:
        feeds: list[SilentFeed] = []
        service, _ = build(ReplayClock(DURING_SESSION), feeds)
        await service.start()
        await service.stop()
        await service.stop()
        assert feeds[0].closed
        assert not service.is_running

    async def test_a_feed_that_will_not_connect_still_leaves_the_monitor_running(self) -> None:
        """The monitor is what retries; giving up at start means never recovering."""
        clock = ReplayClock(DURING_SESSION)
        hub = TickHub(InProcessEventBus(), clock)

        async def factory() -> MarketDataFeed:
            raise ConnectionError("the provider is unreachable")

        service = MarketDataService(hub, FeedSupervisor(hub, factory, clock), clock)
        try:
            assert await service.start() is False
            assert service.is_running
        finally:
            await service.stop()


class TestTheTradingDay:
    def wire(
        self, clock: ReplayClock, exchanges: Sequence[Exchange], feeds: list[SilentFeed]
    ) -> tuple[TaskRegistry, MarketDataService, TickHub]:
        service, hub = build(clock, feeds)
        registry = TaskRegistry()
        register_feed_lifecycle(registry, service, exchanges)
        return registry, service, hub

    async def test_day_init_forgets_yesterdays_prices(self, nse: Exchange) -> None:
        """Friday's last trade is not Monday's open, and nothing expires it."""
        clock = ReplayClock(datetime(2026, 8, 31, 1, 30, tzinfo=UTC))
        feeds: list[SilentFeed] = []
        registry, service, hub = self.wire(clock, [nse], feeds)
        await hub.consume([TicksReceived((yesterdays_close(),))])
        await hub.dispatch_once()
        assert hub.latest(NIFTY) is not None

        runner = EngineRunner(
            exchanges=[nse], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )
        try:
            await runner.run_once()
            assert hub.latest(NIFTY) is None
        finally:
            await service.stop()

    async def test_the_second_venues_day_init_does_not_discard_live_prices(
        self, nse: Exchange, mcx: Exchange
    ) -> None:
        """The runner walks each venue through its whole day in turn, so by the
        time commodities reach day-init, equities are already ticking."""
        clock = ReplayClock(datetime(2026, 8, 31, 3, 0, tzinfo=UTC))
        feeds: list[SilentFeed] = []
        registry, service, hub = self.wire(clock, [nse, mcx], feeds)
        runner = EngineRunner(
            exchanges=[nse, mcx], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )
        try:
            # Equities run their day-init and start the feed.
            await runner.run_once()
            await hub.consume([TicksReceived((yesterdays_close(),))])
            await hub.dispatch_once()

            # Commodities reach day-init on the next pass; nothing is reset.
            for _, task in registry.tasks_for(DayPhase.DAY_INIT, mcx.code):
                await task(_context(mcx, DayPhase.DAY_INIT, clock.now()))

            assert hub.latest(NIFTY) is not None
            assert service.is_running
            assert not feeds[0].closed
        finally:
            await service.stop()

    async def test_the_feed_comes_up_once_however_many_venues_reach_the_start(
        self, nse: Exchange, mcx: Exchange
    ) -> None:
        clock = ReplayClock(datetime(2026, 8, 31, 3, 0, tzinfo=UTC))
        feeds: list[SilentFeed] = []
        registry, service, _ = self.wire(clock, [nse, mcx], feeds)
        runner = EngineRunner(
            exchanges=[nse, mcx], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )
        try:
            result = await runner.run_once()
            started = [i for i in result.ran if i.phase is DayPhase.ALGO_START]
            assert len(started) == 2, "both venues reached the start"
            assert len(feeds) == 1, "and they share one connection"
        finally:
            await service.stop()

    async def test_equities_closing_does_not_cut_commodities_off(
        self, nse: Exchange, mcx: Exchange
    ) -> None:
        """One connection, two venues, different closes. The obvious wiring
        stops the feed at half past three because equities finished."""
        clock = ReplayClock(AFTER_EQUITY_CLOSE)
        feeds: list[SilentFeed] = []
        registry, service, _ = self.wire(clock, [nse, mcx], feeds)
        await service.start()

        assert not nse.is_open(AFTER_EQUITY_CLOSE)
        assert mcx.is_open(AFTER_EQUITY_CLOSE), "commodities are still trading"

        for name, task in registry.tasks_for(DayPhase.SESSION_CLOSE, nse.code):
            assert name == "market-data:stop"
            await task(_context(nse, DayPhase.SESSION_CLOSE, AFTER_EQUITY_CLOSE))
        try:
            assert service.is_running, "the feed must survive the equity close"
            assert not feeds[0].closed
        finally:
            await service.stop()

    async def test_the_last_venue_out_stops_the_feed(self, nse: Exchange, mcx: Exchange) -> None:
        after_everything = datetime(2026, 8, 31, 18, 30, tzinfo=UTC)
        clock = ReplayClock(after_everything)
        feeds: list[SilentFeed] = []
        registry, service, _ = self.wire(clock, [nse, mcx], feeds)
        await service.start()

        assert not mcx.is_open(after_everything)
        for _, task in registry.tasks_for(DayPhase.SESSION_CLOSE, mcx.code):
            await task(_context(mcx, DayPhase.SESSION_CLOSE, after_everything))

        assert not service.is_running
        assert feeds[0].closed


def _context(exchange: Exchange, phase: DayPhase, now: datetime) -> PhaseContext:
    return PhaseContext(
        exchange=exchange,
        trading_day=now.astimezone(exchange.timezone).date(),
        phase=phase,
        now=now,
    )
