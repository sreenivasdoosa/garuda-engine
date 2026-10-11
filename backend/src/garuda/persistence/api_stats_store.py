"""Writing each timed broker call, and purging the old ones.

The reference engine queued these and wrote them from a thread, behind a
system-config flag, and deleted rows older than five days at startup. One
operator's accounts make a few thousand calls a day, so the flag is not
ported: every call is written, and the purge bounds the table.

**A failed write costs the row, never the call.** The order was already
placed or the book already fetched; the row is an account of it.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import delete

from garuda.persistence.models import BrokerApiStatsRow

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

logger = logging.getLogger(__name__)


class ApiStatsStore:
    """One row per timed call."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def record(
        self,
        *,
        broker: str,
        operation: str,
        order_id: str | None,
        started_at: datetime,
        ended_at: datetime,
    ) -> None:
        row = BrokerApiStatsRow(
            broker_name=broker,
            operation=operation,
            order_id=order_id,
            start_time=started_at,
            end_time=ended_at,
            time_taken=int((ended_at - started_at).total_seconds() * 1000),
        )
        try:
            async with self._sessions() as session:
                session.add(row)
                await session.commit()
        except Exception:
            logger.exception("%s %s: the API stat was not written", broker, operation)

    async def purge_before(self, cutoff: datetime) -> int:
        """Drop rows older than ``cutoff``. The reference's five-day sweep."""
        try:
            async with self._sessions() as session:
                result = await session.execute(
                    delete(BrokerApiStatsRow).where(BrokerApiStatsRow.start_time < cutoff)
                )
                await session.commit()
                count = int(getattr(result, "rowcount", 0) or 0)
                if count:
                    logger.info("%d broker API stat row(s) before %s purged", count, cutoff)
                return count
        except Exception:
            logger.exception("the old broker API stats could not be purged")
            return 0
