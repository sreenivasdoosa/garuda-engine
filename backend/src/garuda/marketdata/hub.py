"""Where every tick arrives, whatever produced it.

The hub owns three things the feed below it deliberately does not:

**What the engine is subscribed to.** The set lives here, not in the
connection, so it survives a reconnection and a change of provider. A feed
that came back up and forgot what it was watching is a strategy that stops
receiving prices while every health check reads green.

**The latest tick per instrument.** Read by anything that needs a price
without waiting for the next one -- the risk gate, square-off, a report. It is
cleared at day-init: the reference engine found stale entries from the day
before still being served the next morning, because nothing had a reason to
expire them.

**Coalescing.** Ticks are staged in a dict keyed by instrument, so a tick that
arrives before the previous one for that instrument has been dispatched
replaces it. Under normal flow the dict holds one entry and nothing is lost;
under a backlog the engine works on current prices instead of falling further
behind on old ones. The reference engine did the same with a bounded queue and
a coalescing pass; a keyed dict cannot overflow in the first place.

Coalescing is safe for what a tick carries because every cumulative field --
volume, open interest, the day's range -- is the exchange's running total as
of that tick, not a delta to be summed.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta

from garuda.core.bus import InProcessEventBus
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.protocols.clock import Clock
from garuda.protocols.feed import (
    FeedConnected,
    FeedDisconnected,
    FeedEvent,
    FeedProblem,
    MarketDataFeed,
    TicksReceived,
)
from garuda.protocols.topics import Topic

logger = logging.getLogger(__name__)

#: How long a subscribed instrument may go without a tick before the hub calls
#: it stale. The reference engine's threshold, and the reason it exists is that
#: a feed can stop delivering without ever disconnecting.
DEFAULT_STALE_AFTER = timedelta(seconds=20)


@dataclass
class FeedHealth:
    """What an operator needs to answer "is the feed alive"."""

    ticks_received: int = 0
    ticks_published: int = 0
    ticks_superseded: int = 0
    unresolved_tokens: int = 0
    last_tick_at: datetime | None = None
    connected_since: datetime | None = None
    last_disconnect_reason: str | None = None

    @property
    def is_connected(self) -> bool:
        return self.connected_since is not None

    def age(self, now: datetime) -> timedelta | None:
        """How long since a tick last reached the engine."""
        if self.last_tick_at is None:
            return None
        return now - self.last_tick_at


@dataclass(frozen=True, slots=True)
class Staleness:
    """Instruments that are subscribed but not ticking."""

    instruments: tuple[InstrumentId, ...] = ()
    #: True when nothing at all has ticked recently, which points at the
    #: connection rather than at any one instrument.
    feed_is_silent: bool = False


class TickHub:
    """Subscriptions, the latest price, and the path from feed to engine."""

    def __init__(
        self,
        bus: InProcessEventBus,
        clock: Clock,
        *,
        stale_after: timedelta = DEFAULT_STALE_AFTER,
    ) -> None:
        self._bus = bus
        self._clock = clock
        self._stale_after = stale_after
        self._feed: MarketDataFeed | None = None
        self._subscriptions: set[InstrumentId] = set()
        self._latest: dict[InstrumentId, Tick] = {}
        self._pending: dict[InstrumentId, Tick] = {}
        self._arrived = asyncio.Event()
        self.health = FeedHealth()

    # -- subscriptions ------------------------------------------------------

    @property
    def subscriptions(self) -> frozenset[InstrumentId]:
        return frozenset(self._subscriptions)

    async def subscribe(self, instruments: Iterable[InstrumentId]) -> None:
        """Record interest, and tell the feed if one is attached.

        Recording comes first. A subscription made while the feed is down is
        not lost; it is applied when the connection returns.
        """
        added = [i for i in instruments if i not in self._subscriptions]
        self._subscriptions.update(added)
        if added and self._feed is not None:
            await self._feed.subscribe(added)

    async def unsubscribe(self, instruments: Iterable[InstrumentId]) -> None:
        removed = [i for i in instruments if i in self._subscriptions]
        self._subscriptions.difference_update(removed)
        if removed and self._feed is not None:
            await self._feed.unsubscribe(removed)

    # -- the feed -----------------------------------------------------------

    async def attach(self, feed: MarketDataFeed) -> None:
        """Point the hub at a connection and restore the subscriptions onto it."""
        self._feed = feed
        if self._subscriptions:
            await feed.subscribe(sorted(self._subscriptions, key=lambda i: i.value))

    def detach(self) -> None:
        self._feed = None

    async def consume(self, events: Sequence[FeedEvent] | None = None) -> None:
        """Fold feed events into the hub.

        Takes a sequence for a test or a driver that already has the events;
        with none, it reads from the attached feed until the feed stops.
        """
        if events is not None:
            for event in events:
                self._apply(event)
            return
        if self._feed is None:
            raise RuntimeError("no feed is attached")
        async for event in self._feed.events():
            self._apply(event)

    def _apply(self, event: FeedEvent) -> None:
        match event:
            case TicksReceived(ticks):
                self._stage(ticks)
            case FeedConnected(at):
                self.health.connected_since = at
                logger.info("feed connected at %s", at.isoformat())
            case FeedDisconnected(reason, at):
                self.health.connected_since = None
                self.health.last_disconnect_reason = reason
                logger.warning("feed disconnected at %s: %s", at.isoformat(), reason)
            case FeedProblem(detail, _):
                self.health.unresolved_tokens += 1
                logger.warning("feed problem: %s", detail)

    def _stage(self, ticks: Sequence[Tick]) -> None:
        for tick in ticks:
            if tick.instrument in self._pending:
                self.health.ticks_superseded += 1
            self._pending[tick.instrument] = tick
            self.health.ticks_received += 1
            self.health.last_tick_at = tick.timestamp
        if ticks:
            self._arrived.set()

    # -- dispatch -----------------------------------------------------------

    async def dispatch_once(self) -> int:
        """Publish the staged ticks, latest per instrument. Returns how many."""
        staged = self._pending
        self._pending = {}
        self._arrived.clear()
        for tick in staged.values():
            self._latest[tick.instrument] = tick
            await self._bus.publish(Topic.TICKS, tick)
        self.health.ticks_published += len(staged)
        return len(staged)

    async def dispatch_forever(self) -> None:
        """Wait for ticks, publish them, repeat.

        The wait is what makes coalescing free: anything that arrives while a
        batch is being published lands in the next one, replacing rather than
        queueing behind its predecessor.
        """
        while True:
            await self._arrived.wait()
            await self.dispatch_once()

    # -- reading ------------------------------------------------------------

    def latest(self, instrument: InstrumentId) -> Tick | None:
        return self._latest.get(instrument)

    def clear_latest(self) -> int:
        """Forget every cached price. Run at day-init.

        Yesterday's last traded price is not today's opening price, and a
        cache with no expiry will happily serve it until the first real tick
        arrives -- which for an illiquid strike may be an hour into the
        session.
        """
        count = len(self._latest)
        self._latest.clear()
        logger.info("cleared %d cached ticks", count)
        return count

    def staleness(self, now: datetime) -> Staleness:
        """Which subscriptions have gone quiet.

        A feed can stall without disconnecting -- no frames, no error, no
        reconnect -- and the only symptom is that prices stop moving while
        every status reads connected. This is how that is noticed.
        """
        cutoff = now - self._stale_after
        stale = tuple(
            sorted(
                (
                    instrument
                    for instrument in self._subscriptions
                    if (tick := self._latest.get(instrument)) is None or tick.timestamp < cutoff
                ),
                key=lambda instrument: instrument.value,
            )
        )
        age = self.health.age(now)
        silent = bool(self._subscriptions) and (age is None or age > self._stale_after)
        return Staleness(instruments=stale, feed_is_silent=silent)
