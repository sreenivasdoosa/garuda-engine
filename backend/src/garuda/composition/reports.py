"""The day's P&L, written at the REPORTS phase.

The reference writes its end-of-day P&L rows from a job after the close
and reads its reports from them. Garuda's pages read the trades, so a
report is right the moment a trade closes; this task is the durable
record of the same figures, one row per account, strategy, product and
paper flag for the trading day, in the table the reference's page read.

Idempotent: the rows are upserted by their key, so a REPORTS phase that
runs again after a restart rewrites the same day rather than doubling it.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase
from garuda.domain.trade_serde import decode_trade
from garuda.persistence import models
from garuda.persistence.uow import UnitOfWork
from garuda.reports.trades import daily_rows, trade_row

logger = logging.getLogger(__name__)


async def write_daily_pnl(
    sessions: async_sessionmaker[AsyncSession], exchange: Exchange, trading_day: dt.date
) -> int:
    """Sum the day's closed trades and write them. Returns rows written."""
    zone = exchange.timezone
    lower = dt.datetime.combine(trading_day, dt.time.min, tzinfo=zone)
    upper = lower + dt.timedelta(days=1)
    table = models.LiveTradesRow
    async with UnitOfWork(sessions) as uow:
        stored = (
            await uow.session.execute(
                select(table)
                .where(table.state == "COMPLETED")
                .where(func.coalesce(table.end_timestamp, table.start_timestamp) >= lower)
                .where(func.coalesce(table.end_timestamp, table.start_timestamp) < upper)
            )
        ).scalars()
        rows = []
        for row in stored:
            try:
                rows.append(trade_row(decode_trade(row.payload), zone))
            except Exception:
                logger.exception("trade %s could not be read for the day's P&L", row.trade_id)
        days = daily_rows(rows, by_strategy=True, by_account=True, by_product=True)
        written = 0
        for day in days:
            if day.trading_client_id is None or day.strategy is None or day.product is None:
                continue
            await uow.repositories.eod_pnl_reports.upsert(
                {
                    "trading_client_id": day.trading_client_id,
                    "date": day.trading_day,
                    "strategy_name": day.strategy[:30],
                    "product": day.product,
                    "is_paper_trading": day.is_paper,
                    "capital": None,
                    "profit_loss": day.gross_pnl.amount,
                    # Not computed until the charges phase; null, never a zero.
                    "charges": None,
                    "net_profit_loss": day.net_pnl.amount,
                    "mtf_interest": None,
                },
                conflict_on=[
                    "trading_client_id",
                    "date",
                    "strategy_name",
                    "product",
                    "is_paper_trading",
                ],
            )
            written += 1
        await uow.session.commit()
    logger.info("%s %s: daily P&L written, %d row(s)", exchange.code, trading_day, written)
    return written


def register_daily_pnl(
    registry: TaskRegistry,
    sessions: async_sessionmaker[AsyncSession],
    exchanges: Sequence[Exchange],
) -> None:
    """Write the day's P&L at each venue's REPORTS phase."""

    async def task(context: PhaseContext) -> None:
        await write_daily_pnl(sessions, context.exchange, context.trading_day)

    registry.register(
        DayPhase.REPORTS, task, name="reports:daily-pnl", exchanges=[e.code for e in exchanges]
    )
