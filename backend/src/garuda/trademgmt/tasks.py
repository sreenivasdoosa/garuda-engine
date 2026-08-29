"""Trade management across the trading day.

The cycle runs while the market does, and the pre-open pass runs before it.
Both are attached to venue phases rather than to clock times, so a venue in
another timezone needs configuration rather than code.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase
from garuda.trademgmt.loop import TradeLoops

logger = logging.getLogger(__name__)


def register_trade_loops(
    registry: TaskRegistry, loops: TradeLoops, exchanges: Sequence[Exchange]
) -> None:
    """Run trade management for as long as any venue is trading.

    Started once a day, not once a venue. The engine walks each venue through
    its whole day in turn, so the second venue's PRE_OPEN arrives after the
    first has already started the cycles; starting again would run the
    reconciliation pass over accounts that are already trading.

    Stopped by the last venue out, for the mirror-image reason: one account
    holds positions across venues, and stopping when equities close would
    leave a commodity position untended for eight hours.
    """
    by_code = {exchange.code: exchange for exchange in exchanges}
    started_for: dict[str, date] = {}

    async def start(context: PhaseContext) -> None:
        if started_for.get("day") == context.trading_day:
            return
        started_for["day"] = context.trading_day
        await loops.start()
        logger.info(
            "trade management running for %d accounts on %s",
            len(loops.running),
            context.trading_day,
        )

    async def stop_if_last(context: PhaseContext) -> None:
        still_open = [
            code
            for code, exchange in by_code.items()
            if code != context.exchange.code and exchange.is_open(context.now)
        ]
        if still_open:
            logger.info(
                "%s closed; trade management continues for %s",
                context.exchange.code,
                ", ".join(sorted(still_open)),
            )
            return
        await loops.stop()
        started_for.pop("day", None)

    # PRE_OPEN rather than SESSION_OPEN: the reconciliation has to finish
    # before the first price arrives, or the open is traded against a book
    # that has not yet been compared with the broker.
    registry.register(DayPhase.PRE_OPEN, start, name="trade-management:start")
    registry.register(DayPhase.SESSION_CLOSE, stop_if_last, name="trade-management:stop")
