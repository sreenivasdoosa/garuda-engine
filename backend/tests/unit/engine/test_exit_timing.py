"""When a position should come off, by the reference's exit modes."""

from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest

from garuda.domain.calendar import Session, TradingCalendar
from garuda.domain.errors import DomainError
from garuda.engine.exit_timing import ExitTiming, exit_at

IST = ZoneInfo("Asia/Kolkata")
WEEKDAYS = {day: (Session(opens=dt.time(9, 15), closes=dt.time(15, 30)),) for day in range(5)}
# 2026-10-15 is a Thursday; the 19th the next Monday; the 20th a holiday.
CALENDAR = TradingCalendar(
    name="NSE", timezone=IST, weekly=WEEKDAYS, holidays=frozenset({dt.date(2026, 10, 20)})
)
TODAY = dt.date(2026, 10, 15)


def timing(**overrides: object) -> ExitTiming:
    values: dict[str, object] = {
        "now": dt.datetime(2026, 10, 15, 9, 30, tzinfo=IST),
        "today": TODAY,
        "timezone": IST,
        "calendar": CALENDAR,
        "market_close": dt.time(15, 30),
        "intraday": False,
        "expiry": dt.date(2026, 10, 22),
        "exit_mode": "SAME_DAY",
        "exit_time": "15:00",
        "exit_days": None,
    }
    values.update(overrides)
    return ExitTiming(**values)  # type: ignore[arg-type]


def at(day: dt.date, hour: int, minute: int) -> dt.datetime:
    return dt.datetime.combine(day, dt.time(hour, minute), IST)


def test_no_mode_means_no_scheduled_exit() -> None:
    assert exit_at(timing(exit_mode=None)) is None


def test_same_day_at_the_configured_time() -> None:
    assert exit_at(timing()) == at(TODAY, 15, 0)


def test_the_default_time_is_twenty_minutes_before_the_close() -> None:
    assert exit_at(timing(exit_time=None)) == at(TODAY, 15, 10)


def test_expiry_mode_exits_on_the_expiry() -> None:
    assert exit_at(timing(exit_mode="EXPIRY")) == at(dt.date(2026, 10, 22), 15, 0)


def test_intraday_always_exits_today() -> None:
    assert exit_at(timing(exit_mode="EXPIRY", intraday=True)) == at(TODAY, 15, 0)


def test_days_from_entry_counts_trading_days_skipping_holidays() -> None:
    # Thu -> Fri 16, Mon 19, (Tue 20 holiday) Wed 21
    assert exit_at(timing(exit_mode="DAYS_FROM_ENTRY", exit_days=3)) == at(
        dt.date(2026, 10, 21), 15, 0
    )


def test_days_from_entry_never_passes_expiry() -> None:
    assert exit_at(timing(exit_mode="DAYS_FROM_ENTRY", exit_days=10)) == at(
        dt.date(2026, 10, 22), 15, 0
    )


def test_dte_counts_back_from_expiry() -> None:
    # expiry Thu 22 -> 1 day before is Wed 21
    assert exit_at(timing(exit_mode="DTE", exit_days=1)) == at(dt.date(2026, 10, 21), 15, 0)


def test_minutes_from_entry_never_passes_the_expiry_close_margin() -> None:
    assert exit_at(timing(exit_mode="MINUTES_FROM_ENTRY", exit_days=45)) == at(TODAY, 10, 15)
    late = timing(
        exit_mode="MINUTES_FROM_ENTRY",
        exit_days=600,
        expiry=TODAY,
        now=at(TODAY, 14, 0),
    )
    assert exit_at(late) == at(TODAY, 15, 25)


def test_a_time_already_past_falls_back_to_the_default_then_tomorrow() -> None:
    past = timing(exit_time="09:20", now=at(TODAY, 10, 0))
    assert exit_at(past) == at(TODAY, 15, 10)
    later = timing(exit_time="09:20", now=at(TODAY, 15, 20))
    assert exit_at(later) == at(dt.date(2026, 10, 16), 15, 10)
    on_expiry = timing(exit_time="09:20", now=at(TODAY, 15, 20), expiry=TODAY)
    assert exit_at(on_expiry) == at(TODAY, 15, 30)


def test_an_unknown_mode_is_refused() -> None:
    with pytest.raises(DomainError):
        exit_at(timing(exit_mode="WHENEVER"))
