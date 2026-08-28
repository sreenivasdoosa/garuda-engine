"""The journal store, on PostgreSQL.

Deliberately takes a session rather than an engine. The append must run inside
the caller's transaction, alongside the state change it describes; a store that
opened its own connection would let the journal commit while the state change
rolled back, which is the exact failure the journal exists to make impossible.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import date

from sqlalchemy import func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession

from garuda.domain.journal import (
    Actor,
    AggregateType,
    EventType,
    JournalEvent,
    Payload,
)
from garuda.persistence.models import EventJournalRow


class PostgresJournalStore:
    """Appends and replays journal events within a caller-owned transaction."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def append(self, events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        """Insert events, returning them with their assigned sequence numbers.

        No commit here. The caller's unit of work decides when the transaction
        ends, which is what keeps the append atomic with the state change.
        """
        if not events:
            return []

        statement = (
            insert(EventJournalRow)
            .values(
                [
                    {
                        "trading_day": event.trading_day,
                        "event_type": event.event_type.value,
                        "aggregate_type": event.aggregate_type.value,
                        "aggregate_id": event.aggregate_id,
                        "occurred_at": event.occurred_at,
                        "actor": event.actor.value,
                        "payload": dict(event.payload),
                        "correlation_id": event.correlation_id,
                    }
                    for event in events
                ]
            )
            .returning(EventJournalRow.sequence)
        )
        result = await self._session.execute(statement)
        sequences = list(result.scalars())
        return [event.with_sequence(seq) for event, seq in zip(events, sequences, strict=True)]

    async def replay(
        self, trading_day: date, *, after_sequence: int = 0
    ) -> AsyncIterator[JournalEvent]:
        """Every event for a trading day, in append order."""
        statement = (
            select(EventJournalRow)
            .where(
                EventJournalRow.trading_day == trading_day,
                EventJournalRow.sequence > after_sequence,
            )
            .order_by(EventJournalRow.sequence)
        )
        result = await self._session.stream_scalars(statement)
        async for row in result:
            yield _to_event(row)

    async def last_sequence(self, trading_day: date) -> int:
        statement = select(func.coalesce(func.max(EventJournalRow.sequence), 0)).where(
            EventJournalRow.trading_day == trading_day
        )
        return int((await self._session.execute(statement)).scalar_one())


def _to_event(row: EventJournalRow) -> JournalEvent:
    payload: Payload = dict(row.payload)  # type: ignore[arg-type]
    return JournalEvent(
        event_type=EventType(row.event_type),
        aggregate_type=AggregateType(row.aggregate_type),
        aggregate_id=row.aggregate_id,
        occurred_at=row.occurred_at,
        trading_day=row.trading_day,
        actor=Actor(row.actor),
        payload=payload,
        correlation_id=row.correlation_id,
        sequence=row.sequence,
    )
