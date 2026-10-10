"""The init timeline: what an operator reads on the System Status page.

Behavioural: tasks are begun and ended against a replay clock, and the
claims are about the lines that come out -- their order, their wording,
the duration format the reference uses, and the cap.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from garuda.core.clock import ReplayClock
from garuda.core.timeline import (
    MAX_EVENTS_PER_TIMELINE,
    InitTimeline,
    TimelinePhase,
    format_duration,
)

NOW = datetime(2026, 10, 10, 2, 0, tzinfo=UTC)


class TestATask:
    async def test_it_is_written_when_begun_and_when_finished_with_its_duration(self) -> None:
        clock = ReplayClock(NOW, auto_advance=False)
        timeline = InitTimeline(clock)

        task = timeline.begin("instruments load")
        await clock.advance_by(timedelta(seconds=88))
        timeline.end(task, "-- 94,120 instruments")

        messages = [event.message for event in timeline.startup_events()]
        assert messages == [
            "Finished instruments load -- 94,120 instruments -- took 1m 28s",
            "Started instruments load",
        ], "newest first"
        assert [event.at for event in timeline.startup_events()] == [
            NOW + timedelta(seconds=88),
            NOW,
        ]

    async def test_a_failure_says_so_and_how_long_it_took(self) -> None:
        clock = ReplayClock(NOW, auto_advance=False)
        timeline = InitTimeline(clock)
        task = timeline.begin("NSE DAY_INIT: load-instruments", phase=TimelinePhase.DAY)
        await clock.advance_by(timedelta(milliseconds=523))
        timeline.failed(task, "ConnectError: broker unreachable")

        [failed, _started] = timeline.day_events()
        assert failed.message == (
            "Failed NSE DAY_INIT: load-instruments after 523ms: ConnectError: broker unreachable"
        )
        assert timeline.startup_events() == [], "a day task is not a startup event"


class TestTheDay:
    def test_clearing_the_day_keeps_the_startup(self) -> None:
        timeline = InitTimeline(ReplayClock(NOW))
        timeline.record("Started application startup")
        timeline.record("Day begins", phase=TimelinePhase.DAY)

        timeline.clear_day()

        assert timeline.day_events() == []
        assert [e.message for e in timeline.startup_events()] == ["Started application startup"]

    def test_only_the_last_five_hundred_lines_are_kept(self) -> None:
        timeline = InitTimeline(ReplayClock(NOW))
        for n in range(MAX_EVENTS_PER_TIMELINE + 5):
            timeline.record(f"line {n}", phase=TimelinePhase.DAY)

        events = timeline.day_events()
        assert len(events) == MAX_EVENTS_PER_TIMELINE
        assert events[0].message == f"line {MAX_EVENTS_PER_TIMELINE + 4}"
        assert events[-1].message == "line 5", "the oldest lines are the ones dropped"


class TestTheDurationFormat:
    """The reference's: 523ms / 8s / 1m 28s / 1h 03m."""

    def test_each_scale(self) -> None:
        assert format_duration(timedelta(milliseconds=523)) == "523ms"
        assert format_duration(timedelta(seconds=8)) == "8s"
        assert format_duration(timedelta(seconds=88)) == "1m 28s"
        assert format_duration(timedelta(hours=1, minutes=3, seconds=9)) == "1h 03m"
