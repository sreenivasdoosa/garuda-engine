"""Spacing calls to a provider, so the engine is not the reason one throttles.

Every provider publishes a rate it will tolerate, and exceeding it costs more
than the request saved: brokers answer 429 for a while, and some count it
against the account rather than the connection. The gate below is the port of
the reference market-data service's, with its two decisions kept because both
are deliberate.

**It fails fast rather than queueing.** A quote that waits behind a throttle
arrives after the tick that made it interesting. A caller told "busy" can use
the cached price, skip the poll, or try the next instrument -- all better than
a price that is correct and late. The reference throws `ServerBusyException`
here; this raises :class:`ProviderBusyError`.

**The wait is bounded in width, not only in time.** A burst can park more
callers on the gate than the gate will ever clear, so the number allowed to
wait is capped and the rest are refused immediately. Without that a slow
provider turns into an unbounded pile of pending work, which is how one late
endpoint takes a process down.
"""

from __future__ import annotations

import asyncio
from datetime import timedelta

from garuda.domain.errors import DomainError
from garuda.protocols.clock import Clock

#: How many callers may wait on one gate before the rest are refused outright.
#: Engine-wide rather than per provider: it bounds a resource of this process,
#: not a courtesy to a broker.
DEFAULT_MAX_WAITERS = 32


class ProviderBusyError(DomainError):
    """The provider's rate gate is saturated. Try later, or use a cached price."""


class RateGate:
    """One provider's minimum spacing between calls of one kind.

    Separate instances for quotes and history, because providers price them
    separately and a history sweep must not starve a quote the engine needs to
    size an order.
    """

    def __init__(
        self,
        minimum_interval: timedelta,
        clock: Clock,
        *,
        max_waiters: int = DEFAULT_MAX_WAITERS,
        name: str = "provider",
    ) -> None:
        if minimum_interval < timedelta():
            raise DomainError(f"{name}: a minimum interval cannot be negative")
        self._interval = minimum_interval
        self._clock = clock
        self._max_waiters = max_waiters
        self._name = name
        self._lock = asyncio.Lock()
        self._waiting = 0
        self._last_call: float | None = None

    @property
    def is_open(self) -> bool:
        """True when a call would not have to wait at all."""
        return self._remaining() <= 0

    def _remaining(self) -> float:
        if self._last_call is None or self._interval <= timedelta():
            return 0.0
        elapsed = self._clock.now().timestamp() - self._last_call
        return max(0.0, self._interval.total_seconds() - elapsed)

    async def acquire(self) -> None:
        """Wait out the remaining interval, or refuse.

        Raises :class:`ProviderBusyError` when too many callers are already waiting.
        """
        if self._interval <= timedelta():
            return
        if self._waiting >= self._max_waiters:
            raise ProviderBusyError(
                f"{self._name}: {self._waiting} callers are already waiting on the rate gate; "
                "refusing rather than queueing another"
            )

        self._waiting += 1
        try:
            async with self._lock:
                # Inside the lock: the interval is measured from the last call
                # that actually went out, so two callers cannot both read a
                # stale timestamp and leave together.
                remaining = self._remaining()
                if remaining > 0:
                    await self._clock.sleep(timedelta(seconds=remaining))
                self._last_call = self._clock.now().timestamp()
        finally:
            self._waiting -= 1
