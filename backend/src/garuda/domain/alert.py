"""Alerts: the things an operator has to be told about.

Distinct from logging. A log line is for someone already looking; an alert is
what makes them look. Everything here ends up in front of a person, which
drives two rules that are easy to get wrong and expensive to retrofit.

**An alert names things the way a person does.** The operator does not know
what ``a3f9c2`` is. They know "Appa (ZERODHA:AB1234)" and "NIFTY26AUG25000CE".
Internal identifiers belong in the log line beside the alert, never in the
alert itself -- an alert nobody can act on without a database query is not an
alert.

**Repetition is counted, not repeated.** A socket that flaps two hundred times
overnight must produce one alert saying it happened two hundred times, not two
hundred alerts burying everything else. That is what ``key`` is for: alerts
sharing a key on the same trading day are the same alert, and the second one
advances a count rather than adding a row. The reference engine learned this
the hard way; without it the first bad night makes the alert list useless.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from datetime import date, datetime
from enum import StrEnum

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError


class AlertLevel(StrEnum):
    """How much of the operator's attention this deserves."""

    #: Worth knowing, nothing is wrong. A login succeeded, a day started.
    INFO = "INFO"
    #: Something is degraded but trading continues. A feed reconnected, one
    #: account could not log in.
    WARNING = "WARNING"
    #: Money is at risk or trading has stopped. An order was rejected, a
    #: position does not match the broker's, a session expired mid-session.
    CRITICAL = "CRITICAL"

    @property
    def demands_attention(self) -> bool:
        return self is not AlertLevel.INFO


class EntityType(StrEnum):
    """What the alert is about, so the Console can group and filter."""

    SYSTEM = "SYSTEM"
    BROKER = "BROKER"
    FEED = "FEED"
    ORDER = "ORDER"
    POSITION = "POSITION"
    TRADE = "TRADE"
    STRATEGY = "STRATEGY"
    RISK = "RISK"


@dataclass(frozen=True, slots=True)
class Alert:
    """One thing worth telling the operator, however many times it happened."""

    level: AlertLevel
    entity_type: EntityType
    #: **Human-readable.** A display name, a trading symbol, a strategy's name
    #: -- what the operator would call it. Never an internal id.
    entity: str
    #: A short verb-ish label: "login", "reconnect", "rejected". Groups alerts
    #: of the same kind across entities.
    operation: str
    message: str
    raised_at: datetime
    trading_day: date
    #: Alerts sharing a key on the same trading day are the same alert. None
    #: means every occurrence stands alone, which is right for genuinely
    #: one-shot events.
    key: str | None = None
    first_raised_at: datetime | None = None
    occurrences: int = 1

    def __post_init__(self) -> None:
        require_aware(self.raised_at)
        if not self.entity.strip():
            raise DomainError("an alert must name what it is about, readably")
        if not self.message.strip():
            raise DomainError(f"{self.entity}: an alert with no message tells nobody anything")
        if self.occurrences < 1:
            raise DomainError(f"{self.entity}: an alert that happened {self.occurrences} times")
        if self.first_raised_at is not None:
            require_aware(self.first_raised_at)

    @property
    def began_at(self) -> datetime:
        return self.first_raised_at or self.raised_at

    @property
    def is_repeat(self) -> bool:
        return self.occurrences > 1

    def merged_with(self, later: Alert) -> Alert:
        """Fold a repeat into this alert.

        The message becomes the latest one, because the most recent wording of
        a recurring problem is the informative one -- a reconnect that has been
        failing for an hour says something different on the fiftieth attempt
        than it did on the first.
        """
        if self.key is None or self.key != later.key:
            raise DomainError("alerts without a shared key are not the same alert")
        return replace(
            self,
            level=max(self.level, later.level, key=_severity),
            message=later.message,
            raised_at=later.raised_at,
            first_raised_at=self.began_at,
            occurrences=self.occurrences + later.occurrences,
        )

    def describe(self) -> str:
        """One line, as a person reads it."""
        suffix = f" (x{self.occurrences})" if self.is_repeat else ""
        return (
            f"[{self.level}] {self.entity_type} {self.entity} — "
            f"{self.operation}: {self.message}{suffix}"
        )


_SEVERITY: dict[AlertLevel, int] = {
    AlertLevel.INFO: 0,
    AlertLevel.WARNING: 1,
    AlertLevel.CRITICAL: 2,
}


def _severity(level: AlertLevel) -> int:
    return _SEVERITY[level]
