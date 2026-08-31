"""Which kinds of day a configuration override applies to."""

from __future__ import annotations

from datetime import date, time
from zoneinfo import ZoneInfo

import pytest

from garuda.domain.calendar import Session, TradingCalendar
from garuda.domain.errors import DomainError
from garuda.engine.daycondition import (
    DayCondition,
    conditions_on,
    trading_days_to_expiry,
)

IST = ZoneInfo("Asia/Kolkata")
WEEKDAYS = range(5)

#: A Thursday, and the expiry of the weekly series in these tests.
THURSDAY = date(2026, 9, 3)
WEDNESDAY = date(2026, 9, 2)
TUESDAY = date(2026, 9, 1)
MONDAY = date(2026, 8, 31)
FRIDAY = date(2026, 9, 4)


def calendar(holidays: frozenset[date] = frozenset()) -> TradingCalendar:
    return TradingCalendar(
        name="test",
        timezone=IST,
        weekly={d: (Session(time(9, 15), time(15, 30)),) for d in WEEKDAYS},
        holidays=holidays,
    )


# -- weekdays ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "expected"),
    [
        (MONDAY, DayCondition.MONDAY),
        (TUESDAY, DayCondition.TUESDAY),
        (WEDNESDAY, DayCondition.WEDNESDAY),
        (THURSDAY, DayCondition.THURSDAY),
        (FRIDAY, DayCondition.FRIDAY),
    ],
)
def test_a_day_carries_its_weekday(day: date, expected: DayCondition) -> None:
    assert expected in conditions_on(day, None, calendar())


def test_a_weekend_day_carries_no_weekday_condition() -> None:
    """No venue here trades one, so there is no code for it."""
    saturday = date(2026, 9, 5)

    assert conditions_on(saturday, None, calendar()) == frozenset()


# -- distance to expiry -----------------------------------------------------


def test_expiry_day_is_expiry_day() -> None:
    assert DayCondition.EXPIRY in conditions_on(THURSDAY, THURSDAY, calendar())


def test_the_day_before_expiry() -> None:
    assert DayCondition.ONE_DAY_TO_EXPIRY in conditions_on(WEDNESDAY, THURSDAY, calendar())


def test_two_days_before_expiry() -> None:
    assert DayCondition.TWO_DAYS_TO_EXPIRY in conditions_on(TUESDAY, THURSDAY, calendar())


def test_a_holiday_shortens_the_distance_to_expiry() -> None:
    """The last session before expiry is the day before it, whatever the date
    arithmetic says. Counting calendar days puts the override on a day the
    market is shut, and it silently never applies."""
    shut_on_wednesday = calendar(frozenset({WEDNESDAY}))

    conditions = conditions_on(TUESDAY, THURSDAY, shut_on_wednesday)

    assert DayCondition.ONE_DAY_TO_EXPIRY in conditions
    assert DayCondition.TWO_DAYS_TO_EXPIRY not in conditions


def test_a_weekend_shortens_the_distance_too() -> None:
    monday_expiry = date(2026, 9, 7)

    assert trading_days_to_expiry(FRIDAY, monday_expiry, calendar()) == 1


def test_an_expiry_on_a_day_the_venue_is_shut_still_anchors_the_days_before() -> None:
    """A series can expire on a day the venue does not trade. The sessions
    leading up to it are still the sessions leading up to it."""
    shut_on_thursday = calendar(frozenset({THURSDAY}))

    assert trading_days_to_expiry(WEDNESDAY, THURSDAY, shut_on_thursday) == 1


def test_an_expiry_already_past_is_not_a_distance() -> None:
    assert trading_days_to_expiry(FRIDAY, THURSDAY, calendar()) is None


def test_no_expiry_is_no_distance() -> None:
    assert trading_days_to_expiry(MONDAY, None, calendar()) is None
    assert conditions_on(MONDAY, None, calendar()) == frozenset({DayCondition.MONDAY})


def test_an_expiry_further_out_than_any_override_reaches_is_not_named() -> None:
    """A number is returned only when it means something."""
    far = date(2026, 12, 31)

    assert trading_days_to_expiry(MONDAY, far, calendar()) is None
    assert conditions_on(MONDAY, far, calendar()) == frozenset({DayCondition.MONDAY})


def test_both_conditions_hold_at_once() -> None:
    """An expiry on a Thursday is both, and rows for each are merged rather
    than one winning outright."""
    conditions = conditions_on(THURSDAY, THURSDAY, calendar())

    assert conditions == frozenset({DayCondition.EXPIRY, DayCondition.THURSDAY})


# -- parsing ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("E", DayCondition.EXPIRY),
        ("DT1", DayCondition.ONE_DAY_TO_EXPIRY),
        ("dt1", DayCondition.ONE_DAY_TO_EXPIRY),
        (" TH ", DayCondition.THURSDAY),
    ],
)
def test_a_stored_code_is_read(code: str, expected: DayCondition) -> None:
    assert DayCondition.parse(code) is expected


def test_an_unknown_code_is_refused_not_ignored() -> None:
    """An ignored condition makes its row apply to every day, which is the
    opposite of what it was written to do."""
    with pytest.raises(DomainError, match="is not a day condition"):
        DayCondition.parse("QUARTERLY")
