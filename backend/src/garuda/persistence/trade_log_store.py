"""Keeping a trade's timeline.

`TradeLogRepository` in the reference engine. One row per event, written as
the event happens; the Console reads them back as the trade's timeline and
as the cross-trade log.

**A failed write never changes the outcome.** The order went out, or did
not, before this ran; the row is an account of it. So this never raises --
a store that is down costs the timeline, and says so in the log, rather
than costing the trade.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from garuda.persistence.models import TradeLogRow
from garuda.persistence.uow import UnitOfWork

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.domain.trade_log import TradeLogEntry

logger = logging.getLogger(__name__)


class TradeLogStore:
    """Writes timeline entries, and never gets in the trade's way."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], *, label: str = "") -> None:
        self._sessions = sessions
        self._label = label

    async def write(self, entry: TradeLogEntry) -> None:
        row = TradeLogRow(
            trading_client_id=entry.trading_client.value,
            trade_id=entry.trade_id,
            strategy=entry.strategy,
            trading_symbol=entry.trading_symbol,
            hedge_correlation_id=entry.hedge_correlation_id,
            event_category=entry.category.value,
            event_type=entry.event_type.value,
            event_timestamp=entry.at,
            order_id=entry.order_id,
            order_status=entry.order_status,
            order_type=entry.order_type,
            price=entry.price,
            quantity=entry.quantity,
            filled_quantity=entry.filled_quantity,
            sl_price=entry.sl_price,
            target_price=entry.target_price,
            message=entry.message,
            details=dict(entry.details) if entry.details is not None else None,
            error_message=entry.error_message,
            created_at=entry.at,
        )
        try:
            async with UnitOfWork(self._sessions) as uow:
                uow.session.add(row)
        except Exception:
            logger.exception(
                "%s: could not record %s for trade %s",
                self._label,
                entry.event_type,
                entry.trade_id,
            )
