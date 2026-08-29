"""The market data service: a feed, kept running, for as long as it should be.

The pieces below it each do one thing -- the feed connects, the hub routes,
the supervisor recovers -- and none of them runs a loop. This owns the loops
and the lifetime, so that starting and stopping market data is one call from
the day model rather than four.

It is idempotent at both ends. The engine advances several venues through
their own days against one connection, so ``start`` is reached more than once
a morning and ``stop`` more than once an evening.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Sequence
from contextlib import suppress
from datetime import timedelta

from garuda.domain.instrument import InstrumentId
from garuda.marketdata.hub import TickHub
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: How often to ask whether the feed still works. The reference engine's
#: cadence. Short, because the answer during a market open is worth having
#: within seconds, and the check itself costs nothing when the feed is healthy.
DEFAULT_MONITOR_INTERVAL = timedelta(seconds=5)


class MarketDataService:
    """Feed, dispatch and recovery, started and stopped as one."""

    def __init__(
        self,
        hub: TickHub,
        supervisor: FeedSupervisor,
        clock: Clock,
        *,
        standing_subscriptions: Callable[[], Sequence[InstrumentId]] | None = None,
        monitor_interval: timedelta = DEFAULT_MONITOR_INTERVAL,
    ) -> None:
        self._hub = hub
        self._supervisor = supervisor
        self._clock = clock
        self._standing = standing_subscriptions
        self._monitor_interval = monitor_interval
        self._tasks: list[asyncio.Task[None]] = []

    @property
    def hub(self) -> TickHub:
        return self._hub

    @property
    def is_running(self) -> bool:
        return bool(self._tasks)

    async def start(self) -> bool:
        """Connect, subscribe to the standing set, and start the loops.

        Returns whether the feed came up. A failure leaves the loops running
        anyway: the monitor is what retries, so a provider that is down at the
        start of the day is recovered from without anything else intervening.
        """
        if self.is_running:
            return self._supervisor.feed is not None

        if self._standing is not None:
            # Resolved now rather than at construction: the index list comes
            # from the instrument master, which does not exist until day-init.
            await self._hub.subscribe(self._standing())

        connected = await self._supervisor.start()
        self._tasks = [
            asyncio.create_task(self._hub.dispatch_forever(), name="tick-dispatch"),
            asyncio.create_task(self._monitor(), name="feed-monitor"),
        ]
        logger.info(
            "market data started: connected=%s subscriptions=%d",
            connected,
            len(self._hub.subscriptions),
        )
        return connected

    async def stop(self) -> None:
        """Stop the loops and close the connection. Safe to call twice."""
        tasks, self._tasks = self._tasks, []
        for task in tasks:
            task.cancel()
        for task in tasks:
            with suppress(asyncio.CancelledError):
                await task
        await self._supervisor.stop()
        logger.info("market data stopped")

    async def _monitor(self) -> None:
        """Ask, on a short cycle, whether the feed still works.

        Reconnection lives in the supervisor; this only decides how often to
        ask. Errors are logged and the loop continues -- a monitor that dies
        on one bad cycle leaves the feed with nothing watching it, which is
        the failure it exists to prevent.
        """
        while True:
            await self._clock.sleep(self._monitor_interval)
            try:
                await self._supervisor.reconcile()
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.error("feed monitor cycle failed: %s: %s", type(error).__name__, error)
