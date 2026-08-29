"""Market data work that belongs to a phase of the trading day.

The instrument load is registered here rather than inside the loader so the
loader stays a thing that fetches and indexes, testable without a runner, and
the decision about *when* it happens stays with the day model.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase
from garuda.marketdata.loader import InstrumentLoader, InstrumentRegistryHolder
from garuda.marketdata.service import MarketDataService

logger = logging.getLogger(__name__)


def register_instrument_load(
    registry: TaskRegistry,
    loader: InstrumentLoader,
    holder: InstrumentRegistryHolder,
    *,
    broker: str,
    exchanges: Sequence[str] | None = None,
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
    """

    async def load(context: PhaseContext) -> None:
        result = await loader.load(context.now)
        holder.publish(broker, result.registry)
        logger.info(
            "instrument master loaded: broker=%s instruments=%d downloaded=%s "
            "cached_at=%s venue=%s day=%s",
            broker,
            result.count,
            result.downloaded,
            result.cached_at.isoformat(),
            context.exchange.code,
            context.trading_day,
        )
        for trading_symbol, reason in result.skipped:
            # Individually, so a single unparseable row is searchable rather
            # than buried in a count.
            logger.warning("instrument skipped: broker=%s %s: %s", broker, trading_symbol, reason)

    registry.register(
        DayPhase.DAY_INIT, load, name=f"instrument-master:{broker}", exchanges=exchanges
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
