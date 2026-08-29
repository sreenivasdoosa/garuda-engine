"""The engine runner.

The process that never stops. It does not wait for a market to open and does
not exit when one closes: it advances every venue through its own day, forever.

It is a **reconciler, not a timer**. On every pass it asks, per venue, "which
phases are due and have not run", and does them. That is the same question
after a crash as before one, so a process that was down at 06:15 runs DAY_INIT
when it returns at 07:00, and one restarted after EOD does not repeat EOD. A
timer answers a different question — "did an alarm fire while I was running" —
and gets both of those wrong.

What has run is recorded in the journal rather than in a field, because a field
does not survive the restart it is meant to protect against.
"""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Protocol, runtime_checkable

from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayOffsets, DayPhase, PhaseInstant, due_phases, next_phase_after
from garuda.protocols.clock import Clock

#: How long the runner waits when it has nothing to do and no next phase to
#: sleep until. Long enough not to spin, short enough that a configuration
#: change is picked up the same hour.
IDLE_INTERVAL = timedelta(minutes=15)

#: A pass never sleeps longer than this, however far away the next phase is, so
#: that a venue added at noon is noticed before tomorrow.
MAX_SLEEP = timedelta(minutes=30)


@dataclass(frozen=True, slots=True)
class PhaseContext:
    """What a task is told about the moment it is running in."""

    exchange: Exchange
    trading_day: date
    phase: DayPhase
    now: datetime


type PhaseTask = Callable[[PhaseContext], Awaitable[None]]


@runtime_checkable
class PhaseRecorder(Protocol):
    """Remembers which phases a venue has finished, across restarts."""

    async def completed(self, exchange: str, trading_day: date) -> frozenset[DayPhase]: ...

    async def record(self, instant: PhaseInstant, duration_ms: int) -> None: ...

    async def record_failure(self, instant: PhaseInstant, reason: str) -> None: ...


class InMemoryPhaseRecorder:
    """For tests and for a dry run. Forgets everything on restart, which is
    exactly the behaviour the journal-backed one exists to avoid."""

    def __init__(self) -> None:
        self._done: dict[tuple[str, date], set[DayPhase]] = {}
        self.failures: list[tuple[PhaseInstant, str]] = []

    async def completed(self, exchange: str, trading_day: date) -> frozenset[DayPhase]:
        return frozenset(self._done.get((exchange, trading_day), set()))

    async def record(self, instant: PhaseInstant, duration_ms: int) -> None:  # noqa: ARG002
        self._done.setdefault((instant.exchange, instant.trading_day), set()).add(instant.phase)

    async def record_failure(self, instant: PhaseInstant, reason: str) -> None:
        self.failures.append((instant, reason))


@dataclass
class TaskRegistry:
    """What to run at each phase.

    A task can be registered for every venue or for named ones only — an
    instrument download belongs to whichever venue publishes the master, not
    to all of them.
    """

    _tasks: dict[DayPhase, list[tuple[str, PhaseTask, frozenset[str] | None]]] = field(
        default_factory=dict
    )

    def register(
        self,
        phase: DayPhase,
        task: PhaseTask,
        *,
        name: str,
        exchanges: Sequence[str] | None = None,
    ) -> None:
        if not name:
            raise DomainError("a phase task must be named; the name is what gets logged")
        scope = frozenset(exchanges) if exchanges is not None else None
        self._tasks.setdefault(phase, []).append((name, task, scope))

    def tasks_for(self, phase: DayPhase, exchange: str) -> list[tuple[str, PhaseTask]]:
        return [
            (name, task)
            for name, task, scope in self._tasks.get(phase, [])
            if scope is None or exchange in scope
        ]

    @property
    def phases(self) -> frozenset[DayPhase]:
        return frozenset(self._tasks)


@dataclass(frozen=True)
class PassResult:
    """What one reconciliation pass did."""

    ran: tuple[PhaseInstant, ...] = field(default_factory=tuple)
    failed: tuple[tuple[PhaseInstant, str], ...] = field(default_factory=tuple)

    @property
    def did_anything(self) -> bool:
        return bool(self.ran or self.failed)


class EngineRunner:
    """Advances every venue through its own trading day, continuously."""

    def __init__(
        self,
        exchanges: Sequence[Exchange],
        clock: Clock,
        registry: TaskRegistry,
        recorder: PhaseRecorder,
        *,
        offsets: dict[str, DayOffsets] | None = None,
    ) -> None:
        if not exchanges:
            raise DomainError("the runner has no venues to run")
        self._exchanges = tuple(exchanges)
        self._clock = clock
        self._registry = registry
        self._recorder = recorder
        self._offsets = offsets or {}
        self._stopping = asyncio.Event()

    @property
    def exchanges(self) -> tuple[Exchange, ...]:
        return self._exchanges

    def offsets_for(self, exchange: Exchange) -> DayOffsets:
        return self._offsets.get(exchange.code, DayOffsets())

    # -- one pass -----------------------------------------------------------

    async def run_once(self) -> PassResult:
        """Run whatever is due, for every venue, in phase order."""
        now = self._clock.now()
        ran: list[PhaseInstant] = []
        failed: list[tuple[PhaseInstant, str]] = []

        for exchange in self._exchanges:
            for trading_day in self._days_in_flight(exchange, now):
                done = await self._recorder.completed(exchange.code, trading_day)
                for instant in due_phases(
                    exchange, trading_day, now, done, self.offsets_for(exchange)
                ):
                    outcome = await self._run_phase(exchange, instant)
                    if outcome is None:
                        ran.append(instant)
                    else:
                        failed.append((instant, outcome))
        return PassResult(ran=tuple(ran), failed=tuple(failed))

    async def _run_phase(self, exchange: Exchange, instant: PhaseInstant) -> str | None:
        """Run one phase's tasks. Returns a reason on failure, None on success.

        A phase that raises is **not** recorded complete, so the next pass
        tries it again. Recording it would turn a transient failure — a broker
        unreachable for a minute at day-init — into a day with no instruments.
        """
        context = PhaseContext(
            exchange=exchange,
            trading_day=instant.trading_day,
            phase=instant.phase,
            now=self._clock.now(),
        )
        started = self._clock.now()
        for name, task in self._registry.tasks_for(instant.phase, exchange.code):
            try:
                await task(context)
            except Exception as error:
                reason = f"{name}: {type(error).__name__}: {error}"
                await self._recorder.record_failure(instant, reason)
                return reason

        elapsed = int((self._clock.now() - started).total_seconds() * 1000)
        await self._recorder.record(instant, elapsed)
        return None

    def _days_in_flight(self, exchange: Exchange, now: datetime) -> tuple[date, ...]:
        """The trading days a venue could still owe work for.

        Yesterday as well as today: a venue whose session closed at 23:30 has
        an end-of-day that lands after midnight, and a venue whose day opens
        the previous evening is already working on tomorrow.
        """
        local = now.astimezone(exchange.timezone).date()
        return (local - timedelta(days=1), local, local + timedelta(days=1))

    # -- the loop -----------------------------------------------------------

    async def run_forever(self) -> None:
        """Reconcile, sleep until the next thing is due, repeat."""
        while not self._stopping.is_set():
            await self.run_once()
            await self._sleep_until_next()

    async def _sleep_until_next(self) -> None:
        now = self._clock.now()
        upcoming = [
            instant.at
            for exchange in self._exchanges
            if (instant := next_phase_after(exchange, now, self.offsets_for(exchange))) is not None
        ]
        deadline = min(upcoming) if upcoming else now + IDLE_INTERVAL
        capped = min(deadline, now + MAX_SLEEP)
        await self._clock.sleep_until(max(capped, now))

    def stop(self) -> None:
        self._stopping.set()

    @property
    def is_stopping(self) -> bool:
        return self._stopping.is_set()
