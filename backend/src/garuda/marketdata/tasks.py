"""Market data work that belongs to a phase of the trading day.

The instrument load is registered here rather than inside the loader so the
loader stays a thing that fetches and indexes, testable without a runner, and
the decision about *when* it happens stays with the day model.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date, datetime

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase
from garuda.marketdata.downloads import Download, DownloadReport, InstrumentDownloads
from garuda.marketdata.loader import InstrumentLoader, InstrumentRegistryHolder
from garuda.marketdata.providers.catalogues import CatalogueHolder, CatalogueLoad
from garuda.marketdata.service import MarketDataService

logger = logging.getLogger(__name__)


class MasterLoadError(RuntimeError):
    """The instrument master could not be loaded, so DAY_INIT is not done."""


def master_name(broker: str) -> str:
    """How the master is named among the downloads: ``master:zerodha``."""
    return f"master:{broker}"


def catalogue_name(provider: str) -> str:
    """How a provider's catalogue is named among the downloads: ``catalogue:dhan``."""
    return f"catalogue:{provider}"


def master_download(
    loader: InstrumentLoader, holder: InstrumentRegistryHolder, *, broker: str
) -> Download:
    """Load the master and publish it, as one thing a download registry can run."""

    async def download(now: datetime, force: bool) -> DownloadReport:
        result = await loader.load(now, force=force)
        holder.publish(broker, result.registry)
        for trading_symbol, reason in result.skipped:
            # Individually, so a single unparseable row is searchable rather
            # than buried in a count.
            logger.warning("instrument skipped: broker=%s %s: %s", broker, trading_symbol, reason)
        return DownloadReport(
            count=result.count, downloaded=result.downloaded, cached_at=result.cached_at
        )

    return download


def catalogue_download(holder: CatalogueHolder, load: CatalogueLoad, *, provider: str) -> Download:
    """Load a provider's table and publish it, as one thing a download registry can run."""

    async def download(_: datetime, force: bool) -> DownloadReport:
        result = await load(force=force)
        holder.publish(provider, result.catalogue)
        return DownloadReport(
            count=len(result.catalogue), downloaded=result.downloaded, cached_at=result.cached_at
        )

    return download


def register_instrument_load(
    registry: TaskRegistry,
    loader: InstrumentLoader,
    holder: InstrumentRegistryHolder,
    *,
    broker: str,
    exchanges: Sequence[str] | None = None,
    downloads: InstrumentDownloads,
) -> None:
    """Load one broker's instrument master at DAY_INIT.

    Registered for every venue by default, not for one designated venue. The
    master is a broker-level artifact, and a venue-scoped registration would
    leave an MCX-only day -- an equity holiday on which commodities trade --
    with no instruments at all. Repeat runs are cheap: the second venue's
    DAY_INIT finds the cache fresh and re-indexes without downloading.

    A failure propagates. The runner then leaves DAY_INIT unrecorded and tries
    again on the next pass, which is what turns a broker that is unreachable
    for a minute at six in the morning into a delay rather than a lost day.

    The load is registered with ``downloads`` so that a login and the
    Console's button run the very same load, and the status the Console shows
    is the one this task wrote.
    """
    name = master_name(broker)
    downloads.register(
        name, master_download(loader, holder, broker=broker), kind="master", provider=broker
    )

    async def load(context: PhaseContext) -> None:
        # Not throttled: the runner is the retry here, on its own cadence.
        status = await downloads.refresh(name, throttle=False)
        if status.last_error is not None:
            raise MasterLoadError(status.last_error)
        logger.info(
            "instrument master loaded: broker=%s instruments=%d downloaded=%s "
            "cached_at=%s venue=%s day=%s",
            broker,
            status.count,
            status.last_downloaded,
            status.cached_at.isoformat() if status.cached_at else "-",
            context.exchange.code,
            context.trading_day,
        )

    registry.register(
        DayPhase.DAY_INIT, load, name=f"instrument-master:{broker}", exchanges=exchanges
    )


def register_provider_catalogue(
    registry: TaskRegistry,
    holder: CatalogueHolder,
    load: CatalogueLoad,
    *,
    provider: str,
    exchanges: Sequence[str] | None = None,
    downloads: InstrumentDownloads,
) -> None:
    """Load one data provider's translation table at DAY_INIT.

    Separate from the instrument master, and after it in nothing: the two are
    independent. The master says what exists; this says what the provider
    calls it. A provider that is not the active one still gets its table
    loaded, which costs a download and means switching provider mid-day does
    not need a restart.

    A failure does **not** propagate. An engine whose feed provider has no
    catalogue carries no ticks, and that is worth a loud log -- but taking
    DAY_INIT down with it would also cost the instrument master, the venues
    and every trade loop, on a day the operator may not even be using this
    provider.
    """
    name = catalogue_name(provider)
    downloads.register(
        name,
        catalogue_download(holder, load, provider=provider),
        kind="catalogue",
        provider=provider,
    )

    async def load_catalogue(_: PhaseContext) -> None:
        status = await downloads.refresh(name, throttle=False)
        if status.last_error is not None:
            logger.error(
                "%s: its catalogue could not be loaded (%s), so it can carry no data today. "
                "Choose another provider or fix the download.",
                provider,
                status.last_error,
            )

    registry.register(
        DayPhase.DAY_INIT, load_catalogue, name=f"catalogue:{provider}", exchanges=exchanges
    )


def register_feed_lifecycle(
    registry: TaskRegistry,
    service: MarketDataService,
    exchanges: Sequence[Exchange],
) -> None:
    """Run market data for as long as any venue is trading.

    **The feed is one connection across every venue that broker covers, and
    the day model is per-venue.** Those do not line up, and taking the obvious
    route -- stop the feed at a venue's SESSION_CLOSE -- cuts commodities off
    at half past three because equities closed. So the close task asks whether
    any *other* venue is still open, and only the last one out stops the feed.

    Start is the mirror image and needs no such care: the first venue to reach
    ALGO_START brings the feed up and the rest find it already running.

    At DAY_INIT the feed is taken down and the cached prices cleared. A
    connection held over from yesterday carries expired credentials, and a
    cache with no expiry will serve Friday's last traded price on Monday
    morning until the first real tick arrives -- which for an illiquid strike
    can be an hour into the session.

    **That reset happens once a day, not once a venue.** The runner walks each
    venue through its whole day in turn, so by the time the second venue
    reaches DAY_INIT the first has already started the feed and filled the
    cache; resetting again would close a working connection and discard live
    prices. The reference engine could not hit this -- it had one global
    day-init rather than one per venue.
    """
    by_code = {exchange.code: exchange for exchange in exchanges}
    reset_for: dict[str, date] = {}

    async def reset(context: PhaseContext) -> None:
        if reset_for.get("day") == context.trading_day:
            logger.debug(
                "%s: market data was already reset for %s",
                context.exchange.code,
                context.trading_day,
            )
            return
        reset_for["day"] = context.trading_day
        await service.stop()
        cleared = service.hub.clear_latest()
        logger.info(
            "market data reset for %s: %d cached prices cleared",
            context.trading_day,
            cleared,
        )

    async def start(context: PhaseContext) -> None:
        if service.is_running:
            return
        connected = await service.start()
        if not connected:
            # Not raised: the monitor retries, and failing the phase would
            # re-run day-init's other tasks for a provider that is simply
            # down for a minute.
            logger.warning(
                "market data started for %s but the feed is not connected yet",
                context.exchange.code,
            )

    async def stop_if_last(context: PhaseContext) -> None:
        still_open = [
            code
            for code, exchange in by_code.items()
            if code != context.exchange.code and exchange.is_open(context.now)
        ]
        if still_open:
            logger.info(
                "%s closed; keeping the feed up for %s",
                context.exchange.code,
                ", ".join(sorted(still_open)),
            )
            return
        await service.stop()

    registry.register(DayPhase.DAY_INIT, reset, name="market-data:reset")
    registry.register(DayPhase.ALGO_START, start, name="market-data:start")
    registry.register(DayPhase.SESSION_CLOSE, stop_if_last, name="market-data:stop")
