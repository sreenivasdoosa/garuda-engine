"""Market data work that belongs to a phase of the trading day.

The instrument load is registered here rather than inside the loader so the
loader stays a thing that fetches and indexes, testable without a runner, and
the decision about *when* it happens stays with the day model.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.phases import DayPhase
from garuda.marketdata.loader import InstrumentLoader, InstrumentRegistryHolder

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
        holder.publish(result.registry)
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
