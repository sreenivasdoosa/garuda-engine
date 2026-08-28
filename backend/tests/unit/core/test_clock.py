"""Clocks.

The replay clock is test infrastructure, so its own behaviour has to be
exactly right — a replay that wakes sleepers in the wrong order proves
nothing.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from garuda.core.clock import LiveClock, ReplayClock
from garuda.domain.errors import DomainError, NaiveDatetimeError
from garuda.protocols.clock import Clock

START = datetime(2026, 8, 27, 9, 15, tzinfo=UTC)


class TestBothSatisfyTheProtocol:
    @pytest.mark.parametrize("clock", [LiveClock(), ReplayClock(START)], ids=["live", "replay"])
    def test_it_is_a_clock(self, clock):
        assert isinstance(clock, Clock)

    @pytest.mark.parametrize("clock", [LiveClock(), ReplayClock(START)], ids=["live", "replay"])
    def test_now_is_always_aware_and_utc(self, clock):
        assert clock.now().tzinfo is not None
        assert clock.now().utcoffset() == timedelta(0)


class TestLiveClock:
    async def test_sleeping_advances_real_time(self):
        clock = LiveClock()
        before = clock.now()
        await clock.sleep(timedelta(milliseconds=20))
        assert clock.now() - before >= timedelta(milliseconds=15)

    async def test_sleeping_until_a_past_instant_returns_at_once(self):
        clock = LiveClock()
        await clock.sleep_until(clock.now() - timedelta(hours=1))


class TestAutoAdvance:
    """A recorded day replays in seconds instead of taking a day."""

    async def test_a_sleep_jumps_the_clock_and_returns_immediately(self):
        clock = ReplayClock(START)
        await clock.sleep(timedelta(hours=6))
        assert clock.now() == START + timedelta(hours=6)

    async def test_sleeping_until_a_past_instant_does_not_rewind(self):
        clock = ReplayClock(START)
        await clock.sleep_until(START - timedelta(hours=1))
        assert clock.now() == START

    async def test_a_whole_session_passes_without_real_time_elapsing(self):
        clock = ReplayClock(START)
        real_start = datetime.now(UTC)
        for _ in range(375):  # a full NSE session, minute by minute
            await clock.sleep(timedelta(minutes=1))
        assert clock.now() == START + timedelta(minutes=375)
        assert datetime.now(UTC) - real_start < timedelta(seconds=2)


class TestDrivenMode:
    async def test_a_sleeper_waits_until_the_clock_is_advanced(self):
        clock = ReplayClock(START, auto_advance=False)
        task = asyncio.create_task(clock.sleep_until(START + timedelta(minutes=5)))
        await asyncio.sleep(0)
        assert not task.done()
        assert clock.pending_wakeups == 1

        await clock.advance_to(START + timedelta(minutes=5))
        await task
        assert task.done()

    async def test_advancing_short_of_the_deadline_leaves_the_sleeper_waiting(self):
        clock = ReplayClock(START, auto_advance=False)
        task = asyncio.create_task(clock.sleep_until(START + timedelta(minutes=5)))
        await asyncio.sleep(0)

        await clock.advance_to(START + timedelta(minutes=4))
        await asyncio.sleep(0)
        assert not task.done()

        await clock.advance_to(START + timedelta(minutes=5))
        await task

    async def test_waiters_wake_in_timestamp_order_not_in_the_order_they_slept(self):
        """Determinism depends on this: registration order must not matter."""
        clock = ReplayClock(START, auto_advance=False)
        woken: list[int] = []

        async def sleeper(minutes: int) -> None:
            await clock.sleep_until(START + timedelta(minutes=minutes))
            woken.append(minutes)

        tasks = [asyncio.create_task(sleeper(m)) for m in (30, 5, 20, 1)]
        await asyncio.sleep(0)

        await clock.advance_to(START + timedelta(hours=1))
        await asyncio.gather(*tasks)
        assert woken == [1, 5, 20, 30]

    async def test_each_waiter_sees_the_clock_at_its_own_wake_up_instant(self):
        """A sleeper due at 09:20 must not observe 15:30 on replay."""
        clock = ReplayClock(START, auto_advance=False)
        observed: dict[int, datetime] = {}

        async def sleeper(minutes: int) -> None:
            await clock.sleep_until(START + timedelta(minutes=minutes))
            observed[minutes] = clock.now()

        tasks = [asyncio.create_task(sleeper(m)) for m in (5, 20)]
        await asyncio.sleep(0)

        await clock.advance_to(START + timedelta(hours=6))
        await asyncio.gather(*tasks)
        assert observed[5] == START + timedelta(minutes=5)
        assert observed[20] == START + timedelta(minutes=20)


class TestRejections:
    async def test_the_clock_cannot_go_backwards(self):
        clock = ReplayClock(START, auto_advance=False)
        with pytest.raises(DomainError, match="cannot go backwards"):
            await clock.advance_to(START - timedelta(seconds=1))

    def test_a_naive_start_is_refused(self):
        with pytest.raises(NaiveDatetimeError):
            ReplayClock(datetime(2026, 8, 27, 9, 15))  # noqa: DTZ001

    async def test_a_naive_deadline_is_refused(self):
        clock = ReplayClock(START)
        with pytest.raises(NaiveDatetimeError):
            await clock.sleep_until(datetime(2026, 8, 27, 9, 20))  # noqa: DTZ001

    def test_a_start_in_another_zone_is_normalised_to_utc(self):
        from zoneinfo import ZoneInfo

        clock = ReplayClock(datetime(2026, 8, 27, 14, 45, tzinfo=ZoneInfo("Asia/Kolkata")))
        assert clock.now() == datetime(2026, 8, 27, 9, 15, tzinfo=UTC)
