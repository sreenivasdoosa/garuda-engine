"""The clock contract.

Everything that needs the time or wants to wait goes through this. Nothing in
the engine calls ``datetime.now()`` or ``asyncio.sleep()`` directly -- a lint
rule enforces it, because a single direct read makes a recorded journal replay
differently from the run that produced it, and the divergence surfaces as an
unexplained P&L difference rather than as an error.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Protocol, runtime_checkable


@runtime_checkable
class Clock(Protocol):
    """Time, abstracted so it can be replayed."""

    def now(self) -> datetime:
        """The current instant, timezone-aware and in UTC."""
        ...

    async def sleep(self, duration: timedelta) -> None:
        """Wait for a duration."""
        ...

    async def sleep_until(self, when: datetime) -> None:
        """Wait until an instant. Returns immediately if it has passed."""
        ...
