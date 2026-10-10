"""When an instrument file is fetched, and when it is deliberately not.

The claims are about the operator's morning: a login after the open gets
today's file, a provider that is down is not hammered, the button fetches
whatever the cache says, and what the Console reads is what happened.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from garuda.core.clock import ReplayClock
from garuda.marketdata.downloads import DownloadReport, InstrumentDownloads

IST = ZoneInfo("Asia/Kolkata")
#: 09:20 IST on a Monday, after the day's masters were published.
AFTER_OPEN = datetime(2026, 8, 31, 3, 50, tzinfo=UTC)
#: 07:30 IST the same day, before them.
BEFORE_PUBLICATION = datetime(2026, 8, 31, 2, 0, tzinfo=UTC)


class Vendor:
    """A source that counts fetches and can be told to be down."""

    def __init__(self, *, count: int = 9) -> None:
        self.fetches: list[bool] = []
        self.down = False
        self.count = count
        self.cached_at: datetime | None = None
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.release.set()

    async def download(self, now: datetime, force: bool) -> DownloadReport:
        self.started.set()
        await self.release.wait()
        if self.down:
            raise ConnectionError("the vendor is unreachable")
        fetched = force or self.cached_at is None
        if fetched:
            self.cached_at = now
        self.fetches.append(fetched)
        assert self.cached_at is not None
        return DownloadReport(count=self.count, downloaded=fetched, cached_at=self.cached_at)


def registry(clock: ReplayClock, *vendors: tuple[str, Vendor]) -> InstrumentDownloads:
    downloads = InstrumentDownloads(clock, IST)
    for name, vendor in vendors:
        kind, provider = name.split(":")
        downloads.register(name, vendor.download, kind=kind, provider=provider)
    return downloads


class TestRefreshing:
    async def test_a_load_is_recorded_as_what_it_did(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor(count=12)
        downloads = registry(clock, ("master:zerodha", vendor))

        status = await downloads.refresh("master:zerodha")

        assert status.loaded is True
        assert status.count == 12
        assert status.last_downloaded is True
        assert status.last_success_at == AFTER_OPEN
        assert status.last_error is None
        assert status.is_from_today is True
        assert status.is_stale is False

    async def test_a_second_load_reads_the_cache_and_says_so(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        downloads = registry(clock, ("master:zerodha", vendor))

        await downloads.refresh("master:zerodha")
        status = await downloads.refresh("master:zerodha")

        assert vendor.fetches == [True, False]
        assert status.last_downloaded is False

    async def test_forcing_fetches_whatever_the_cache_says(self) -> None:
        """The button exists for the morning the cached file is wrong."""
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")

        status = await downloads.refresh("master:zerodha", force=True)

        assert vendor.fetches == [True, True]
        assert status.last_downloaded is True

    async def test_a_failure_is_recorded_rather_than_raised(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.down = True
        downloads = registry(clock, ("master:zerodha", vendor))

        status = await downloads.refresh("master:zerodha")

        assert status.loaded is False
        assert status.last_error == "ConnectionError: the vendor is unreachable"
        assert status.last_attempt_at == AFTER_OPEN
        assert status.last_success_at is None

    async def test_a_failure_keeps_what_was_loaded_before(self) -> None:
        """Yesterday's count is still the count in use; the error says why."""
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor(count=9)
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")

        vendor.down = True
        status = await downloads.refresh("master:zerodha", force=True)

        assert status.loaded is True
        assert status.count == 9
        assert status.last_error is not None

    async def test_an_unknown_source_is_refused_by_name(self) -> None:
        downloads = registry(ReplayClock(AFTER_OPEN), ("master:zerodha", Vendor()))
        with pytest.raises(KeyError, match="catalogue:fyers"):
            await downloads.refresh("catalogue:fyers")

    async def test_a_source_cannot_be_registered_twice(self) -> None:
        downloads = registry(ReplayClock(AFTER_OPEN), ("master:zerodha", Vendor()))
        with pytest.raises(ValueError, match="already registered"):
            downloads.register("master:zerodha", Vendor().download, kind="master", provider="x")


class TestTheRetryRule:
    """The reference's: a failed fetch is not retried for ten minutes."""

    async def test_a_failed_attempt_holds_the_next_one_off(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.down = True
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")
        vendor.down = False

        await clock.advance_by(timedelta(minutes=3))
        status = await downloads.refresh("master:zerodha")

        assert status.skipped_because is not None
        assert "retrying in 420s" in status.skipped_because
        assert status.loaded is False
        assert vendor.fetches == []

    async def test_ten_minutes_later_it_is_tried_again(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.down = True
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")
        vendor.down = False

        await clock.advance_by(timedelta(minutes=10))
        status = await downloads.refresh("master:zerodha")

        assert status.loaded is True
        assert status.skipped_because is None

    async def test_forcing_ignores_the_hold_off(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.down = True
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")
        vendor.down = False

        status = await downloads.refresh("master:zerodha", force=True)

        assert status.loaded is True

    async def test_the_days_tasks_are_not_throttled(self) -> None:
        """The runner is the retry there, on its own cadence."""
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.down = True
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha", throttle=False)
        vendor.down = False

        status = await downloads.refresh("master:zerodha", throttle=False)

        assert status.loaded is True

    async def test_a_success_never_holds_anything_off(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        downloads = registry(clock, ("master:zerodha", vendor))
        await downloads.refresh("master:zerodha")

        status = await downloads.refresh("master:zerodha")

        assert status.skipped_because is None


class TestStaleness:
    """Judged when the status is read, not when the file was fetched."""

    async def test_a_file_fetched_before_publication_turns_stale_at_eight(self) -> None:
        clock = ReplayClock(BEFORE_PUBLICATION)
        downloads = registry(clock, ("master:zerodha", Vendor()))
        fresh = await downloads.refresh("master:zerodha")
        assert fresh.is_stale is False
        assert fresh.is_from_today is True

        await clock.advance_to(AFTER_OPEN)
        later = downloads.status_of("master:zerodha")

        assert later.is_stale is True
        assert later.is_from_today is True

    async def test_yesterdays_file_is_not_from_today(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        downloads = registry(clock, ("master:zerodha", Vendor()))
        await downloads.refresh("master:zerodha")

        await clock.advance_by(timedelta(days=1))
        status = downloads.status_of("master:zerodha")

        assert status.is_from_today is False
        assert status.is_stale is True

    async def test_nothing_loaded_is_stale(self) -> None:
        downloads = registry(ReplayClock(AFTER_OPEN), ("master:zerodha", Vendor()))
        [status] = downloads.status()
        assert status.loaded is False
        assert status.is_stale is True
        assert status.cached_at is None


class TestEverySource:
    async def test_refresh_all_loads_each_and_one_failing_does_not_stop_the_next(self) -> None:
        clock = ReplayClock(AFTER_OPEN)
        master, dhan = Vendor(), Vendor(count=4)
        master.down = True
        downloads = registry(clock, ("master:zerodha", master), ("catalogue:dhan", dhan))

        statuses = await downloads.refresh_all()

        by_name = {status.name: status for status in statuses}
        assert by_name["master:zerodha"].last_error is not None
        assert by_name["catalogue:dhan"].count == 4
        assert downloads.names == ("master:zerodha", "catalogue:dhan")

    async def test_two_refreshes_of_one_source_at_once_fetch_once(self) -> None:
        """A login storm must not become five downloads of the same file."""
        clock = ReplayClock(AFTER_OPEN)
        vendor = Vendor()
        vendor.release.clear()
        downloads = registry(clock, ("master:zerodha", vendor))

        first = asyncio.create_task(downloads.refresh("master:zerodha"))
        await vendor.started.wait()
        assert downloads.status_of("master:zerodha").in_progress is True
        second = asyncio.create_task(downloads.refresh("master:zerodha"))
        await asyncio.sleep(0)
        vendor.release.set()
        await asyncio.gather(first, second)

        assert vendor.fetches == [True, False]
        assert downloads.status_of("master:zerodha").in_progress is False
