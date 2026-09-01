"""Event days: trading a fraction of normal size on a named date.

Results, policy decisions, an election. The venue is open and the strategy
would trade, but the operator wants less on the table. An event day says how
much less, for one exchange on one date, and a strategy may override it.

**The figure scales lots, not capital.** Halving the capital handed to an
allocator does not halve its answer -- a risk-aware allocator sizes off the
stop distance, and a fixed allocator ignores capital entirely. Scaling the
lots it returned is the only reading of "50%" that means half the size for
every allocator, which is what an operator setting 50% means.

Resolution order, highest first:

1. a **strategy** override for that date and exchange
2. the **event day** for that date and exchange
3. otherwise 100% -- no event day, trade normally

The reference engine had two more levels between those, per user and per
product. There is one operator here, so a per-user override is an override of
yourself; and product is not a scope a strategy is configured against.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from fractions import Fraction

from garuda.domain.errors import DomainError

#: No event day, or one that states no figure.
FULL_SIZE = Decimal(100)


def _checked(percentage: Decimal, what: str) -> Decimal:
    if percentage < 0:
        raise DomainError(f"{what}: capital percentage {percentage} is negative")
    if percentage > FULL_SIZE:
        # Above 100 would size *up* on a day the operator flagged as risky,
        # which is the opposite of what this table is for.
        raise DomainError(f"{what}: capital percentage {percentage} is above 100")
    return percentage


@dataclass(frozen=True, slots=True)
class EventDay:
    """One exchange, one date, and how much of normal size to trade."""

    date: date
    exchange: str
    capital_percentage: Decimal
    name: str | None = None

    def __post_init__(self) -> None:
        _checked(self.capital_percentage, f"{self.exchange} on {self.date}")


@dataclass(frozen=True, slots=True)
class StrategyEventDay:
    """One strategy's own figure for an event day."""

    strategy: str
    date: date
    exchange: str
    capital_percentage: Decimal

    def __post_init__(self) -> None:
        _checked(self.capital_percentage, f"{self.strategy} on {self.date}")


@dataclass(frozen=True)
class EventDays:
    """Every event day and override, indexed for the question the engine asks.

    Built once per day by the composition root and treated as immutable; the
    engine asks it per leg, so the lookup is a dict hit rather than a query.
    """

    days: Mapping[tuple[date, str], EventDay] = field(default_factory=dict)
    overrides: Mapping[tuple[str, date, str], StrategyEventDay] = field(default_factory=dict)

    @classmethod
    def of(
        cls,
        days: tuple[EventDay, ...] = (),
        overrides: tuple[StrategyEventDay, ...] = (),
    ) -> EventDays:
        return cls(
            days={(day.date, day.exchange): day for day in days},
            overrides={(o.strategy, o.date, o.exchange): o for o in overrides},
        )

    def percentage_for(self, day: date, exchange: str, strategy: str) -> Decimal:
        """How much of normal size to trade. 100 when nothing applies."""
        override = self.overrides.get((strategy, day, exchange))
        if override is not None:
            return override.capital_percentage
        event = self.days.get((day, exchange))
        if event is not None:
            return event.capital_percentage
        return FULL_SIZE

    def scale_for(self, day: date, exchange: str, strategy: str) -> Fraction:
        """The same answer as a factor to multiply lots by.

        A `Fraction` rather than a float: 60% of five lots is a question about
        trading, and a float would make it a question about binary
        representation.
        """
        return Fraction(self.percentage_for(day, exchange, strategy)) / 100

    def reason_for(self, day: date, exchange: str, strategy: str) -> str | None:
        """Why size was reduced, for the log and the journal. None when it was
        not."""
        override = self.overrides.get((strategy, day, exchange))
        if override is not None:
            named = self.days.get((day, exchange))
            event = f" ({named.name})" if named is not None and named.name else ""
            return (
                f"event day {day}{event} on {exchange}: {strategy} is configured for "
                f"{override.capital_percentage:g}% of normal size"
            )
        event_day = self.days.get((day, exchange))
        if event_day is not None:
            title = f" ({event_day.name})" if event_day.name else ""
            return (
                f"event day {day}{title} on {exchange}: "
                f"{event_day.capital_percentage:g}% of normal size"
            )
        return None


#: What an engine built without event-day configuration uses. Every date is
#: full size, so nothing has to check for None.
NO_EVENT_DAYS = EventDays()
