"""Trading calendars.

The cases that matter are the ones where the trading day is not the calendar
date: MCX running past 23:00, and CME opening the previous evening.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from garuda.domain import DomainError, NaiveDatetimeError, Session, TradingCalendar
from tests.conftest import CHICAGO, IST, MUHURAT_DAY, NSE_HOLIDAY


class TestOrdinaryDay:
    def test_an_instant_inside_the_session_belongs_to_that_day(self, nse_calendar):
        noon = datetime(2026, 8, 27, 12, 0, tzinfo=IST)
        assert nse_calendar.trading_day_for(noon) == date(2026, 8, 27)
        assert nse_calendar.is_open(noon)

    def test_the_closing_instant_belongs_to_no_session(self, nse_calendar):
        close = datetime(2026, 8, 27, 15, 30, tzinfo=IST)
        assert not nse_calendar.is_open(close)

    def test_before_the_open_the_day_has_not_started_but_is_still_today(self, nse_calendar):
        early = datetime(2026, 8, 27, 8, 0, tzinfo=IST)
        assert not nse_calendar.is_open(early)
        assert nse_calendar.trading_day_for(early) == date(2026, 8, 27)

    def test_after_the_close_the_next_trading_day_has_begun(self, nse_calendar):
        evening = datetime(2026, 8, 27, 18, 0, tzinfo=IST)
        assert nse_calendar.trading_day_for(evening) == date(2026, 8, 28)

    def test_a_weekend_instant_reports_the_following_monday(self, nse_calendar):
        saturday = datetime(2026, 8, 29, 12, 0, tzinfo=IST)
        assert nse_calendar.trading_day_for(saturday) == date(2026, 8, 31)


class TestEveningSession:
    """MCX trades until 23:30 IST. The trading day does not end in the afternoon."""

    def test_an_instant_at_2300_still_belongs_to_the_same_day(self, mcx_calendar):
        late = datetime(2026, 8, 27, 23, 0, tzinfo=IST)
        assert mcx_calendar.is_open(late)
        assert mcx_calendar.trading_day_for(late) == date(2026, 8, 27)

    def test_the_same_instant_is_closed_on_a_daytime_only_venue(self, nse_calendar):
        late = datetime(2026, 8, 27, 23, 0, tzinfo=IST)
        assert not nse_calendar.is_open(late)

    def test_after_the_evening_close_the_next_day_has_begun(self, mcx_calendar):
        after = datetime(2026, 8, 27, 23, 45, tzinfo=IST)
        assert mcx_calendar.trading_day_for(after) == date(2026, 8, 28)


class TestSessionOpeningThePreviousEvening:
    """CME: Monday's business opens 17:00 Sunday in Chicago."""

    def test_sunday_evening_belongs_to_monday(self, cme_calendar):
        sunday_evening = datetime(2026, 8, 30, 18, 0, tzinfo=CHICAGO)
        assert cme_calendar.is_open(sunday_evening)
        assert cme_calendar.trading_day_for(sunday_evening) == date(2026, 8, 31)

    def test_sunday_is_not_itself_a_trading_day(self, cme_calendar):
        assert not cme_calendar.is_trading_day(date(2026, 8, 30))

    def test_monday_morning_belongs_to_monday(self, cme_calendar):
        monday = datetime(2026, 8, 31, 9, 0, tzinfo=CHICAGO)
        assert cme_calendar.trading_day_for(monday) == date(2026, 8, 31)

    def test_the_session_spans_midnight(self, cme_calendar):
        (window,) = cme_calendar.windows_on(date(2026, 8, 31))
        assert window.start.date() == date(2026, 8, 30)
        assert window.end.date() == date(2026, 8, 31)
        assert window.end - window.start == timedelta(hours=23)


class TestDaylightSaving:
    """US clocks move on 2026-03-08. The venue keeps a 23-hour session either side."""

    def test_the_session_length_is_unchanged_across_the_transition(self, cme_calendar):
        before = cme_calendar.windows_on(date(2026, 3, 6))[0]
        after = cme_calendar.windows_on(date(2026, 3, 9))[0]
        assert before.end - before.start == timedelta(hours=23)
        assert after.end - after.start == timedelta(hours=23)

    def test_the_utc_offset_actually_changes(self, cme_calendar):
        """Proves the calendar resolves a real zone, not a fixed offset."""
        before = cme_calendar.windows_on(date(2026, 3, 6))[0]
        after = cme_calendar.windows_on(date(2026, 3, 9))[0]
        assert before.start.utcoffset() != after.start.utcoffset()

    def test_the_same_wall_clock_time_maps_to_different_instants(self, cme_calendar):
        before = cme_calendar.windows_on(date(2026, 3, 6))[0]
        after = cme_calendar.windows_on(date(2026, 3, 9))[0]
        assert before.start.hour == after.start.hour == 17
        assert before.start.astimezone(ZoneInfo("UTC")).hour == 23
        assert after.start.astimezone(ZoneInfo("UTC")).hour == 22


class TestHolidaysAndSpecialDays:
    def test_a_weekday_holiday_is_not_a_trading_day(self, nse_calendar):
        assert NSE_HOLIDAY.weekday() == 0, "the fixture must be a weekday to be meaningful"
        assert not nse_calendar.is_trading_day(NSE_HOLIDAY)

    def test_navigation_skips_the_holiday_and_the_weekend(self, nse_calendar):
        friday = date(2026, 1, 23)
        assert nse_calendar.next_trading_day(friday) == date(2026, 1, 27)
        assert nse_calendar.previous_trading_day(date(2026, 1, 27)) == friday

    def test_a_special_session_beats_both_the_holiday_and_the_weekly_schedule(self, nse_calendar):
        """Diwali muhurat: an evening session on a Sunday that is also a holiday."""
        assert MUHURAT_DAY.weekday() == 6
        assert MUHURAT_DAY in nse_calendar.holidays
        assert nse_calendar.is_trading_day(MUHURAT_DAY)
        assert nse_calendar.sessions_on(MUHURAT_DAY) == (Session(time(18, 15), time(19, 15)),)

    def test_the_muhurat_session_is_open_at_its_own_hour(self, nse_calendar):
        assert nse_calendar.is_open(datetime(2026, 11, 8, 18, 30, tzinfo=IST))
        assert not nse_calendar.is_open(datetime(2026, 11, 8, 12, 0, tzinfo=IST))

    def test_trading_days_between_excludes_closures(self, nse_calendar):
        days = nse_calendar.trading_days_between(date(2026, 1, 23), date(2026, 1, 28))
        assert days == [date(2026, 1, 23), date(2026, 1, 27), date(2026, 1, 28)]


class TestLastCompletedTradingDay:
    def test_after_the_close_it_is_today(self, nse_calendar):
        evening = datetime(2026, 8, 27, 18, 0, tzinfo=IST)
        assert nse_calendar.last_completed_trading_day(evening) == date(2026, 8, 27)

    def test_during_the_session_it_is_the_day_before(self, nse_calendar):
        midday = datetime(2026, 8, 27, 12, 0, tzinfo=IST)
        assert nse_calendar.last_completed_trading_day(midday) == date(2026, 8, 26)

    def test_it_differs_from_the_trading_day_after_the_close(self, nse_calendar):
        """The distinction the two methods exist for."""
        evening = datetime(2026, 8, 27, 18, 0, tzinfo=IST)
        assert nse_calendar.trading_day_for(evening) == date(2026, 8, 28)
        assert nse_calendar.last_completed_trading_day(evening) == date(2026, 8, 27)


class TestRejections:
    def test_a_naive_datetime_is_refused(self, nse_calendar):
        with pytest.raises(NaiveDatetimeError):
            nse_calendar.trading_day_for(datetime(2026, 8, 27, 12, 0))  # noqa: DTZ001

    def test_a_session_ending_before_it_starts_is_refused(self):
        with pytest.raises(DomainError):
            Session(time(15, 30), time(9, 15))

    def test_a_session_spanning_midnight_must_say_so(self):
        Session(time(17, 0), time(16, 0), opens_previous_day=True)

    def test_a_calendar_that_never_opens_cannot_answer(self):
        empty = TradingCalendar(name="Nowhere", timezone=IST, weekly={})
        with pytest.raises(DomainError, match="misconfigured"):
            empty.trading_day_for(datetime(2026, 8, 27, 12, 0, tzinfo=IST))
