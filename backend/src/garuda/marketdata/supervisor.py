"""Keeping a feed connected.

Separate from the hub because reconnection is a policy, not a property of a
connection, and because the two fail in different ways: a hub bug loses ticks,
a supervisor bug loses the feed.

Three things it does that are not obvious from the outside:

**It tears the old connection down before dropping the reference.** The
reference engine did the cheap thing here -- set the reference to null and make
a new one -- and got a zombie: a socket that was not as dead as the disconnect
event claimed, still connected, still consuming the account's single feed
session, still decoding frames for a reader that no longer existed. The new
connection then could not be established, and the symptom was a feed that was
"reconnecting" forever.

**It treats silence as a failure.** A feed can stall with the socket open: no
frames, no error, no disconnect. Every status reads connected and prices
simply stop. Reconnecting on silence is the only thing that recovers it.

**It backs off.** A provider that is down stays down for minutes, and a
reconnect attempt every second during a market open achieves nothing except a
rate limit on the account that needs it most.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta

from garuda.marketdata.hub import TickHub
from garuda.protocols.clock import Clock
from garuda.protocols.feed import MarketDataFeed

logger = logging.getLogger(__name__)

#: Builds a fresh connection. A factory rather than a feed, because recovery
#: means a new connection and not a reset of the old one.
type FeedFactory = Callable[[], Awaitable[MarketDataFeed]]


@dataclass(frozen=True, slots=True)
class ReconnectPolicy:
    """How hard to try, and how quickly to give up trying quickly."""

    initial: timedelta = timedelta(seconds=1)
    maximum: timedelta = timedelta(seconds=30)
    factor: int = 2
    #: Silence longer than this counts as a failure even with the socket open.
    silence_before_reconnect: timedelta = timedelta(seconds=60)

    def __post_init__(self) -> None:
        if self.initial <= timedelta(0) or self.maximum < self.initial:
            raise ValueError("a reconnect delay must be positive and below the maximum")
        if self.factor < 1:
            raise ValueError("a backoff factor below one shortens the wait each time")

    def delay_after(self, failures: int) -> timedelta:
        """The wait before attempt ``failures + 1``."""
        delay: timedelta = self.initial * (self.factor ** max(failures - 1, 0))
        return min(delay, self.maximum)


@dataclass
class SupervisorState:
    consecutive_failures: int = 0
    reconnects: int = 0
    last_attempt_at: datetime | None = None


class FeedSupervisor:
    """Connects a feed, and reconnects it when it stops working."""

    def __init__(
        self,
        hub: TickHub,
        factory: FeedFactory,
        clock: Clock,
        *,
        policy: ReconnectPolicy | None = None,
    ) -> None:
        self._hub = hub
        self._factory = factory
        self._clock = clock
        self._policy = policy or ReconnectPolicy()
        self._feed: MarketDataFeed | None = None
        self.state = SupervisorState()

    @property
    def feed(self) -> MarketDataFeed | None:
        return self._feed

    async def start(self) -> bool:
        """Connect and attach. Returns whether it worked.

        A failure is not raised. The feed being down at nine in the morning is
        a condition to retry, not an exception to unwind the day-init through.
        """
        self.state.last_attempt_at = self._clock.now()
        try:
            feed = await self._factory()
            await feed.connect()
        except Exception as error:
            self.state.consecutive_failures += 1
            logger.warning(
                "feed connect failed (attempt %d): %s: %s",
                self.state.consecutive_failures,
                type(error).__name__,
                error,
            )
            return False

        self._feed = feed
        await self._hub.attach(feed)
        self.state.consecutive_failures = 0
        logger.info(
            "feed %s connected with %d subscriptions", feed.name, len(self._hub.subscriptions)
        )
        return True

    async def stop(self) -> None:
        """Close the connection completely and forget it."""
        self._hub.detach()
        feed, self._feed = self._feed, None
        if feed is None:
            return
        try:
            await feed.close()
        except Exception as error:
            # Logged, not raised: a close that fails must not stop the
            # reconnect it is a step of.
            logger.warning("closing feed %s failed: %s: %s", feed.name, type(error).__name__, error)

    def needs_reconnect(self, now: datetime) -> str | None:
        """Why the feed should be replaced, or None when it is healthy."""
        if self._feed is None:
            return "no feed"
        if not self._feed.is_connected:
            return self._hub.health.last_disconnect_reason or "disconnected"
        age = self._hub.health.age(now)
        if not self._hub.subscriptions:
            return None
        if age is None or age > self._policy.silence_before_reconnect:
            # The socket is open and nothing is arriving. Every status reads
            # connected; only the absence of ticks says otherwise.
            return f"no ticks for {age if age is not None else 'the whole session'}"
        return None

    async def reconcile(self) -> bool:
        """Replace the feed if it needs replacing. Returns whether it did."""
        reason = self.needs_reconnect(self._clock.now())
        if reason is None:
            return False

        logger.warning("replacing feed: %s", reason)
        # Down first, and completely: a half-dead connection left alive holds
        # the account's one feed session and blocks the replacement.
        await self.stop()
        if self.state.consecutive_failures:
            await self._clock.sleep(self._policy.delay_after(self.state.consecutive_failures))
        if await self.start():
            self.state.reconnects += 1
            return True
        return False
