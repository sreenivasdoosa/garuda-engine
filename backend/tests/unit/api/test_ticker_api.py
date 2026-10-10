"""The ticker and the instrument files, from the Console's side.

Behavioural: what the Console gets for what it sends. The feed is a real
service over a silent socket; the instrument files are stubs that count what
was fetched. No database, because none of this reads one.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI

from garuda.api import envelope
from garuda.api.routers import ticker
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain.instrument import InstrumentId
from garuda.marketdata.downloads import DownloadReport, InstrumentDownloads
from garuda.marketdata.hub import TickHub
from garuda.marketdata.service import MarketDataService
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.protocols.feed import FeedEvent, MarketDataFeed

IST = ZoneInfo("Asia/Kolkata")
NIFTY = InstrumentId("NSE:NIFTY")
DURING_SESSION = datetime(2026, 8, 31, 5, 0, tzinfo=UTC)


class SilentFeed:
    def __init__(self, name: str) -> None:
        self._name = name
        self.connected = False
        self.closed = False

    @property
    def name(self) -> str:
        return self._name

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        self.closed = True

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None:
        return None

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None:
        return None

    async def events(self) -> AsyncIterator[FeedEvent]:
        return
        yield  # pragma: no cover


class Vendor:
    def __init__(self) -> None:
        self.fetches: list[bool] = []
        self.down = False

    async def download(self, now: datetime, force: bool) -> DownloadReport:
        if self.down:
            raise ConnectionError("unreachable")
        self.fetches.append(force)
        return DownloadReport(count=7, downloaded=True, cached_at=now)


class Parts:
    def __init__(
        self, market_data: MarketDataService | None, downloads: InstrumentDownloads | None
    ) -> None:
        self.market_data = market_data
        self.downloads = downloads


class Engine:
    def __init__(self, parts: Parts) -> None:
        self.parts = parts


class Harness:
    """Everything one test needs, built together."""

    def __init__(self, *, nominated: bool = True, with_downloads: bool = True) -> None:
        self.clock = ReplayClock(DURING_SESSION)
        self.feeds: list[SilentFeed] = []
        self.hub = TickHub(InProcessEventBus(), self.clock)
        self.vendor = Vendor()
        self.log: list[str] = []

        async def factory() -> MarketDataFeed:
            feed = SilentFeed(f"feed-{len(self.feeds)}")
            self.feeds.append(feed)
            self.log.append("connect")
            return feed

        self.service: MarketDataService | None = None
        if nominated:
            self.service = MarketDataService(
                self.hub,
                FeedSupervisor(self.hub, factory, self.clock),
                self.clock,
                standing_subscriptions=lambda: [NIFTY],
                provider="zerodha",
            )
        self.downloads: InstrumentDownloads | None = None
        if with_downloads:
            self.downloads = InstrumentDownloads(self.clock, IST)

            async def download(now: datetime, force: bool) -> DownloadReport:
                self.log.append("download")
                return await self.vendor.download(now, force)

            self.downloads.register("master:zerodha", download, kind="master", provider="zerodha")
        self.app = FastAPI()
        envelope.install(self.app)
        self.app.state.engine = Engine(Parts(self.service, self.downloads))
        self.app.include_router(ticker.build())

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t")

    async def stop(self) -> None:
        if self.service is not None:
            await self.service.stop()


def engineless_app() -> FastAPI:
    app = FastAPI()
    envelope.install(app)
    app.state.engine = None
    app.include_router(ticker.build())
    return app


async def body(response: httpx.Response) -> Any:
    return response.json()


class TestTheTickerStatus:
    async def test_without_an_engine_there_is_nothing_to_report(self) -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=engineless_app()), base_url="http://t"
        ) as client:
            response = await client.get("/api/market-data/ticker")
        assert response.status_code == 503
        assert "without an engine" in response.json()["message"]

    async def test_nothing_nominated_reads_as_stopped_and_says_why(self) -> None:
        harness = Harness(nominated=False)
        async with harness.client() as client:
            data = (await client.get("/api/market-data/ticker")).json()["data"]
        assert data["status"] == "stopped"
        assert data["nominated"] is False
        assert "nominated" in data["lastDisconnectReason"]

    async def test_a_running_feed_reads_as_connected_with_its_provider(self) -> None:
        harness = Harness()
        try:
            assert harness.service is not None
            await harness.service.start()
            async with harness.client() as client:
                data = (await client.get("/api/market-data/ticker")).json()["data"]
            assert data["status"] == "connected"
            assert data["provider"] == "zerodha"
            assert data["isRunning"] is True
            assert data["subscriptions"] == 1
            assert data["quoting"] == 0
        finally:
            await harness.stop()

    async def test_a_running_feed_whose_socket_dropped_reads_as_disconnected(self) -> None:
        harness = Harness()
        try:
            assert harness.service is not None
            await harness.service.start()
            harness.feeds[0].connected = False
            async with harness.client() as client:
                data = (await client.get("/api/market-data/ticker")).json()["data"]
            assert data["status"] == "disconnected"
            assert data["isRunning"] is True
        finally:
            await harness.stop()


class TestTheButtons:
    async def test_start_brings_the_feed_up(self) -> None:
        harness = Harness()
        try:
            async with harness.client() as client:
                response = await client.post("/api/market-data/ticker/start")
            assert response.status_code == 200
            assert response.json()["data"]["status"] == "connected"
            assert harness.feeds[0].is_connected
        finally:
            await harness.stop()

    async def test_start_on_a_running_feed_changes_nothing(self) -> None:
        harness = Harness()
        try:
            async with harness.client() as client:
                await client.post("/api/market-data/ticker/start")
                response = await client.post("/api/market-data/ticker/start")
            assert "already running" in response.json()["message"]
            assert len(harness.feeds) == 1
        finally:
            await harness.stop()

    async def test_stop_closes_the_connection(self) -> None:
        harness = Harness()
        try:
            async with harness.client() as client:
                await client.post("/api/market-data/ticker/start")
                response = await client.post("/api/market-data/ticker/stop")
            assert response.json()["data"]["status"] == "stopped"
            assert harness.feeds[0].closed
            assert harness.service is not None
            assert not harness.service.is_running
        finally:
            await harness.stop()

    async def test_restart_replaces_the_connection(self) -> None:
        harness = Harness()
        try:
            async with harness.client() as client:
                await client.post("/api/market-data/ticker/start")
                response = await client.post("/api/market-data/ticker/restart")
            assert response.json()["data"]["status"] == "connected"
            assert len(harness.feeds) == 2
            assert harness.feeds[0].closed
            assert harness.feeds[1].is_connected
        finally:
            await harness.stop()

    async def test_restart_on_a_stopped_feed_starts_it(self) -> None:
        harness = Harness()
        try:
            async with harness.client() as client:
                response = await client.post("/api/market-data/ticker/restart")
            assert response.json()["data"]["status"] == "connected"
            assert len(harness.feeds) == 1
        finally:
            await harness.stop()

    async def test_with_nothing_nominated_the_buttons_refuse_and_say_what_to_do(self) -> None:
        harness = Harness(nominated=False)
        async with harness.client() as client:
            response = await client.post("/api/market-data/ticker/start")
        assert response.status_code == 409
        assert "Data Providers" in response.json()["message"]


class TestTheInstrumentFiles:
    async def test_the_list_says_what_is_loaded(self) -> None:
        harness = Harness()
        async with harness.client() as client:
            [status] = (await client.get("/api/market-data/instruments")).json()["data"]
        assert status["name"] == "master:zerodha"
        assert status["kind"] == "master"
        assert status["loaded"] is False
        assert status["isStale"] is True

    async def test_download_fetches_whatever_the_cache_says(self) -> None:
        harness = Harness()
        async with harness.client() as client:
            response = await client.post("/api/market-data/instruments/master:zerodha/download")
        assert response.status_code == 200
        assert harness.vendor.fetches == [True], "forced"
        data = response.json()["data"]
        assert data["loaded"] is True
        assert data["count"] == 7
        assert data["isFromToday"] is True
        assert "7 instruments" in response.json()["message"]

    async def test_a_failed_download_is_a_bad_gateway_naming_the_cause(self) -> None:
        harness = Harness()
        harness.vendor.down = True
        async with harness.client() as client:
            response = await client.post("/api/market-data/instruments/master:zerodha/download")
        assert response.status_code == 502
        assert "unreachable" in response.json()["message"]

    async def test_an_unknown_file_is_refused_by_name(self) -> None:
        harness = Harness()
        async with harness.client() as client:
            response = await client.post("/api/market-data/instruments/catalogue:fyers/download")
        assert response.status_code == 404
        assert "master:zerodha" in response.json()["message"]


class TestALogin:
    """What a provider's login sets in motion."""

    async def test_the_files_are_refreshed_and_then_the_feed_replaced(self) -> None:
        harness = Harness()
        try:
            assert harness.service is not None
            await harness.service.start()
            harness.log.clear()

            task = ticker.renew_after_login(harness.app, "zerodha", "logged in")
            assert task is not None
            await task

            assert harness.log == ["download", "connect"], "the master first, so the feed resolves"
            assert harness.vendor.fetches == [False], "not forced: today's cache is good enough"
            assert len(harness.feeds) == 2
            assert harness.feeds[0].closed
        finally:
            await harness.stop()

    async def test_a_file_that_will_not_download_does_not_stop_the_feed_being_replaced(
        self,
    ) -> None:
        harness = Harness()
        harness.vendor.down = True
        try:
            assert harness.service is not None
            await harness.service.start()

            task = ticker.renew_after_login(harness.app, "zerodha", "logged in")
            assert task is not None
            await task

            assert len(harness.feeds) == 2
            assert harness.downloads is not None
            assert harness.downloads.status_of("master:zerodha").last_error is not None
        finally:
            await harness.stop()

    async def test_before_the_feed_is_running_only_the_files_are_refreshed(self) -> None:
        """A login at eight: the feed starts at the open, as it always did."""
        harness = Harness()
        task = ticker.renew_after_login(harness.app, "zerodha", "logged in")
        assert task is not None
        await task

        assert harness.vendor.fetches == [False]
        assert harness.feeds == []

    async def test_without_an_engine_nothing_is_started(self) -> None:
        assert ticker.renew_after_login(engineless_app(), "zerodha", "logged in") is None

    async def test_the_task_is_held_until_it_finishes(self) -> None:
        harness = Harness()
        task = ticker.renew_after_login(harness.app, "zerodha", "logged in")
        assert task is not None
        assert task in harness.app.state.renewals
        await task
        await asyncio.sleep(0)
        assert task not in harness.app.state.renewals
