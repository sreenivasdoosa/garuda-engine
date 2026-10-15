"""When each tranche fires.

The reference's `SubscriptionLoader.buildConsolidatedSchedules` and
`TranchScheduler`, as a pure table for one trading day (`STRATEGY_ENGINE.md`
§4). Each strategy's tranches get their configured `tranch_timing` for the
day's conditions; tranches sharing a time and a strategy are consolidated,
so one firing reaches every subscriber at once.

* **A tranche with no timing is not scheduled.** The reference skips it too
  (unless an external signal or a breakout range supplies the time -- the
  first is deferred, the second arrives with breakout watches).
* **A time already past when the day is built is missed, not fired.** A
  restart at 10:00 does not fire the 09:20 tranche; the reference drops past
  times the same way. Catch-up is explicit: :meth:`TrancheSchedule.catch_up`
  re-times missed tranches a minute apart, which is what the reference does
  when a strategy is reactivated with `catch_up_missed_tranches`.
* **Due means at or after its time.** The loop asks every second; a tranche
  fires once and is then marked fired in this table, and its signalled mark
  in the strategy state is what survives a restart.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field, replace

from garuda.domain.errors import DomainError

#: The reference's catch-up spacing for missed tranches.
CATCH_UP_SPACING = dt.timedelta(minutes=1)


@dataclass(frozen=True, slots=True)
class Slot:
    """One tranche of one strategy at one time."""

    strategy: str
    tranche: int
    at: dt.datetime
    cutoff: dt.time | None = None
    fired: bool = False
    missed: bool = False

    @property
    def key(self) -> tuple[str, int]:
        return (self.strategy, self.tranche)


@dataclass(frozen=True, slots=True)
class Unscheduled:
    """A tranche that will not fire today, and why."""

    strategy: str
    tranche: int
    because: str


@dataclass
class TrancheSchedule:
    """One day's tranche times, every strategy."""

    trading_day: dt.date
    slots: list[Slot] = field(default_factory=list)
    unscheduled: list[Unscheduled] = field(default_factory=list)

    @classmethod
    def build(
        cls,
        trading_day: dt.date,
        timezone: dt.tzinfo,
        timings: Mapping[str, Sequence[tuple[int, str | None, str | None]]],
        *,
        now: dt.datetime,
    ) -> TrancheSchedule:
        """``timings`` is, per strategy, each tranche's (number, timing, cutoff)."""
        schedule = cls(trading_day)
        for strategy, tranches in sorted(timings.items()):
            for number, timing, cutoff in tranches:
                text = (timing or "").strip()
                if not text:
                    schedule.unscheduled.append(
                        Unscheduled(strategy, number, "no tranche timing configured")
                    )
                    continue
                at = dt.datetime.combine(trading_day, _clock(strategy, number, text), timezone)
                schedule.slots.append(
                    Slot(
                        strategy=strategy,
                        tranche=number,
                        at=at,
                        cutoff=_clock(strategy, number, cutoff) if cutoff else None,
                        missed=at < now,
                    )
                )
        schedule.slots.sort(key=lambda slot: (slot.at, slot.strategy, slot.tranche))
        return schedule

    def due(self, now: dt.datetime) -> list[Slot]:
        """Slots whose time has come and that have not fired. Marks them fired."""
        ready: list[Slot] = []
        for index, slot in enumerate(self.slots):
            if slot.fired or slot.missed or slot.at > now:
                continue
            self.slots[index] = replace(slot, fired=True)
            ready.append(slot)
        return ready

    def catch_up(self, strategy: str, now: dt.datetime, *, skip: Iterable[int] = ()) -> list[Slot]:
        """Re-time this strategy's missed tranches from now, a minute apart.

        ``skip`` names tranches that already signalled today and must not be
        re-timed. A tranche whose cutoff has passed stays missed.
        """
        skipped = set(skip)
        local = now.astimezone(self.slots[0].at.tzinfo).time() if self.slots else now.time()
        retimed: list[Slot] = []
        offset = 0
        for index, slot in enumerate(self.slots):
            if slot.strategy != strategy or not slot.missed or slot.tranche in skipped:
                continue
            if slot.cutoff is not None and local > slot.cutoff:
                continue
            moved = replace(slot, at=now + CATCH_UP_SPACING * offset, missed=False)
            self.slots[index] = moved
            retimed.append(moved)
            offset += 1
        self.slots.sort(key=lambda slot: (slot.at, slot.strategy, slot.tranche))
        return retimed

    def retry(self, strategy: str, tranche: int, at: dt.datetime) -> Slot:
        """Evaluate a tranche again at ``at``: a breakout range that had not
        closed when the tranche came due. The reference defers such a tranche
        to the range end the same way."""
        slot = Slot(strategy=strategy, tranche=tranche, at=at)
        self.slots.append(slot)
        self.slots.sort(key=lambda each: (each.at, each.strategy, each.tranche))
        return slot

    @property
    def pending(self) -> list[Slot]:
        return [slot for slot in self.slots if not slot.fired and not slot.missed]

    @property
    def fired(self) -> list[Slot]:
        return [slot for slot in self.slots if slot.fired]

    @property
    def missed(self) -> list[Slot]:
        return [slot for slot in self.slots if slot.missed]


def _clock(strategy: str, tranche: int, text: str) -> dt.time:
    try:
        return dt.time.fromisoformat(text.strip())
    except ValueError:
        raise DomainError(
            f"{strategy} tranche {tranche}: {text!r} is not a time of day (HH:MM)"
        ) from None
