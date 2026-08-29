"""Remembering which phases have run, in the journal.

The runner needs to know what it already did today, and it needs to still know
after a restart. The reference engine keeps that in a field, so restarting
after end-of-day repeats end-of-day — and squaring off twice is not harmless.

The journal already exists, is already partitioned by trading day, and is
already the record of what happened. Putting phase completions in it costs no
new table and buys the audit trail for free: why did today's instruments never
load is answerable months later.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date
from typing import Protocol, runtime_checkable

from garuda.domain.journal import (
    EventType,
    JournalEvent,
    phase_completed,
    phase_failed,
)
from garuda.domain.phases import DayPhase, PhaseInstant
from garuda.protocols.clock import Clock


@runtime_checkable
class DayJournal(Protocol):
    """Reading and appending one trading day's events.

    Narrower than the store: the recorder never replays a stream or asks for a
    sequence number, and a protocol that offers what a caller cannot use is a
    protocol that will eventually be used that way.
    """

    async def read(self, trading_day: date) -> Sequence[JournalEvent]: ...

    async def append(self, events: Sequence[JournalEvent]) -> object: ...


def completed_phases(events: Sequence[JournalEvent], exchange: str) -> frozenset[DayPhase]:
    """Which phases a venue finished, from its day's journal.

    Only completions count. A failure is recorded for the audit trail but
    deliberately leaves the phase outstanding, so the next reconciliation tries
    it again.
    """
    completed: set[DayPhase] = set()
    for event in events:
        if event.event_type is not EventType.PHASE_COMPLETED:
            continue
        if event.aggregate_id != exchange:
            continue
        phase = event.payload.get("phase")
        if isinstance(phase, str):
            completed.add(DayPhase(phase))
    return frozenset(completed)


class JournalPhaseRecorder:
    """A phase recorder backed by the journal.

    Takes a callable that opens a unit of work rather than a session, because
    a phase completion is written after its work commits — a completion inside
    the same transaction as the work would be rolled back with it and the phase
    would rerun, which is right, but a completion committed *before* the work
    would strand it, which is not.
    """

    def __init__(self, journal_for_day: DayJournal, clock: Clock) -> None:
        self._journal_for_day = journal_for_day
        self._clock = clock

    async def completed(self, exchange: str, trading_day: date) -> frozenset[DayPhase]:
        events = await self._read(trading_day)
        return completed_phases(events, exchange)

    async def record(self, instant: PhaseInstant, duration_ms: int) -> None:
        await self._append(
            phase_completed(
                instant.exchange,
                instant.phase.value,
                occurred_at=self._clock.now(),
                trading_day=instant.trading_day,
                duration_ms=duration_ms,
            )
        )

    async def record_failure(self, instant: PhaseInstant, reason: str) -> None:
        await self._append(
            phase_failed(
                instant.exchange,
                instant.phase.value,
                reason,
                occurred_at=self._clock.now(),
                trading_day=instant.trading_day,
            )
        )

    async def _read(self, trading_day: date) -> Sequence[JournalEvent]:
        return await self._journal_for_day.read(trading_day)

    async def _append(self, event: JournalEvent) -> None:
        await self._journal_for_day.append([event])
