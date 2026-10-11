"""Counting what each account sent today, where a restart can find it.

The gate counts orders in memory for the rate limits. That count is the
truth for the day, and it dies with the process: a restart at eleven has
sent nothing today as far as the counter knows, and an account near its
daily cap can place more than the cap allows. The reference engine keeps
the same counters and writes each order to a table as it goes, so a
restart rebuilds the day's total from the row. This is that table.

Ported from the reference's daily order tracker: one row per account,
symbol and day, incremented in place -- the count, the buy and sell
counts, the buy and sell quantities. **The write never changes the
order's outcome.** It is retried a few times with a short pause, because
most database failures are a pool or a blip that clears in a moment, and
on the last failure an operator is told, once, by a coalesced critical
alert: the in-memory count is still right for the rest of the day, but a
restart would under-count, and that is theirs to know before they restart.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from garuda.domain.alert import EntityType
from garuda.persistence.models import RmsDailyStatsRow

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.domain.client import TradingClientId
    from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: The reference's: three attempts, a hundred milliseconds apart.
WRITE_ATTEMPTS = 3
RETRY_PAUSE = timedelta(milliseconds=100)


class AlertSink(Protocol):
    async def critical(
        self, entity_type: EntityType, entity: str, operation: str, message: str, *, key: str | None
    ) -> object: ...


class DailyStatsStore:
    """Increments the day's row for an order sent, and reads the day back."""

    def __init__(
        self,
        sessions: async_sessionmaker[AsyncSession],
        clock: Clock,
        *,
        label: str = "",
        alerts: AlertSink | None = None,
    ) -> None:
        self._sessions = sessions
        self._clock = clock
        self._label = label
        self._alerts = alerts

    async def increment(
        self,
        trading_client: TradingClientId,
        trading_symbol: str,
        stat_date: date,
        *,
        is_buy: bool,
        quantity: int,
    ) -> bool:
        """One order sent. Returns whether the row was written."""
        statement = insert(RmsDailyStatsRow).values(
            trading_client_id=trading_client.value,
            trading_symbol=trading_symbol,
            stat_date=stat_date,
            order_count=1,
            buy_order_count=1 if is_buy else 0,
            sell_order_count=0 if is_buy else 1,
            buy_qty=quantity if is_buy else 0,
            sell_qty=0 if is_buy else quantity,
        )
        row = RmsDailyStatsRow
        statement = statement.on_conflict_do_update(
            index_elements=["trading_client_id", "trading_symbol", "stat_date"],
            set_={
                "order_count": func.coalesce(row.order_count, 0) + 1,
                "buy_order_count": func.coalesce(row.buy_order_count, 0) + (1 if is_buy else 0),
                "sell_order_count": func.coalesce(row.sell_order_count, 0) + (0 if is_buy else 1),
                "buy_qty": func.coalesce(row.buy_qty, 0) + (quantity if is_buy else 0),
                "sell_qty": func.coalesce(row.sell_qty, 0) + (0 if is_buy else quantity),
            },
        )
        last_error: Exception | None = None
        for attempt in range(1, WRITE_ATTEMPTS + 1):
            try:
                async with self._sessions() as session:
                    await session.execute(statement)
                    await session.commit()
                if attempt > 1:
                    logger.info(
                        "%s: daily stats written on attempt %d for %s",
                        self._label,
                        attempt,
                        trading_symbol,
                    )
                return True
            except Exception as error:
                last_error = error
                logger.error(
                    "%s: daily stats not written (attempt %d of %d) for %s: %s",
                    self._label,
                    attempt,
                    WRITE_ATTEMPTS,
                    trading_symbol,
                    error,
                )
                if attempt < WRITE_ATTEMPTS:
                    await self._clock.sleep(RETRY_PAUSE)
        if self._alerts is not None:
            try:
                await self._alerts.critical(
                    EntityType.SYSTEM,
                    self._label or trading_client.value,
                    "daily-stats",
                    f"the day's order count for {trading_symbol} could not be written after "
                    f"{WRITE_ATTEMPTS} attempts: {last_error}. The engine's own count is "
                    "right for the rest of the day, but a restart would under-count and "
                    "the daily order caps would reset lower than reality.",
                    key=f"daily-stats-{trading_client.value}-{stat_date.isoformat()}",
                )
            except Exception:
                logger.exception("%s: could not raise the daily-stats alert", self._label)
        return False

    async def total_today(self, trading_client: TradingClientId, stat_date: date) -> int:
        """How many orders the account sent on a day, by the rows. Zero if unknown."""
        statement = (
            select(func.coalesce(func.sum(RmsDailyStatsRow.order_count), 0))
            .where(RmsDailyStatsRow.trading_client_id == trading_client.value)
            .where(RmsDailyStatsRow.stat_date == stat_date)
        )
        try:
            async with self._sessions() as session:
                return int((await session.execute(statement)).scalar_one() or 0)
        except Exception:
            # Unknown is zero here on purpose: a restart that cannot read the
            # table errs towards letting the account trade, which is the
            # rate counter's own rule, and the broker's daily cap is the backstop.
            logger.exception("%s: could not read the day's order count", self._label)
            return 0
