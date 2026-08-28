"""The journal store contract.

The store appends journal events and replays them. It says nothing about
*where* they go -- that is the persistence layer's business -- but it does fix
the two properties the engine depends on:

1. **An append is atomic with the state change it describes.** The caller
   supplies the transaction; the store joins it. Journal and tables cannot
   diverge from a crash, which is the entire reason the journal is worth
   keeping alongside relational state rather than instead of it.
2. **A replay yields events in the order they were appended**, so folding a
   replay reproduces the state that produced it.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import date
from typing import Protocol, runtime_checkable

from garuda.domain.journal import JournalEvent


@runtime_checkable
class JournalStore(Protocol):
    async def append(self, events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        """Append events, returning them with their assigned sequence numbers.

        Must run inside the caller's transaction. A store that opens its own
        breaks the atomicity the engine relies on.
        """
        ...

    def replay(self, trading_day: date, *, after_sequence: int = 0) -> AsyncIterator[JournalEvent]:
        """Every event for a trading day, in append order."""
        ...

    async def last_sequence(self, trading_day: date) -> int:
        """The highest sequence written for a day, or 0 if none."""
        ...
