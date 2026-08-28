"""Clock implementations.

**This is the only module in the engine permitted to read wall-clock time or
to sleep directly.** ``tools/check_clock_discipline.py`` fails the build on any
other file that does.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
from datetime import UTC, datetime, timedelta

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError


class LiveClock:
    """Real time. What runs in production."""

    def now(self) -> datetime:
        return datetime.now(UTC)

    async def sleep(self, duration: timedelta) -> None:
        if duration.total_seconds() > 0:
            await asyncio.sleep(duration.total_seconds())

    async def sleep_until(self, when: datetime) -> None:
        require_aware(when)
        remaining = (when - self.now()).total_seconds()
        if remaining > 0:
            await asyncio.sleep(remaining)


class ReplayClock:
    """Virtual time, driven by the caller.

    Two modes:

    * **auto-advance** (the default) -- a sleep returns immediately and pulls
      the clock forward to the instant it was waiting for. A recorded day
      replays in seconds, and expiry-day behaviour can be tested without
      waiting for an expiry.
    * **driven** -- a sleep blocks until :meth:`advance_to` passes the instant.
      Waiters wake in timestamp order regardless of the order they slept, which
      is what keeps a replay with several concurrent waiters deterministic.
    """

    def __init__(self, start: datetime, *, auto_advance: bool = True) -> None:
        require_aware(start)
        self._now = start.astimezone(UTC)
        self._auto_advance = auto_advance
        #: (instant, tie-break, future) — the tie-break keeps the heap total,
        #: since futures are not orderable and two sleepers can share an instant.
        self._waiters: list[tuple[datetime, int, asyncio.Future[None]]] = []
        self._sequence = itertools.count()

    def now(self) -> datetime:
        return self._now

    async def sleep(self, duration: timedelta) -> None:
        await self.sleep_until(self._now + duration)

    async def sleep_until(self, when: datetime) -> None:
        require_aware(when)
        target = when.astimezone(UTC)
        if target <= self._now:
            await asyncio.sleep(0)  # still yield, so ordering stays fair
            return
        if self._auto_advance:
            self._now = target
            await asyncio.sleep(0)
            return

        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        heapq.heappush(self._waiters, (target, next(self._sequence), future))
        await future

    async def advance_to(self, when: datetime) -> None:
        """Move the clock forward, waking anything due on the way.

        Waiters fire in timestamp order, each observing the clock at its own
        wake-up instant rather than at the final one -- otherwise a sleeper due
        at 09:20 would read 15:30 and behave differently on replay than it did
        live.

        This is why the method is a coroutine. Resolving a future only
        *schedules* the waiter; it does not resume it. Without yielding to the
        loop between wake-up instants, every waiter would resume after the
        clock had already reached the final target, which is precisely the bug
        this design exists to prevent.

        A waiter that awaits again after waking may of course observe a later
        instant -- one yield carries it to its next suspension point, no
        further.
        """
        require_aware(when)
        target = when.astimezone(UTC)
        if target < self._now:
            raise DomainError(
                f"the clock cannot go backwards: {self._now.isoformat()} -> {target.isoformat()}"
            )
        while self._waiters and self._waiters[0][0] <= target:
            due = self._waiters[0][0]
            self._now = due
            while self._waiters and self._waiters[0][0] == due:
                _, _, future = heapq.heappop(self._waiters)
                if not future.done():
                    future.set_result(None)
            await asyncio.sleep(0)
        self._now = target

    async def advance_by(self, duration: timedelta) -> None:
        await self.advance_to(self._now + duration)

    @property
    def pending_wakeups(self) -> int:
        return len(self._waiters)
