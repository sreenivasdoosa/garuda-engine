"""Broker API stats, as the engine writes them and the Console reads them.

Behavioural: timed calls go in through the store the meter uses, and the
claims are about what the page gets for a day and a broker, what the
startup sweep removes, and that a write that fails costs only the row.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import broker_api_stats
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.persistence.api_stats_store import ApiStatsStore

pytestmark = pytest.mark.integration

#: 09:30 in Kolkata on Monday the 12th.
NOW = dt.datetime(2026, 10, 12, 4, 0, tzinfo=dt.UTC)


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(
            models.ExchangesRow(
                exchange_code="NSE",
                exchange_name="NSE",
                timezone="Asia/Kolkata",
                currency="INR",
                segments="EQUITY,FNO",
                market_open=dt.time(9, 15),
                market_close=dt.time(15, 30),
            )
        )
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.include_router(broker_api_stats.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def timed(
    store: ApiStatsStore,
    *,
    broker: str = "zerodha",
    operation: str = "place",
    order_id: str | None = "251012000001",
    at: dt.datetime = NOW,
    took: dt.timedelta = dt.timedelta(milliseconds=250),
) -> None:
    await store.record(
        broker=broker, operation=operation, order_id=order_id, started_at=at, ended_at=at + took
    )


async def test_a_day_is_read_newest_first_for_one_broker_or_all(
    client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
) -> None:
    store = ApiStatsStore(session_factory)
    await timed(store, at=NOW)
    await timed(store, operation="fetch_orders", order_id=None, at=NOW + dt.timedelta(minutes=1))
    await timed(store, broker="dhan", operation="place", at=NOW + dt.timedelta(minutes=2))
    # 23:30 on the 11th in Kolkata: the day before, on the venue's clock.
    await timed(store, at=dt.datetime(2026, 10, 11, 18, 0, tzinfo=dt.UTC))

    response = await client.get("/api/broker-api-stats", params={"date": "2026-10-12"})
    assert response.status_code == 200, response.text
    rows = response.json()["data"]
    assert [(r["broker"], r["operation"]) for r in rows] == [
        ("dhan", "place"),
        ("zerodha", "fetch_orders"),
        ("zerodha", "place"),
    ]
    assert rows[-1]["entityId"] == "251012000001"
    assert rows[-1]["timeTaken"] == 250
    assert rows[-1]["startEpoch"] == int(NOW.timestamp() * 1000)

    mine = (
        await client.get(
            "/api/broker-api-stats", params={"broker": "zerodha", "date": "2026-10-12"}
        )
    ).json()["data"]
    assert len(mine) == 2
    today = (await client.get("/api/broker-api-stats")).json()["data"]
    assert len(today) == 3, "no date: the venue's today"
    assert (await client.get("/api/broker-api-stats", params={"date": "today"})).status_code == 400


async def test_the_startup_sweep_removes_rows_older_than_five_days(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    store = ApiStatsStore(session_factory)
    await timed(store, at=NOW - dt.timedelta(days=6))
    await timed(store, at=NOW - dt.timedelta(days=4))
    await timed(store, at=NOW)

    removed = await store.purge_before(NOW - dt.timedelta(days=5))

    assert removed == 1
    async with session_factory() as session:
        left = list((await session.execute(select(models.BrokerApiStatsRow))).scalars())
    assert sorted(r.start_time for r in left if r.start_time) == [NOW - dt.timedelta(days=4), NOW]
