"""The init timeline: what starting up and starting the day did, and how long.

Ported from the reference engine's init status recorder. Two lists in
memory, deliberately not persisted: the **startup** timeline is captured
afresh on every restart, and the **day** timeline is cleared when a new
trading day's DAY_INIT begins. The System Status page shows both, newest
first, so an operator at 08:55 can read which task took four minutes
without opening a log file.

Everything is stamped by the injected clock, never the wall clock: the
timestamps are display only, but a recorder that reads ``datetime.now()``
is one that cannot be replayed.
"""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from enum import StrEnum

from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: A safety cap. Startup and the day's phases are coarse-grained and land far
#: below it; the cap is there so a path that spams events costs a bounded
#: amount of memory rather than a growing one.
MAX_EVENTS_PER_TIMELINE = 500


class TimelinePhase(StrEnum):
    STARTUP = "STARTUP"
    DAY = "DAY"


@dataclass(frozen=True, slots=True)
class TimelineEvent:
    """One line of a timeline: when, and what, in the operator's words."""

    at: datetime
    message: str
    phase: TimelinePhase


@dataclass(frozen=True, slots=True)
class TimelineTask:
    """A begun task; handed back to :meth:`InitTimeline.end`."""

    phase: TimelinePhase
    name: str
    started_at: datetime


def format_duration(elapsed: timedelta) -> str:
    """``523ms`` / ``8s`` / ``1m 28s`` / ``1h 03m``. The reference's format."""
    millis = int(elapsed.total_seconds() * 1000)
    if millis < 1000:
        return f"{millis}ms"
    total_seconds = millis // 1000
    hours, remainder = divmod(total_seconds, 3600)
    minutes, seconds = divmod(remainder, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    if minutes:
        return f"{minutes}m {seconds:02d}s"
    return f"{seconds}s"


class InitTimeline:
    """Records what starting up and starting the day did."""

    def __init__(self, clock: Clock) -> None:
        self._clock = clock
        self._events: dict[TimelinePhase, deque[TimelineEvent]] = {
            phase: deque(maxlen=MAX_EVENTS_PER_TIMELINE) for phase in TimelinePhase
        }

    # -- writing -------------------------------------------------------------

    def begin(self, name: str, *, phase: TimelinePhase = TimelinePhase.STARTUP) -> TimelineTask:
        """Record that a task started, and hand back what :meth:`end` needs."""
        self.record(f"Started {name}", phase=phase)
        return TimelineTask(phase=phase, name=name, started_at=self._clock.now())

    def end(self, task: TimelineTask, detail: str | None = None) -> None:
        """Record that a task finished, with how long it took."""
        elapsed = self._clock.now() - task.started_at
        suffix = f" {detail}" if detail else ""
        self.record(
            f"Finished {task.name}{suffix} -- took {format_duration(elapsed)}",
            phase=task.phase,
        )

    def failed(self, task: TimelineTask, reason: str) -> None:
        """Record that a task did not finish, and why."""
        elapsed = self._clock.now() - task.started_at
        self.record(
            f"Failed {task.name} after {format_duration(elapsed)}: {reason}",
            phase=task.phase,
        )

    def record(self, message: str, *, phase: TimelinePhase = TimelinePhase.STARTUP) -> None:
        """One line, as it happened."""
        event = TimelineEvent(at=self._clock.now(), message=message, phase=phase)
        self._events[phase].append(event)
        logger.info("[%s] %s", phase.value, message)

    def clear_day(self) -> None:
        """Forget the previous day's timeline. Called as a new DAY_INIT begins."""
        self._events[TimelinePhase.DAY].clear()

    # -- reading -------------------------------------------------------------

    def startup_events(self) -> list[TimelineEvent]:
        """Newest first."""
        return list(reversed(self._events[TimelinePhase.STARTUP]))

    def day_events(self) -> list[TimelineEvent]:
        """Newest first."""
        return list(reversed(self._events[TimelinePhase.DAY]))
