"""What the System Status page shows, from the engine's own parts.

Behavioural: an engine is built with two accounts and one session, and the
claims are about the rows that come out -- who trades and why not, what
the feed's one-word state is at this hour, what the venue is doing, and
what the probe says when nothing is nominated.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from garuda.composition.engine import Engine
from garuda.composition.status import PROBE_INSTRUMENT, SystemStatusView
from garuda.core.clock import ReplayClock
from garuda.core.timeline import InitTimeline
from garuda.domain.phases import DayPhase

from .conftest import AMMA, APPA, NOW, EngineBuilder, account, session

#: Sunday evening in Kolkata: no venue is open.
SUNDAY = datetime(2026, 8, 30, 14, 0, tzinfo=UTC)


@pytest.fixture
def engine(build_with: EngineBuilder) -> Engine:
    return build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234")},
    )


@pytest.fixture
def view(engine: Engine) -> SystemStatusView:
    return SystemStatusView(engine, ReplayClock(NOW), started_at=NOW - timedelta(minutes=5))


class TestTheAccounts:
    def test_who_trades_and_who_cannot_and_why(self, view: SystemStatusView) -> None:
        rows = {row.trading_client_id: row for row in view.accounts()}
        assert rows["appa"].is_trading is True
        assert rows["appa"].unavailable_because is None
        assert rows["amma"].is_trading is False
        assert rows["amma"].unavailable_because is not None
        assert "session" in rows["amma"].unavailable_because
        assert rows["amma"].is_cycling is False, "nothing has started"


class TestTheFeed:
    def test_no_feed_while_a_market_is_open_is_down(self, view: SystemStatusView) -> None:
        """09:30 on a Monday, nothing nominated: that is a problem, not rest."""
        feed = view.feed()
        assert feed.service is None
        assert feed.any_market_open is True
        assert feed.state == "DOWN"

    def test_no_feed_while_every_market_is_closed_is_inactive(self, engine: Engine) -> None:
        feed = SystemStatusView(engine, ReplayClock(SUNDAY)).feed()
        assert feed.any_market_open is False
        assert feed.state == "INACTIVE"


class TestTheVenues:
    def test_a_venue_says_what_it_is_doing_and_what_comes_next(
        self, view: SystemStatusView
    ) -> None:
        [nse] = view.venues()
        assert nse.code == "NSE"
        assert nse.is_trading_day is True
        assert nse.is_open is True
        assert nse.sessions == (("09:15", "15:30"),)
        assert nse.next_phase is not None
        assert nse.next_phase.phase is DayPhase.INTRADAY_SQUARE_OFF
        assert nse.next_phase.at.astimezone(nse.next_phase.at.tzinfo).strftime("%H:%M") in (
            "15:10",
            "09:40",  # the same instant in UTC
        )

    def test_a_closed_day_has_no_sessions(self, engine: Engine) -> None:
        [nse] = SystemStatusView(engine, ReplayClock(SUNDAY)).venues()
        assert nse.is_trading_day is False
        assert nse.sessions == ()
        assert nse.next_phase is not None, "Monday's day-init is next"
        assert nse.next_phase.phase is DayPhase.DAY_INIT


class TestTheLoopsAndRisk:
    def test_nothing_runs_on_a_built_engine(self, view: SystemStatusView) -> None:
        loops = view.loops()
        assert loops.runner_running is False
        assert loops.trade_loops_started is False
        assert loops.accounts_cycling == frozenset()
        assert loops.strategy_loop is None

    def test_no_switch_and_no_limit_rows(self, view: SystemStatusView) -> None:
        risk = view.risk()
        assert risk.kill_switches == ()
        assert risk.limit_rows == 0


class TestTheProcess:
    def test_uptime_is_measured_from_when_it_started(self, view: SystemStatusView) -> None:
        process = view.process()
        assert process.uptime == timedelta(minutes=5)
        assert process.version
        assert process.threads >= 1


class TestTheTimeline:
    def test_it_reads_what_was_recorded(self, engine: Engine) -> None:
        clock = ReplayClock(NOW)
        timeline = InitTimeline(clock)
        timeline.record("Started application startup")
        view = SystemStatusView(engine, clock, timeline=timeline)
        assert [e.message for e in view.startup_events()] == ["Started application startup"]
        assert view.day_events() == []

    def test_without_one_there_is_nothing_to_read(self, view: SystemStatusView) -> None:
        assert view.startup_events() == []


class TestTheProbe:
    async def test_with_nothing_nominated_both_halves_say_so(self, view: SystemStatusView) -> None:
        result = await view.health_check()
        assert result.instrument == PROBE_INSTRUMENT
        assert result.tick.ok is False
        assert result.tick.error == "no provider is nominated for ticks"
        assert result.history.ok is False
        assert result.history.error is not None
        assert "candle history" in result.history.error
