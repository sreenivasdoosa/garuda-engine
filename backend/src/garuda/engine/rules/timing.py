"""Rules about the clock.

These are what a tranche time becomes. The reference engine had a scheduled
trigger that fired a strategy at 13:00; here the strategy is live all day and
one of its conditions is that the venue clock has reached 13:00. The same
behaviour, expressible alongside every other condition instead of beside them.

**Times are the venue's, not the server's.** A strategy configured for one
o'clock means one o'clock where it trades.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import time

from garuda.domain.errors import DomainError
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed
from garuda.engine.rules.registry import Cost, rule


def _local(context: RuleContext) -> time:
    return context.now.astimezone(context.timezone).timetz().replace(tzinfo=None)


@rule("at_or_after", cost=Cost.FREE)
@dataclass(frozen=True)
class AtOrAfter:
    """The venue clock has reached a time. A tranche time, usually."""

    at: time

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        now = _local(context)
        if now >= self.at:
            return passed(f"{now:%H:%M:%S} is at or after {self.at:%H:%M}", now=now.isoformat())
        return failed(f"{now:%H:%M:%S} is before {self.at:%H:%M}", now=now.isoformat())


@rule("before", cost=Cost.FREE)
@dataclass(frozen=True)
class Before:
    """The venue clock has not yet reached a time. A cutoff."""

    at: time

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        now = _local(context)
        if now < self.at:
            return passed(f"{now:%H:%M:%S} is before {self.at:%H:%M}", now=now.isoformat())
        return failed(f"{now:%H:%M:%S} is at or after {self.at:%H:%M}", now=now.isoformat())


@rule("within_window", cost=Cost.FREE)
@dataclass(frozen=True)
class WithinWindow:
    """Between two times, the end excluded.

    Expressible as an ``all`` of the two above; kept because a window is one
    idea and reads as one line in a configuration.
    """

    start: time
    end: time

    def __post_init__(self) -> None:
        if self.end <= self.start:
            raise DomainError(f"a window from {self.start:%H:%M} to {self.end:%H:%M} is never open")

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        now = _local(context)
        if self.start <= now < self.end:
            return passed(f"{now:%H:%M:%S} is within {self.start:%H:%M} to {self.end:%H:%M}")
        return failed(f"{now:%H:%M:%S} is outside {self.start:%H:%M} to {self.end:%H:%M}")
