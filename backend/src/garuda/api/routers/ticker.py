"""The ticker and the instrument files, under the operator's hand.

Two things the day model does on its own and the operator could not: start,
stop or replace the feed, and fetch an instrument file. Both were already
happening -- the feed is replaced on a login and a failed master is retried
at the next DAY_INIT -- but neither was visible or on demand, which on the
one morning it matters is the same as not happening.

Ported from the reference service's ticker and instruments servlets, with
the same shape: a status, and one action per button.

**A manual start is not holiday-gated**, and the reference says why: the
button exists for the day the day model would not start the feed by itself.

**A download is forced.** The button exists for the morning the cached file
is wrong in a way no staleness rule can see, and a button that re-reads the
cache on such a morning is a button that does nothing.

**A login re-reads the sessions, refreshes the masters, then replaces the
feed.** The engine keeps its own copy of every broker session, so a token
written by the Console reaches it only when told to look. The reference
calls this "login first": a session coming alive is the moment to make sure
today's file is loaded, because a login after the open is exactly the case
where DAY_INIT could not load it. It runs in the background, so the browser
is sent back to the Console while the download is still going, and the
Console shows it in progress.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from starlette.applications import Starlette

from garuda.api.envelope import ok
from garuda.marketdata.downloads import DownloadStatus, InstrumentDownloads
from garuda.marketdata.service import MarketDataService

logger = logging.getLogger(__name__)


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def ticker_wire(service: MarketDataService | None) -> dict[str, Any]:
    """The feed's state, in the reference's vocabulary.

    ``stopped`` is no feed at all -- nothing nominated, or stopped by the day
    model or the operator. ``disconnected`` is a running service whose
    socket is down, which the monitor is already trying to put right.
    """
    if service is None:
        return {
            "provider": None,
            "status": "stopped",
            "isRunning": False,
            "nominated": False,
            "connectedSince": None,
            "lastTickAt": None,
            "lastDisconnectReason": "no provider is nominated for ticks",
            "subscriptions": 0,
            "quoting": 0,
            "ticksPublished": 0,
            "reconnects": 0,
            "consecutiveFailures": 0,
            "lastAttemptAt": None,
        }
    hub = service.hub
    health = hub.health
    feed = service.supervisor.feed
    if not service.is_running:
        status = "stopped"
    elif feed is not None and feed.is_connected:
        status = "connected"
    else:
        status = "disconnected"
    state = service.supervisor.state
    return {
        "provider": service.provider,
        "status": status,
        "isRunning": service.is_running,
        "nominated": True,
        "connectedSince": _iso(health.connected_since),
        "lastTickAt": _iso(health.last_tick_at),
        "lastDisconnectReason": health.last_disconnect_reason,
        "subscriptions": len(hub.subscriptions),
        "quoting": sum(1 for held in hub.subscriptions if hub.latest(held) is not None),
        "ticksPublished": health.ticks_published,
        "reconnects": state.reconnects,
        "consecutiveFailures": state.consecutive_failures,
        "lastAttemptAt": _iso(state.last_attempt_at),
    }


def download_wire(status: DownloadStatus) -> dict[str, Any]:
    return {
        "name": status.name,
        "kind": status.kind,
        "provider": status.provider,
        "loaded": status.loaded,
        "count": status.count,
        "cachedAt": _iso(status.cached_at),
        "lastAttemptAt": _iso(status.last_attempt_at),
        "lastSuccessAt": _iso(status.last_success_at),
        "lastError": status.last_error,
        "lastDownloaded": status.last_downloaded,
        "inProgress": status.in_progress,
        "isFromToday": status.is_from_today,
        "isStale": status.is_stale,
        "skippedBecause": status.skipped_because,
    }


def _engine(request: Request) -> Any:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=503,
            detail="the API is running without an engine, so there is no feed to control",
        )
    return engine


def _service(request: Request) -> MarketDataService:
    service: MarketDataService | None = _engine(request).parts.market_data
    if service is None:
        raise HTTPException(
            status_code=409,
            detail="no provider is nominated for ticks, so there is no feed to control. "
            "Choose one under Active on the Data Providers page and log it in.",
        )
    return service


def _downloads(request: Request) -> InstrumentDownloads:
    downloads: InstrumentDownloads | None = _engine(request).parts.downloads
    if downloads is None:
        raise HTTPException(
            status_code=503, detail="the engine has not registered its instrument files yet"
        )
    return downloads


def renew_after_login(app: Starlette, provider: str, why: str) -> asyncio.Task[None] | None:
    """Refresh the instrument files, then replace the feed. In the background.

    Called after a provider's session changes hands. The order matters: the
    feed's standing subscriptions resolve against the master, so a feed
    brought up before today's master is loaded subscribes to nothing it can
    name. The feed is replaced whether or not the refresh succeeded -- the
    session changed, and a socket carrying yesterday's token is finished
    either way.

    Returns the task, or None when there is no engine in this process. The
    task is kept on the application so it is not collected mid-flight.
    """
    engine = getattr(app.state, "engine", None)
    parts = getattr(engine, "parts", None)
    if parts is None:
        return None
    downloads: InstrumentDownloads | None = getattr(parts, "downloads", None)
    service: MarketDataService | None = getattr(parts, "market_data", None)
    reload_sessions = getattr(app.state, "reload_sessions", None)
    if downloads is None and service is None and reload_sessions is None:
        return None

    async def renew() -> None:
        # The sessions first: the feed about to be built reads its token from
        # the engine's own copy of them, not from the database.
        if reload_sessions is not None:
            try:
                await reload_sessions()
            except Exception:
                logger.exception("could not re-read the broker sessions after %s %s", provider, why)
        if downloads is not None:
            try:
                for status in await downloads.refresh_all():
                    if status.last_error:
                        logger.warning(
                            "%s: not refreshed after %s %s: %s",
                            status.name,
                            provider,
                            why,
                            status.last_error,
                        )
            except Exception:
                logger.exception(
                    "could not refresh the instrument files after %s %s", provider, why
                )
        if service is not None:
            try:
                await service.reconnect(f"{provider} {why}")
            except Exception:
                logger.exception("%s: could not replace the feed after %s", provider, why)

    task = asyncio.create_task(renew(), name=f"renew-after-{provider}")
    pending: set[asyncio.Task[None]] = getattr(app.state, "renewals", set())
    pending.add(task)
    task.add_done_callback(pending.discard)
    app.state.renewals = pending
    return task


def build() -> APIRouter:
    router = APIRouter(prefix="/api/market-data", tags=["ticker"])

    # -- the feed ------------------------------------------------------------

    @router.get("/ticker")
    async def ticker(request: Request) -> dict[str, Any]:
        """What the feed is doing, whoever last told it to."""
        return ok(ticker_wire(_engine(request).parts.market_data))

    @router.post("/ticker/start")
    async def start(request: Request) -> dict[str, Any]:
        service = _service(request)
        if service.is_running:
            return ok(ticker_wire(service), message="the feed is already running")
        connected = await service.start()
        message = (
            "feed started"
            if connected
            else "feed started, but it is not connected yet; the monitor keeps trying"
        )
        logger.info("feed started from the Console: connected=%s", connected)
        return ok(ticker_wire(service), message=message)

    @router.post("/ticker/stop")
    async def stop(request: Request) -> dict[str, Any]:
        service = _service(request)
        if not service.is_running:
            return ok(ticker_wire(service), message="the feed is already stopped")
        await service.stop()
        logger.info("feed stopped from the Console")
        return ok(
            ticker_wire(service),
            message="feed stopped. It starts again by itself at the next venue's open.",
        )

    @router.post("/ticker/restart")
    async def restart(request: Request) -> dict[str, Any]:
        """Replace the connection. A stopped feed is started instead."""
        service = _service(request)
        if not service.is_running:
            connected = await service.start()
        else:
            connected = await service.reconnect("restarted from the Console")
        logger.info("feed restarted from the Console: connected=%s", connected)
        return ok(
            ticker_wire(service),
            message="feed restarted"
            if connected
            else "feed restarted, but it is not connected yet",
        )

    # -- the files -----------------------------------------------------------

    @router.get("/instruments")
    async def instruments(request: Request) -> dict[str, Any]:
        """Every instrument file, and when it was last fetched."""
        return ok([download_wire(status) for status in _downloads(request).status()])

    @router.post("/instruments/{name}/download")
    async def download(name: str, request: Request) -> dict[str, Any]:
        """Fetch one file now, whatever the cache says.

        Awaited rather than backgrounded: the operator pressed the button and
        is waiting to see the count change, and the reference does the same.
        """
        downloads = _downloads(request)
        if name not in downloads.names:
            raise HTTPException(
                status_code=404,
                detail=f"{name!r} is not an instrument file; one of {', '.join(downloads.names)}",
            )
        status = await downloads.refresh(name, force=True)
        if status.last_error is not None:
            raise HTTPException(status_code=502, detail=f"{name}: {status.last_error}")
        return ok(
            download_wire(status),
            message=f"{name}: {status.count} instruments downloaded",
        )

    return router
