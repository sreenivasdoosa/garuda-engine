"""Which day conditions hold on a trading day.

A strategy's configuration can be overridden for particular kinds of day:
expiry day behaves differently from the day before it, and a Monday may be
configured differently from a Friday. Those overrides are keyed by a short
code, and this decides which codes apply to a given day.

**Distance to expiry is counted in trading days, never calendar days.** If
expiry falls on a Thursday and the Wednesday is a holiday, the day *before*
expiry is the Tuesday. Counting calendar days puts the override on a day the
market is shut, so the configuration silently never applies -- and a strategy
that was meant to trade smaller on the day before expiry trades full size.
"""

from __future__ import annotations

from datetime import date
from enum import StrEnum

from garuda.domain.calendar import TradingCalendar
from garuda.domain.errors import DomainError

#: How far before expiry an override can reach. Past this the distance stops
#: being a meaningful description of the day.
MAX_DAYS_TO_EXPIRY = 5


class DayCondition(StrEnum):
    """A kind of day a strategy can be configured differently for.

    The codes are the reference engine's own, and are stored in configuration
    rows as text. Only ``E`` and ``DT1`` appear in a real configured book; the
    rest are part of the vocabulary and are supported because refusing a code
    the schema documents would be a surprise.
    """

    EXPIRY = "E"
    ONE_DAY_TO_EXPIRY = "DT1"
    TWO_DAYS_TO_EXPIRY = "DT2"
    THREE_DAYS_TO_EXPIRY = "DT3"
    FOUR_DAYS_TO_EXPIRY = "DT4"
    FIVE_DAYS_TO_EXPIRY = "DT5"

    MONDAY = "M"
    TUESDAY = "T"
    WEDNESDAY = "W"
    THURSDAY = "TH"
    FRIDAY = "F"

    @classmethod
    def parse(cls, code: str) -> DayCondition:
        """A stored code, or a refusal.

        Unknown codes are refused rather than ignored. An ignored condition
        makes the row it is on apply to every day, which is the opposite of
        what it was written to do.
        """
        try:
            return cls(code.strip().upper())
        except ValueError:
            raise DomainError(
                f"{code!r} is not a day condition; expected one of "
                f"{', '.join(sorted(c.value for c in cls))}"
            ) from None


#: Weekday number to its code. Saturday and Sunday have none: a venue that
#: trades them would need codes, and none of the venues here do.
_WEEKDAYS: dict[int, DayCondition] = {
    0: DayCondition.MONDAY,
    1: DayCondition.TUESDAY,
    2: DayCondition.WEDNESDAY,
    3: DayCondition.THURSDAY,
    4: DayCondition.FRIDAY,
}

_BY_DISTANCE: dict[int, DayCondition] = {
    0: DayCondition.EXPIRY,
    1: DayCondition.ONE_DAY_TO_EXPIRY,
    2: DayCondition.TWO_DAYS_TO_EXPIRY,
    3: DayCondition.THREE_DAYS_TO_EXPIRY,
    4: DayCondition.FOUR_DAYS_TO_EXPIRY,
    5: DayCondition.FIVE_DAYS_TO_EXPIRY,
}


def conditions_on(
    trading_day: date, expiry: date | None, calendar: TradingCalendar
) -> frozenset[DayCondition]:
    """Every condition that holds on ``trading_day``.

    More than one can hold at once -- an expiry falling on a Thursday is both
    ``E`` and ``TH`` -- and configuration rows for each are merged by
    priority rather than one winning outright.

    ``expiry`` is the expiry of the series the strategy trades, which is the
    strategy's own business: a weekly and a monthly strategy on the same
    underlying are on different days to expiry on the same date.
    """
    conditions: set[DayCondition] = set()

    weekday = _WEEKDAYS.get(trading_day.weekday())
    if weekday is not None:
        conditions.add(weekday)

    distance = trading_days_to_expiry(trading_day, expiry, calendar)
    if distance is not None:
        named = _BY_DISTANCE.get(distance)
        if named is not None:
            conditions.add(named)

    return frozenset(conditions)


def trading_days_to_expiry(
    trading_day: date, expiry: date | None, calendar: TradingCalendar
) -> int | None:
    """Sessions between a day and expiry, counting the day itself as zero.

    None when there is no expiry to count to, when expiry has passed, or when
    it is further away than any override reaches. A number is returned only
    when it means something.

    Counted by walking the calendar, so holidays shorten the distance -- which
    is the point. A day is "one day to expiry" if it is the last session
    before expiry, whatever the date arithmetic says.
    """
    if expiry is None or expiry < trading_day:
        return None
    if expiry == trading_day:
        return 0

    day = trading_day
    for distance in range(1, MAX_DAYS_TO_EXPIRY + 1):
        day = calendar.next_trading_day(day)
        if day >= expiry:
            # ``>=`` rather than ``==`` so an expiry on a holiday still
            # anchors the days before it. A series can expire on a day the
            # venue does not trade; the sessions leading up to it are still
            # the sessions leading up to it.
            return distance
    return None
