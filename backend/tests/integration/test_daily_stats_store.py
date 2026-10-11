"""The day's order counts, as the engine writes them and reads them back.

Behavioural: orders go in through the store the gate uses, and the claims
are about the row -- the counts and quantities by side -- about the total a
restart reads, and about the one thing that must hold at the edge: a row
that cannot be written costs the row, never the order, and tells the
operator once.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.core.clock import ReplayClock
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.persistence.daily_stats_store import DailyStatsStore
from garuda.persistence.models import RmsDailyStatsRow, TradingClientRow

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 12, 4, 0, tzinfo=dt.UTC)
MONDAY = dt.date(2026, 10, 12)
APPA = TradingClientId("appa")


class Alerts:
    def __init__(self) -> None:
        self.raised: list[dict[str, Any]] = []

    async def critical(
        self, entity_type: EntityType, entity: str, operation: str, message: str, *, key: str | None
    ) -> None:
        self.raised.append(
            {"entity": entity, "operation": operation, "key": key, "message": message}
        )


@pytest.fixture
async def appa(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(
            TradingClientRow(
                id="appa",
                display_name="Appa",
                broker="ZERODHA",
                client_id="AB1234",
                enabled=True,
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()


async def rows(sessions: async_sessionmaker[AsyncSession]) -> list[RmsDailyStatsRow]:
    async with sessions() as session:
        return list((await session.execute(select(RmsDailyStatsRow))).scalars())


async def test_each_order_sent_adds_to_the_days_row(
    session_factory: async_sessionmaker[AsyncSession], appa: None
) -> None:
    store = DailyStatsStore(session_factory, ReplayClock(NOW), label="Appa")

    assert await store.increment(APPA, "RELIANCE", MONDAY, is_buy=True, quantity=10)
    assert await store.increment(APPA, "RELIANCE", MONDAY, is_buy=True, quantity=15)
    assert await store.increment(APPA, "RELIANCE", MONDAY, is_buy=False, quantity=25)
    assert await store.increment(APPA, "NIFTY26OCT25000CE", MONDAY, is_buy=False, quantity=65)

    by_symbol = {row.trading_symbol: row for row in await rows(session_factory)}
    reliance = by_symbol["RELIANCE"]
    assert reliance.order_count == 3
    assert reliance.buy_order_count == 2
    assert reliance.sell_order_count == 1
    assert reliance.buy_qty == 25
    assert reliance.sell_qty == 25
    assert by_symbol["NIFTY26OCT25000CE"].order_count == 1
    assert await store.total_today(APPA, MONDAY) == 4, "every symbol together"
    assert await store.total_today(APPA, MONDAY + dt.timedelta(days=1)) == 0


async def test_a_row_that_cannot_be_written_tells_the_operator_once(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """No such account: the key refuses the row. The order is not this store's
    to stop, and the alert is one per account and day."""
    alerts = Alerts()
    store = DailyStatsStore(session_factory, ReplayClock(NOW), label="Nobody", alerts=alerts)

    first = await store.increment(
        TradingClientId("nobody"), "RELIANCE", MONDAY, is_buy=True, quantity=1
    )
    second = await store.increment(
        TradingClientId("nobody"), "RELIANCE", MONDAY, is_buy=True, quantity=1
    )

    assert first is False
    assert second is False
    assert await rows(session_factory) == []
    assert [a["key"] for a in alerts.raised] == ["daily-stats-nobody-2026-10-12"] * 2, (
        "the same key each time; the alert manager is what coalesces them"
    )
    assert "restart would under-count" in alerts.raised[0]["message"]
