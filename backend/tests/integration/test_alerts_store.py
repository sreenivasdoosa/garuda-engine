"""The alert store against a real PostgreSQL.

Coalescing is the claim worth testing against the database rather than in
memory: it is an upsert on a partial unique index, and both halves of that
have to be right or a storm either loses its count or fails to insert at all.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, date, datetime

import pytest

from garuda.domain.alert import Alert, AlertLevel, EntityType
from garuda.persistence import UnitOfWork

pytestmark = pytest.mark.integration

DAY = date(2026, 8, 31)
NEXT_DAY = date(2026, 9, 1)
T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)


def an_alert(
    *,
    key: str | None = "broker-socket:appa",
    message: str = "socket dropped",
    level: AlertLevel = AlertLevel.WARNING,
    day: date = DAY,
    at: datetime = T0,
    occurrences: int = 1,
) -> Alert:
    return Alert(
        level=level,
        entity_type=EntityType.BROKER,
        entity="Appa (ZERODHA:AB1234)",
        operation="reconnect",
        message=message,
        raised_at=at,
        trading_day=day,
        key=key,
        occurrences=occurrences,
    )


class TestCoalescing:
    async def test_a_repeat_advances_the_count_instead_of_adding_a_row(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            for _ in range(50):
                await uow.repositories.alerts.record(an_alert())

        async with UnitOfWork(session_factory) as uow:
            rows = await uow.repositories.alerts.on_day(DAY)
        assert len(rows) == 1
        assert rows[0].occurrences == 50

    async def test_the_first_time_is_kept_and_the_latest_wording_wins(self, session_factory):
        later = datetime(2026, 8, 31, 15, 0, tzinfo=UTC)
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.alerts.record(an_alert())
            await uow.repositories.alerts.record(
                an_alert(message="still down after six hours", at=later)
            )

        async with UnitOfWork(session_factory) as uow:
            (row,) = await uow.repositories.alerts.on_day(DAY)
        assert row.first_raised_at == T0
        assert row.raised_at == later
        assert row.message == "still down after six hours"

    async def test_a_keyless_alert_never_coalesces(self, session_factory):
        """A one-shot event happening twice really is two events."""
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.alerts.record(an_alert(key=None, message="day started"))
            await uow.repositories.alerts.record(an_alert(key=None, message="day started"))

        async with UnitOfWork(session_factory) as uow:
            rows = await uow.repositories.alerts.on_day(DAY)
        assert len(rows) == 2

    async def test_the_same_key_tomorrow_is_a_new_row(self, session_factory):
        """A problem recurring next morning must be seen, not quietly counted."""
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.alerts.record(an_alert())
            await uow.repositories.alerts.record(an_alert(day=NEXT_DAY))

        async with UnitOfWork(session_factory) as uow:
            assert len(await uow.repositories.alerts.on_day(DAY)) == 1
            assert len(await uow.repositories.alerts.on_day(NEXT_DAY)) == 1

    async def test_concurrent_writers_lose_no_occurrences(self, session_factory):
        """The counting exists to survive a storm, so it must survive one."""

        async def raise_ten() -> None:
            async with UnitOfWork(session_factory) as uow:
                for _ in range(10):
                    await uow.repositories.alerts.record(an_alert())

        await asyncio.gather(*(raise_ten() for _ in range(5)))

        async with UnitOfWork(session_factory) as uow:
            (row,) = await uow.repositories.alerts.on_day(DAY)
        assert row.occurrences == 50

    async def test_a_worsening_problem_records_the_higher_level(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.alerts.record(an_alert(level=AlertLevel.WARNING))
            await uow.repositories.alerts.record(an_alert(level=AlertLevel.CRITICAL))

        async with UnitOfWork(session_factory) as uow:
            (row,) = await uow.repositories.alerts.on_day(DAY)
        assert row.level == AlertLevel.CRITICAL.value

    async def test_the_entity_stored_is_the_one_a_person_reads(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.alerts.record(an_alert())

        async with UnitOfWork(session_factory) as uow:
            (row,) = await uow.repositories.alerts.on_day(DAY)
        assert row.entity == "Appa (ZERODHA:AB1234)"
