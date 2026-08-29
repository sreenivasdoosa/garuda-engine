"""How hard to retry a connection, and how quickly to stop trying hard.

Shared by everything that reconnects. A provider that is down stays down for
minutes, and an attempt every second during a market open achieves nothing
except a rate limit on the account that needs it most.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from garuda.domain.errors import DomainError


@dataclass(frozen=True, slots=True)
class ReconnectPolicy:
    initial: timedelta = timedelta(seconds=1)
    maximum: timedelta = timedelta(seconds=30)
    factor: int = 2
    #: Silence longer than this counts as a failure even with the socket open.
    #: A feed can stall without disconnecting: no frames, no error, every
    #: status green, and prices simply stop.
    silence_before_reconnect: timedelta = timedelta(seconds=60)

    def __post_init__(self) -> None:
        if self.initial <= timedelta(0) or self.maximum < self.initial:
            raise DomainError("a reconnect delay must be positive and below the maximum")
        if self.factor < 1:
            raise DomainError("a backoff factor below one shortens the wait each time")

    def delay_after(self, failures: int) -> timedelta:
        """The wait before attempt ``failures + 1``."""
        delay: timedelta = self.initial * (self.factor ** max(failures - 1, 0))
        return min(delay, self.maximum)
