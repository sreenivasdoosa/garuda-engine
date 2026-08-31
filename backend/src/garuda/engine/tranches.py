"""When a tranche may go on, and when it has.

A rule set that passes at 13:00:01 passes again at 13:00:02. Something has to
make an entry happen once, and that something is the tranche.

```
WAITING ──rules pass──▶ ARMED ──signals delivered──▶ FIRED
   │                       │
   └───── cutoff ──────────┴──▶ EXPIRED
```

The unit is one **(subscription, tranche, trading day)**. A tranche that has
fired is not evaluated again; one past its cutoff expires, carrying the rule
that was still blocking it — which is the answer to "why did tranche 3 never
go on today", and is otherwise unanswerable after the fact.

**This is the mechanism, and duplicate detection is the backstop.** A position
must not depend on dedup to avoid being taken twice. Dedup catches a race; the
lifecycle is what makes there be no race to catch.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta
from enum import StrEnum

from garuda.domain.calendar import require_aware
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError


class TrancheState(StrEnum):
    WAITING = "WAITING"
    #: Conditions hold and signals have been built, but not yet delivered.
    #: A short-lived state that exists so a crash between the two is visible.
    ARMED = "ARMED"
    FIRED = "FIRED"
    EXPIRED = "EXPIRED"

    @property
    def is_done(self) -> bool:
        return self in (TrancheState.FIRED, TrancheState.EXPIRED)


#: Which moves are allowed. Anything else is a defect, not a decision.
TRANSITIONS: dict[TrancheState, frozenset[TrancheState]] = {
    TrancheState.WAITING: frozenset({TrancheState.ARMED, TrancheState.EXPIRED}),
    TrancheState.ARMED: frozenset({TrancheState.FIRED, TrancheState.EXPIRED}),
    TrancheState.FIRED: frozenset(),
    TrancheState.EXPIRED: frozenset(),
}


@dataclass(frozen=True, slots=True)
class TrancheId:
    """One tranche of one subscription on one day."""

    trading_client: TradingClientId
    strategy: str
    tranche: int
    trading_day: date

    def __post_init__(self) -> None:
        if self.tranche < 0:
            raise DomainError(f"{self.strategy}: tranche {self.tranche} is not a tranche")

    @property
    def key(self) -> str:
        return (
            f"{self.trading_client.value}:{self.strategy}:"
            f"{self.tranche}:{self.trading_day.isoformat()}"
        )


@dataclass(frozen=True, slots=True)
class Tranche:
    """A tranche's progress through the day."""

    id: TrancheId
    state: TrancheState = TrancheState.WAITING
    #: Nothing is attempted before this. A tranche time is a rule, but the
    #: cutoff is a property of the tranche: past it, evaluating is pointless.
    cutoff: datetime | None = None
    #: Why it is not on yet, from the last evaluation. Carried into EXPIRED,
    #: where it becomes the record of what the tranche was waiting for.
    blocked_by: str | None = None
    armed_at: datetime | None = None
    fired_at: datetime | None = None
    #: What was delivered, for the record and for a restart.
    signal_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for moment in (self.cutoff, self.armed_at, self.fired_at):
            if moment is not None:
                require_aware(moment)

    @property
    def is_open(self) -> bool:
        """Whether evaluating this tranche can still achieve anything."""
        return not self.state.is_done

    def has_expired(self, now: datetime) -> bool:
        return self.cutoff is not None and now >= self.cutoff

    # -- moving -------------------------------------------------------------

    def blocked(self, reason: str) -> Tranche:
        """Record what stopped it this time. Not a transition."""
        return replace(self, blocked_by=reason)

    def armed(self, now: datetime, signal_ids: tuple[str, ...]) -> Tranche:
        self._may_become(TrancheState.ARMED)
        if not signal_ids:
            raise DomainError(f"{self.id.key}: arming with no signals would fire nothing")
        return replace(
            self,
            state=TrancheState.ARMED,
            armed_at=now,
            signal_ids=signal_ids,
            blocked_by=None,
        )

    def fired(self, now: datetime) -> Tranche:
        self._may_become(TrancheState.FIRED)
        return replace(self, state=TrancheState.FIRED, fired_at=now)

    def expired(self, now: datetime, reason: str | None = None) -> Tranche:
        """Give up on the day.

        The reason defaults to whatever last blocked it, because that is the
        useful answer and nobody remembers to pass it.
        """
        self._may_become(TrancheState.EXPIRED)
        del now
        return replace(
            self,
            state=TrancheState.EXPIRED,
            blocked_by=reason or self.blocked_by or "the cutoff passed",
        )

    def _may_become(self, wanted: TrancheState) -> None:
        if wanted not in TRANSITIONS[self.state]:
            raise DomainError(f"{self.id.key}: a tranche cannot go from {self.state} to {wanted}")


@dataclass
class TrancheLedger:
    """Every tranche of a trading day, and what became of it.

    Held in memory and written out with the strategy's state, so a restart at
    13:05 does not re-enter a tranche that fired at 13:00.
    """

    trading_day: date
    _tranches: dict[str, Tranche] = field(default_factory=dict)

    def open_for(self, identity: TrancheId, *, cutoff: datetime | None = None) -> Tranche:
        """The tranche's record, created on first sight."""
        if identity.trading_day != self.trading_day:
            raise DomainError(f"{identity.key} is not part of {self.trading_day.isoformat()}")
        existing = self._tranches.get(identity.key)
        if existing is not None:
            return existing
        fresh = Tranche(id=identity, cutoff=cutoff)
        self._tranches[identity.key] = fresh
        return fresh

    def record(self, tranche: Tranche) -> None:
        self._tranches[tranche.id.key] = tranche

    def get(self, identity: TrancheId) -> Tranche | None:
        return self._tranches.get(identity.key)

    def restore(self, tranches: list[Tranche]) -> int:
        """Take back what a previous run recorded."""
        kept = [t for t in tranches if t.id.trading_day == self.trading_day]
        self._tranches.update({t.id.key: t for t in kept})
        return len(kept)

    def expire_due(self, now: datetime) -> list[Tranche]:
        """Close out every open tranche whose cutoff has passed."""
        gone: list[Tranche] = []
        for tranche in list(self._tranches.values()):
            if tranche.is_open and tranche.has_expired(now):
                closed = tranche.expired(now)
                self._tranches[closed.id.key] = closed
                gone.append(closed)
        return gone

    @property
    def open(self) -> list[Tranche]:
        return [tranche for tranche in self._tranches.values() if tranche.is_open]

    @property
    def all(self) -> list[Tranche]:
        return list(self._tranches.values())


def cutoff_at(
    tranche_time: datetime | None, *, after: timedelta, close: datetime | None = None
) -> datetime | None:
    """When a tranche stops being worth attempting.

    ``after`` past its own time, but never past the session close: a tranche
    configured at 15:20 with an hour's grace has twenty minutes, not an hour,
    because the market does not care about the grace.
    """
    if tranche_time is None:
        return close
    latest = tranche_time + after
    return min(latest, close) if close is not None else latest
