"""The runner across a restart, against a real database.

The whole reason phase completions go in the journal rather than a field.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.core.clock import ReplayClock
from garuda.core.runner import EngineRunner, PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.journal import JournalEvent
from garuda.domain.phases import DayPhase
from garuda.journal.phases import JournalPhaseRecorder
from garuda.persistence import UnitOfWork

pytestmark = pytest.mark.integration

IST = ZoneInfo("Asia/Kolkata")
MONDAY = date(2026, 8, 31)
MIDDAY = datetime(2026, 8, 31, 12, 0, tzinfo=IST)
NIGHT = datetime(2026, 8, 31, 23, 0, tzinfo=IST)


class DayJournal:
    """Reads and appends one day's events through its own unit of work."""

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory

    async def read(self, trading_day: date) -> Sequence[JournalEvent]:
        async with UnitOfWork(self._session_factory) as uow:
            return [event async for event in uow.journal.replay(trading_day)]

    async def append(self, events: Sequence[JournalEvent]) -> object:
        async with UnitOfWork(self._session_factory) as uow:
            return await uow.journal.append(events)


def build(
    session_factory: async_sessionmaker[AsyncSession],
    exchange: Exchange,
    now: datetime,
    registry: TaskRegistry | None = None,
) -> EngineRunner:
    """A fresh runner, as after a restart. Only the journal carries over."""
    clock = ReplayClock(now)
    return EngineRunner(
        exchanges=[exchange],
        clock=clock,
        registry=registry or TaskRegistry(),
        recorder=JournalPhaseRecorder(DayJournal(session_factory), clock),
    )


class TestAcrossARestart:
    async def test_a_completed_phase_is_not_repeated(self, session_factory, nse):
        first = await build(session_factory, nse, MIDDAY).run_once()
        assert first.did_anything

        # The process dies. A new runner, a new clock, a new recorder.
        second = await build(session_factory, nse, MIDDAY).run_once()
        assert not second.did_anything

    async def test_end_of_day_does_not_run_twice(self, session_factory, nse):
        """Squaring off twice is not harmless."""
        squared_off: list[date] = []

        async def square_off(context: PhaseContext) -> None:
            squared_off.append(context.trading_day)

        registry = TaskRegistry()
        registry.register(DayPhase.EOD, square_off, name="square-off")

        await build(session_factory, nse, NIGHT, registry).run_once()
        await build(session_factory, nse, NIGHT, registry).run_once()
        assert squared_off == [MONDAY]

    async def test_work_missed_while_down_is_caught_up(self, session_factory, nse):
        loaded: list[date] = []

        async def load_instruments(context: PhaseContext) -> None:
            loaded.append(context.trading_day)

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, load_instruments, name="load-instruments")

        # Nothing ran at 06:15; the process comes up at 07:00.
        await build(
            session_factory, nse, datetime(2026, 8, 31, 7, 0, tzinfo=IST), registry
        ).run_once()
        assert loaded == [MONDAY]

    async def test_a_failed_phase_is_retried_after_a_restart(self, session_factory, nse):
        """A broker unreachable at day-init must not cost the whole day."""
        attempts: list[int] = []

        async def flaky(context: PhaseContext) -> None:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("broker unreachable")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, flaky, name="load-instruments")

        await build(session_factory, nse, MIDDAY, registry).run_once()
        await build(session_factory, nse, MIDDAY, registry).run_once()
        assert len(attempts) == 2

    async def test_the_failure_is_in_the_journal_for_later(self, session_factory, nse):
        """Why today's instruments never loaded, answerable months later."""

        async def failing(context: PhaseContext) -> None:
            raise RuntimeError("no session")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, failing, name="load-instruments")
        await build(session_factory, nse, MIDDAY, registry).run_once()

        async with UnitOfWork(session_factory) as uow:
            events = [event async for event in uow.journal.replay(MONDAY)]
        failures = [e for e in events if e.event_type.value == "PHASE_FAILED"]
        assert len(failures) == 1
        assert "load-instruments" in str(failures[0].payload["reason"])

    async def test_each_completion_records_how_long_it_took(self, session_factory, nse):
        await build(session_factory, nse, MIDDAY).run_once()

        async with UnitOfWork(session_factory) as uow:
            events = [event async for event in uow.journal.replay(MONDAY)]
        completions = [e for e in events if e.event_type.value == "PHASE_COMPLETED"]
        assert completions
        assert all("duration_ms" in e.payload for e in completions)


class TestVenuesDoNotShareState:
    async def test_one_venues_completions_do_not_satisfy_another(self, session_factory, nse, mcx):
        await build(session_factory, nse, MIDDAY).run_once()

        clock = ReplayClock(MIDDAY)
        mcx_runner = EngineRunner(
            exchanges=[mcx],
            clock=clock,
            registry=TaskRegistry(),
            recorder=JournalPhaseRecorder(DayJournal(session_factory), clock),
        )
        result = await mcx_runner.run_once()
        assert result.did_anything, "MCX has its own day to get through"
