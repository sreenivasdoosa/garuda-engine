"""Day allocation, as the Console edits it.

Behavioural: a strategy with no row trades full size every day; a PUT
writes the row whether or not it exists; a figure outside 0..100 is refused.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import strategy_days_allocation
from garuda.persistence import models

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 15, 4, 0, tzinfo=dt.UTC)


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(
            models.StrategyDefinitionsRow(
                strategy_name="straddle",
                underlying_symbol="NIFTY",
                exchange="NSE",
                product="INTRADAY",
                trade_mode="OPTION_SELLING",
                status="ACTIVE",
                exclude_monthly_expiry=False,
                use_premium_balancing=True,
                catch_up_missed_tranches=True,
                adaptive_tranches_enabled=False,
                use_indicator_entry=False,
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.include_router(strategy_days_allocation.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def test_no_row_means_full_size_every_day(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/strategy-days-allocation/straddle")
    assert response.status_code == 200
    body = response.json()["data"]
    assert body["strategyName"] == "straddle"
    assert {body[k] for k in ("monday", "friday", "expiryDay", "dt1Day", "dt2Day")} == {100}


async def test_a_put_writes_the_row_and_a_second_put_changes_it(client: httpx.AsyncClient) -> None:
    first = await client.put(
        "/api/strategy-days-allocation/straddle", json={"expiryDay": 50, "friday": 0}
    )
    assert first.status_code == 200, first.text
    assert (first.json()["data"]["expiryDay"], first.json()["data"]["friday"]) == (50, 0)
    assert first.json()["data"]["monday"] == 100

    second = await client.put("/api/strategy-days-allocation/straddle", json={"expiryDay": 75})
    assert second.json()["data"]["expiryDay"] == 75
    assert second.json()["data"]["friday"] == 100  # a PUT states the whole row

    listed = await client.get("/api/strategy-days-allocation")
    assert [r["strategyName"] for r in listed.json()["data"]] == ["straddle"]


async def test_a_figure_outside_the_range_is_refused(client: httpx.AsyncClient) -> None:
    response = await client.put("/api/strategy-days-allocation/straddle", json={"monday": 150})
    assert response.status_code == 400


async def test_an_unknown_strategy_is_refused(client: httpx.AsyncClient) -> None:
    response = await client.put("/api/strategy-days-allocation/nope", json={"monday": 50})
    assert response.status_code == 404


async def test_delete_returns_the_strategy_to_full_size(client: httpx.AsyncClient) -> None:
    await client.put("/api/strategy-days-allocation/straddle", json={"monday": 50})
    gone = await client.delete("/api/strategy-days-allocation/straddle")
    assert gone.status_code == 200
    again = await client.get("/api/strategy-days-allocation/straddle")
    assert again.json()["data"]["monday"] == 100
    assert (await client.delete("/api/strategy-days-allocation/straddle")).status_code == 404
