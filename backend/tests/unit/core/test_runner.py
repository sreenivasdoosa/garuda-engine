"""The engine runner.

The claims are about a process that keeps running across days and restarts,
and about what happens when a phase fails.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from garuda.core.clock import ReplayClock
from garuda.core.runner import (
    EngineRunner,
    InMemoryPhaseRecorder,
    PhaseContext,
    TaskRegistry,
)
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase, PhaseInstant

IST = ZoneInfo("Asia/Kolkata")
MONDAY = date(2026, 8, 31)
DAWN = datetime(2026, 8, 31, 3, 0, tzinfo=IST)
MIDDAY = datetime(2026, 8, 31, 12, 0, tzinfo=IST)


class Recorder(InMemoryPhaseRecorder):
    """Records, and also remembers the order things ran in."""

    def __init__(self) -> None:
        super().__init__()
        self.order: list[tuple[str, DayPhase]] = []

    async def record(self, instant: PhaseInstant, duration_ms: int) -> None:
        self.order.append((instant.exchange, instant.phase))
        await super().record(instant, duration_ms)


def runner(
    exchanges: Sequence[Exchange],
    clock: ReplayClock,
    registry: TaskRegistry | None = None,
    recorder: InMemoryPhaseRecorder | None = None,
) -> EngineRunner:
    return EngineRunner(
        exchanges=exchanges,
        clock=clock,
        registry=registry or TaskRegistry(),
        recorder=recorder or Recorder(),
    )


class TestOnePass:
    async def test_nothing_is_due_before_the_day_begins(self, nse):
        recorder = Recorder()
        result = await runner([nse], ReplayClock(DAWN), recorder=recorder).run_once()
        assert not result.did_anything

    async def test_the_phases_that_have_passed_run(self, nse):
        recorder = Recorder()
        await runner([nse], ReplayClock(MIDDAY), recorder=recorder).run_once()
        phases = {phase for _exchange, phase in recorder.order}
        assert DayPhase.DAY_INIT in phases
        assert DayPhase.SESSION_OPEN in phases
        assert DayPhase.EOD not in phases, "the day is not over"

    async def test_they_run_in_order(self, nse):
        recorder = Recorder()
        await runner([nse], ReplayClock(MIDDAY), recorder=recorder).run_once()
        phases = [phase for _exchange, phase in recorder.order]
        assert phases.index(DayPhase.DAY_INIT) < phases.index(DayPhase.ALGO_START)
        assert phases.index(DayPhase.ALGO_START) < phases.index(DayPhase.SESSION_OPEN)

    async def test_a_second_pass_repeats_nothing(self, nse):
        recorder = Recorder()
        engine = runner([nse], ReplayClock(MIDDAY), recorder=recorder)
        first = await engine.run_once()
        second = await engine.run_once()
        assert first.did_anything
        assert not second.did_anything


class TestCatchingUpAfterDowntime:
    async def test_a_process_that_missed_day_init_still_runs_it(self, nse):
        """Down at 06:15, up at 07:00."""
        recorder = Recorder()
        await runner(
            [nse], ReplayClock(datetime(2026, 8, 31, 7, 0, tzinfo=IST)), recorder=recorder
        ).run_once()
        assert (nse.code, DayPhase.DAY_INIT) in recorder.order

    async def test_a_restart_after_eod_does_not_repeat_it(self, nse):
        """The reference engine keeps this flag in a field and would."""
        recorder = Recorder()
        night = datetime(2026, 8, 31, 23, 0, tzinfo=IST)
        await runner([nse], ReplayClock(night), recorder=recorder).run_once()
        assert (nse.code, DayPhase.EOD) in recorder.order

        recorder.order.clear()
        # A new runner, as after a restart. The recorder is the journal.
        await runner([nse], ReplayClock(night), recorder=recorder).run_once()
        assert recorder.order == []

    async def test_a_late_evening_venue_still_gets_yesterdays_end_of_day(self, mcx):
        """MCX closes at 23:30, so its EOD lands after midnight."""
        recorder = Recorder()
        after_midnight = datetime(2026, 9, 1, 0, 45, tzinfo=IST)
        await runner([mcx], ReplayClock(after_midnight), recorder=recorder).run_once()
        assert (mcx.code, DayPhase.EOD) in recorder.order


class TestVenuesAdvanceIndependently:
    async def test_each_venue_reaches_its_own_phases(self, nse, mcx):
        recorder = Recorder()
        evening = datetime(2026, 8, 31, 17, 0, tzinfo=IST)
        await runner([nse, mcx], ReplayClock(evening), recorder=recorder).run_once()

        nse_phases = {p for e, p in recorder.order if e == nse.code}
        mcx_phases = {p for e, p in recorder.order if e == mcx.code}
        assert DayPhase.SESSION_CLOSE in nse_phases
        assert DayPhase.SESSION_CLOSE not in mcx_phases, "MCX trades until 23:30"

    async def test_a_us_venue_runs_on_its_own_calendar(self, cme):
        recorder = Recorder()
        # Sunday evening in Chicago: Monday's session is opening.
        sunday = datetime(2026, 8, 30, 18, 0, tzinfo=ZoneInfo("America/Chicago"))
        await runner([cme], ReplayClock(sunday), recorder=recorder).run_once()
        assert (cme.code, DayPhase.SESSION_OPEN) in recorder.order


class TestTasks:
    async def test_a_registered_task_runs_at_its_phase(self, nse):
        seen: list[PhaseContext] = []

        async def task(context: PhaseContext) -> None:
            seen.append(context)

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="load-instruments")
        await runner([nse], ReplayClock(MIDDAY), registry=registry).run_once()

        assert len(seen) == 1
        assert seen[0].phase is DayPhase.DAY_INIT
        assert seen[0].exchange is nse
        assert seen[0].trading_day == MONDAY

    async def test_a_task_can_be_scoped_to_one_venue(self, nse, mcx):
        """An instrument download belongs to whichever venue publishes it."""
        seen: list[str] = []

        async def task(context: PhaseContext) -> None:
            seen.append(context.exchange.code)

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="nse-only", exchanges=["NSE"])
        await runner([nse, mcx], ReplayClock(MIDDAY), registry=registry).run_once()
        assert seen == ["NSE"]

    async def test_an_unnamed_task_is_refused(self):
        async def task(context: PhaseContext) -> None:
            return None

        with pytest.raises(DomainError, match="must be named"):
            TaskRegistry().register(DayPhase.EOD, task, name="")

    async def test_a_phase_with_no_tasks_still_completes(self, nse):
        """Otherwise it would be retried forever."""
        recorder = Recorder()
        await runner([nse], ReplayClock(MIDDAY), recorder=recorder).run_once()
        assert recorder.order != []


class TestFailure:
    async def test_a_failing_phase_is_not_recorded_complete(self, nse):
        """A broker unreachable for a minute at day-init must not become a day
        with no instruments."""

        async def task(context: PhaseContext) -> None:
            raise RuntimeError("broker unreachable")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="load-instruments")
        recorder = Recorder()
        engine = runner([nse], ReplayClock(MIDDAY), registry=registry, recorder=recorder)

        result = await engine.run_once()
        assert result.failed
        assert (nse.code, DayPhase.DAY_INIT) not in recorder.order

    async def test_it_is_retried_on_the_next_pass(self, nse):
        attempts: list[int] = []

        async def task(context: PhaseContext) -> None:
            attempts.append(1)
            if len(attempts) == 1:
                raise RuntimeError("transient")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="load-instruments")
        recorder = Recorder()
        engine = runner([nse], ReplayClock(MIDDAY), registry=registry, recorder=recorder)

        await engine.run_once()
        await engine.run_once()
        assert len(attempts) == 2
        assert (nse.code, DayPhase.DAY_INIT) in recorder.order

    async def test_the_reason_is_recorded_with_the_task_name(self, nse):
        async def task(context: PhaseContext) -> None:
            raise ValueError("no session")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="load-instruments")
        recorder = Recorder()
        await runner([nse], ReplayClock(MIDDAY), registry=registry, recorder=recorder).run_once()

        (_instant, reason) = recorder.failures[0]
        assert "load-instruments" in reason
        assert "no session" in reason

    async def test_one_venues_failure_does_not_stop_another(self, nse, mcx):
        async def task(context: PhaseContext) -> None:
            if context.exchange.code == "NSE":
                raise RuntimeError("nse is broken")

        registry = TaskRegistry()
        registry.register(DayPhase.DAY_INIT, task, name="day-init")
        recorder = Recorder()
        await runner(
            [nse, mcx], ReplayClock(MIDDAY), registry=registry, recorder=recorder
        ).run_once()

        assert (mcx.code, DayPhase.DAY_INIT) in recorder.order
        assert (nse.code, DayPhase.DAY_INIT) not in recorder.order


class TestTheLoop:
    async def test_it_keeps_going_until_told_to_stop(self, nse):
        clock = ReplayClock(DAWN)
        engine = runner([nse], clock)
        task = asyncio.create_task(engine.run_forever())
        await asyncio.sleep(0)
        engine.stop()
        await asyncio.wait_for(task, timeout=1)
        assert engine.is_stopping

    async def test_it_sleeps_rather_than_spinning(self, nse):
        """A day with nothing due must not burn a core."""
        clock = ReplayClock(DAWN)
        engine = runner([nse], clock)
        await engine.run_once()
        before = clock.now()
        await engine._sleep_until_next()
        assert clock.now() > before

    async def test_a_runner_with_no_venues_is_refused(self):
        with pytest.raises(DomainError, match="no venues"):
            EngineRunner([], ReplayClock(DAWN), TaskRegistry(), InMemoryPhaseRecorder())
