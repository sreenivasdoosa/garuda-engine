"""The trading day, per venue.

The claims that matter are about two venues in different phases at the same
moment, and about a process that was not running when a phase came due.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from garuda.core.phases import (
    DayOffsets,
    DayPhase,
    PhaseInstant,
    due_phases,
    next_phase_after,
    offsets_from_exchange_row,
    schedule_for,
)
from garuda.domain.errors import DomainError

IST = ZoneInfo("Asia/Kolkata")
CHICAGO = ZoneInfo("America/Chicago")
MONDAY = date(2026, 8, 31)


def at(schedule: Sequence[PhaseInstant], phase: DayPhase) -> datetime:
    return next(instant.at for instant in schedule if instant.phase is phase)


class TestAnOrdinaryDay:
    def test_every_phase_is_present(self, nse):
        phases = {instant.phase for instant in schedule_for(nse, MONDAY)}
        assert phases == set(DayPhase)

    def test_phases_come_in_order(self, nse):
        schedule = schedule_for(nse, MONDAY)
        assert [instant.at for instant in schedule] == sorted(instant.at for instant in schedule)

    def test_the_day_is_initialised_before_the_engine_trades_it(self, nse):
        schedule = schedule_for(nse, MONDAY)
        assert at(schedule, DayPhase.DAY_INIT) < at(schedule, DayPhase.ALGO_START)
        assert at(schedule, DayPhase.ALGO_START) < at(schedule, DayPhase.SESSION_OPEN)

    def test_intraday_positions_close_before_the_exchange_does(self, nse):
        """Otherwise the exchange closes them at a price nobody chose."""
        schedule = schedule_for(nse, MONDAY)
        assert at(schedule, DayPhase.INTRADAY_SQUARE_OFF) < at(schedule, DayPhase.SESSION_CLOSE)

    def test_reports_and_eod_follow_the_close(self, nse):
        schedule = schedule_for(nse, MONDAY)
        close = at(schedule, DayPhase.SESSION_CLOSE)
        assert close < at(schedule, DayPhase.REPORTS) < at(schedule, DayPhase.EOD)

    def test_the_instants_are_in_the_venues_own_zone(self, nse):
        schedule = schedule_for(nse, MONDAY)
        opens = at(schedule, DayPhase.SESSION_OPEN).astimezone(IST)
        assert (opens.hour, opens.minute) == (9, 15)

    def test_a_holiday_has_no_phases_at_all(self, nse):
        """Not a day-init that quietly initialises nothing."""
        from tests.conftest import NSE_HOLIDAY

        assert schedule_for(nse, NSE_HOLIDAY) == ()


class TestVenuesAreIndependent:
    def test_two_venues_reach_the_same_phase_at_different_moments(self, nse, mcx):
        """MCX trades until 23:30; NSE closes at 15:30."""
        nse_eod = at(schedule_for(nse, MONDAY), DayPhase.EOD)
        mcx_eod = at(schedule_for(mcx, MONDAY), DayPhase.EOD)
        assert mcx_eod > nse_eod

    def test_one_venue_is_in_eod_while_another_still_trades(self, nse, mcx):
        """There is no global 'the market is open'."""
        evening = datetime(2026, 8, 31, 17, 0, tzinfo=IST)
        nse_done = {i.phase for i in due_phases(nse, MONDAY, evening, frozenset())}
        mcx_done = {i.phase for i in due_phases(mcx, MONDAY, evening, frozenset())}
        assert DayPhase.SESSION_CLOSE in nse_done
        assert DayPhase.SESSION_CLOSE not in mcx_done

    def test_a_venue_in_another_country_needs_no_code(self, cme):
        """Its day opens the previous evening in Chicago, and that is data."""
        schedule = schedule_for(cme, MONDAY)
        opens = at(schedule, DayPhase.SESSION_OPEN).astimezone(CHICAGO)
        assert opens.date() == date(2026, 8, 30)
        assert opens.hour == 17

    def test_the_us_venue_initialises_before_its_own_open_not_indias(self, cme):
        schedule = schedule_for(cme, MONDAY)
        init = at(schedule, DayPhase.DAY_INIT).astimezone(CHICAGO)
        assert init < at(schedule, DayPhase.SESSION_OPEN).astimezone(CHICAGO)
        assert init.date() == date(2026, 8, 30)


class TestCatchingUp:
    """A scheduler that reconciles rather than one that fires timers."""

    def test_nothing_is_due_before_the_day_starts(self, nse):
        dawn = datetime(2026, 8, 31, 3, 0, tzinfo=IST)
        assert due_phases(nse, MONDAY, dawn, frozenset()) == ()

    def test_a_phase_whose_moment_has_passed_is_due(self, nse):
        seven = datetime(2026, 8, 31, 7, 0, tzinfo=IST)
        assert DayPhase.DAY_INIT in {i.phase for i in due_phases(nse, MONDAY, seven, frozenset())}

    def test_a_process_that_was_down_catches_up_when_it_returns(self, nse):
        """Down at 06:15, up at 07:00 — day-init still runs."""
        late = datetime(2026, 8, 31, 7, 0, tzinfo=IST)
        due = due_phases(nse, MONDAY, late, frozenset())
        assert DayPhase.DAY_INIT in {instant.phase for instant in due}

    def test_a_completed_phase_is_not_due_again(self, nse):
        """A restart after EOD must not square off twice."""
        night = datetime(2026, 8, 31, 22, 0, tzinfo=IST)
        completed = frozenset(DayPhase)
        assert due_phases(nse, MONDAY, night, completed) == ()

    def test_only_the_unfinished_phases_come_back(self, nse):
        night = datetime(2026, 8, 31, 22, 0, tzinfo=IST)
        completed = frozenset(DayPhase) - {DayPhase.EOD}
        due = due_phases(nse, MONDAY, night, completed)
        assert [instant.phase for instant in due] == [DayPhase.EOD]


class TestSleepingUntilTheNextThing:
    def test_the_next_phase_today_is_found(self, nse):
        dawn = datetime(2026, 8, 31, 3, 0, tzinfo=IST)
        upcoming = next_phase_after(nse, dawn)
        assert upcoming is not None
        assert upcoming.phase is DayPhase.DAY_INIT
        assert upcoming.trading_day == MONDAY

    def test_after_the_last_phase_it_rolls_to_the_next_trading_day(self, nse):
        night = datetime(2026, 8, 31, 23, 59, tzinfo=IST)
        upcoming = next_phase_after(nse, night)
        assert upcoming is not None
        assert upcoming.trading_day == date(2026, 9, 1)

    def test_it_skips_a_weekend(self, nse):
        friday_night = datetime(2026, 9, 4, 23, 59, tzinfo=IST)
        upcoming = next_phase_after(nse, friday_night)
        assert upcoming is not None
        assert upcoming.trading_day == date(2026, 9, 7)

    def test_a_venue_that_never_opens_has_nothing_next(self, nse_calendar):
        from garuda.domain import Currency, Exchange, Segment, SettlementCycle, TradingCalendar

        closed = Exchange(
            code="SHUT",
            name="permanently closed",
            currency=Currency.INR,
            calendar=TradingCalendar(name="none", timezone=IST, weekly={}),
            settlement=SettlementCycle.T1,
            segments=frozenset({Segment.EQUITY}),
        )
        assert next_phase_after(closed, datetime(2026, 8, 31, 9, 0, tzinfo=IST)) is None


class TestOffsetsComeFromTheVenuesRow:
    """No phase time is written in code."""

    class Row:
        day_init_minutes_before_market_open = 240
        algo_start_minutes_before_market_open = 120
        intraday_squareoff_minutes_before_close = 30
        positional_squareoff_minutes_before_close = 10
        report_minutes_after_close = 5
        post_market_window_minutes = 90

    def test_each_offset_is_read_from_the_row(self):
        offsets = offsets_from_exchange_row(self.Row())
        assert offsets.day_init_lead == timedelta(minutes=240)
        assert offsets.post_market_window == timedelta(minutes=90)

    def test_a_venue_configured_differently_gets_a_different_day(self, nse):
        default = schedule_for(nse, MONDAY)
        configured = schedule_for(nse, MONDAY, offsets_from_exchange_row(self.Row()))
        assert at(configured, DayPhase.DAY_INIT) < at(default, DayPhase.DAY_INIT)

    def test_a_null_column_falls_back_rather_than_losing_the_phase(self):
        class Partial:
            day_init_minutes_before_market_open = None

        offsets = offsets_from_exchange_row(Partial())
        assert offsets.day_init_lead == DayOffsets().day_init_lead

    def test_positional_positions_close_nearer_the_bell_than_intraday(self, nse):
        """There is less to unwind, so they wait longer."""
        schedule = schedule_for(nse, MONDAY)
        assert at(schedule, DayPhase.INTRADAY_SQUARE_OFF) < at(
            schedule, DayPhase.POSITIONAL_SQUARE_OFF
        )
        assert at(schedule, DayPhase.POSITIONAL_SQUARE_OFF) < at(schedule, DayPhase.SESSION_CLOSE)


class TestOffsets:
    def test_they_shift_the_phases(self, nse):
        early = schedule_for(nse, MONDAY, DayOffsets(day_init_lead=timedelta(hours=5)))
        default = schedule_for(nse, MONDAY)
        assert at(early, DayPhase.DAY_INIT) < at(default, DayPhase.DAY_INIT)

    def test_initialising_after_the_engine_starts_is_refused(self):
        with pytest.raises(DomainError, match="initialised before"):
            DayOffsets(day_init_lead=timedelta(minutes=10), algo_start_lead=timedelta(minutes=90))

    def test_a_negative_offset_is_refused(self):
        with pytest.raises(DomainError, match="cannot be negative"):
            DayOffsets(report_lag=timedelta(minutes=-5))


class TestRejections:
    def test_a_naive_instant_is_refused(self, nse):
        with pytest.raises(Exception, match="timezone"):
            due_phases(nse, MONDAY, datetime(2026, 8, 31, 9, 0), frozenset())  # noqa: DTZ001

    def test_the_utc_offset_does_not_confuse_the_day(self, nse):
        """20:00 UTC is already the next morning in India."""
        instant = datetime(2026, 8, 30, 20, 0, tzinfo=UTC)  # 31st 01:30 IST
        upcoming = next_phase_after(nse, instant)
        assert upcoming is not None
        assert upcoming.trading_day == MONDAY
