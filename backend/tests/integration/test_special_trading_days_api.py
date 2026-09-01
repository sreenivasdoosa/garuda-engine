"""The special-trading-day endpoints, against a real database."""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import special_trading_days
from garuda.persistence import models

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(special_trading_days.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def venues(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        for code in ("NSE", "BSE"):
            session.add(
                models.ExchangesRow(
                    exchange_code=code,
                    exchange_name=code,
                    currency="INR",
                    segments="EQUITY",
                    market_open=dt.time(9, 15),
                    market_close=dt.time(15, 30),
                )
            )
        await session.commit()


async def add(client: httpx.AsyncClient, **body: Any) -> httpx.Response:
    return await client.post("/api/special-trading-days", json=body)


BUDGET = {"exchange": "NSE", "tradingDate": "2026-09-05", "tradingDayName": "Union Budget"}


async def test_creates_a_day_with_no_hours_of_its_own(
    client: httpx.AsyncClient, venues: None
) -> None:
    """Budget on a Saturday: normal hours, so the row says nothing about them."""
    response = await add(client, **BUDGET)

    assert response.status_code == 200
    assert response.json()["data"] == {
        "exchange": "NSE",
        "tradingDate": "2026-09-05",
        "tradingDayName": "Union Budget",
        "marketOpen": None,
        "marketClose": None,
    }


async def test_creates_a_day_with_its_own_hours(client: httpx.AsyncClient, venues: None) -> None:
    """Diwali muhurat: a short evening session."""
    response = await add(
        client,
        exchange="NSE",
        tradingDate="2026-11-08",
        tradingDayName="Diwali Muhurat",
        marketOpen="18:15",
        marketClose="19:15",
    )

    assert response.json()["data"]["marketOpen"] == "18:15"
    assert response.json()["data"]["marketClose"] == "19:15"


async def test_one_side_of_the_hours_is_refused(client: httpx.AsyncClient, venues: None) -> None:
    """The loader would fall back to the venue's usual hours, which reads as
    the edit having been ignored. Refuse while there is someone to tell."""
    response = await add(client, **BUDGET, marketOpen="18:15")

    assert response.status_code == 400
    assert "both" in response.json()["message"]
    assert (await client.get("/api/special-trading-days")).json()["data"] == []


async def test_hours_that_close_before_they_open_are_refused(
    client: httpx.AsyncClient, venues: None
) -> None:
    response = await add(client, **BUDGET, marketOpen="19:15", marketClose="18:15")

    assert response.status_code == 400
    assert "before" in response.json()["message"]


async def test_lists_every_venues_days_oldest_first(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, exchange="NSE", tradingDate="2026-11-08", tradingDayName="Muhurat")
    await add(client, **BUDGET)
    await add(client, exchange="BSE", tradingDate="2026-09-05", tradingDayName="Union Budget")

    rows = (await client.get("/api/special-trading-days")).json()["data"]

    assert [row["tradingDate"] for row in rows] == ["2026-09-05", "2026-09-05", "2026-11-08"]


async def test_lists_one_venues_days(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, **BUDGET)
    await add(client, exchange="BSE", tradingDate="2026-09-05")

    rows = (await client.get("/api/special-trading-days/nse")).json()["data"]

    assert [row["exchange"] for row in rows] == ["NSE"]


async def test_an_unknown_venue_lists_nothing_rather_than_404ing(
    client: httpx.AsyncClient,
) -> None:
    response = await client.get("/api/special-trading-days/XSE")

    assert response.status_code == 200
    assert response.json()["data"] == []


async def test_a_day_for_a_venue_that_does_not_exist_is_refused(
    client: httpx.AsyncClient, venues: None
) -> None:
    """The loader keys these by exchange code. One matching no venue is never
    read, so the day it was meant to open stays shut."""
    response = await add(client, exchange="XSE", tradingDate="2026-09-05")

    assert response.status_code == 404
    assert "XSE" in response.json()["message"]


async def test_the_same_day_twice_is_refused(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, **BUDGET)

    response = await add(client, exchange="NSE", tradingDate="2026-09-05", tradingDayName="Other")

    assert response.status_code == 409
    rows = (await client.get("/api/special-trading-days/NSE")).json()["data"]
    assert rows[0]["tradingDayName"] == "Union Budget"


async def test_the_same_day_on_another_venue_is_fine(
    client: httpx.AsyncClient, venues: None
) -> None:
    assert (await add(client, **BUDGET)).status_code == 200
    assert (await add(client, exchange="BSE", tradingDate="2026-09-05")).status_code == 200


@pytest.mark.parametrize("bad", ["05-09-2026", "2026-02-30", "not a date", ""])
async def test_a_date_that_is_not_one_is_refused(
    client: httpx.AsyncClient, venues: None, bad: str
) -> None:
    assert (await add(client, exchange="NSE", tradingDate=bad)).status_code == 400


async def test_updates_the_name_and_the_hours(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, **BUDGET)

    response = await client.put(
        "/api/special-trading-days/NSE/2026-09-05",
        json={"tradingDayName": "Budget Session", "marketOpen": "11:00", "marketClose": "15:30"},
    )

    assert response.status_code == 200
    row = (await client.get("/api/special-trading-days/NSE")).json()["data"][0]
    assert row["tradingDayName"] == "Budget Session"
    assert row["marketOpen"] == "11:00"


async def test_an_update_with_no_hours_clears_them_back_to_the_venues_own(
    client: httpx.AsyncClient, venues: None
) -> None:
    """Not a partial update, unlike exchanges: the hours are a pair, and
    "leave them alone" is not distinguishable from "use the usual ones" in a
    form that always sends both boxes."""
    await add(client, **BUDGET, marketOpen="18:15", marketClose="19:15")

    await client.put(
        "/api/special-trading-days/NSE/2026-09-05", json={"tradingDayName": "Union Budget"}
    )

    row = (await client.get("/api/special-trading-days/NSE")).json()["data"][0]
    assert row["marketOpen"] is None
    assert row["marketClose"] is None


async def test_updating_a_day_that_is_not_special_is_a_404(
    client: httpx.AsyncClient, venues: None
) -> None:
    response = await client.put(
        "/api/special-trading-days/NSE/2026-09-05", json={"tradingDayName": "x"}
    )

    assert response.status_code == 404


async def test_deletes_a_day(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, **BUDGET)

    assert (await client.delete("/api/special-trading-days/nse/2026-09-05")).status_code == 200
    assert (await client.get("/api/special-trading-days")).json()["data"] == []


async def test_deleting_one_that_is_not_there_is_a_404(
    client: httpx.AsyncClient, venues: None
) -> None:
    assert (await client.delete("/api/special-trading-days/NSE/2026-09-05")).status_code == 404


async def test_deleting_leaves_the_other_venue_alone(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, **BUDGET)
    await add(client, exchange="BSE", tradingDate="2026-09-05")

    await client.delete("/api/special-trading-days/NSE/2026-09-05")

    assert len((await client.get("/api/special-trading-days/BSE")).json()["data"]) == 1
