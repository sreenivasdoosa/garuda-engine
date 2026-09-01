"""The holiday endpoints, against a real database."""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import holidays
from garuda.persistence import models

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(holidays.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def venues(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """NSE and BSE exist; a holiday may only be attached to a venue that does."""
    async with session_factory() as session:
        for code, name in (("NSE", "National Stock Exchange"), ("BSE", "Bombay Stock Exchange")):
            session.add(
                models.ExchangesRow(
                    exchange_code=code,
                    exchange_name=name,
                    currency="INR",
                    segments="EQUITY",
                    market_open=dt.time(9, 15),
                    market_close=dt.time(15, 30),
                )
            )
        await session.commit()


async def add(
    client: httpx.AsyncClient, exchange: str, date: str, description: str | None = None
) -> httpx.Response:
    body: dict[str, str] = {"exchange": exchange, "date": date}
    if description is not None:
        body["description"] = description
    return await client.post("/api/holidays", json=body)


async def test_lists_one_exchanges_holidays_oldest_first(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, "NSE", "2026-03-14", "Holi")
    await add(client, "NSE", "2026-01-26", "Republic Day")
    await add(client, "BSE", "2026-08-15", "Independence Day")

    body = (await client.get("/api/holidays/NSE")).json()

    assert [row["date"] for row in body["data"]] == ["2026-01-26", "2026-03-14"]
    assert [row["description"] for row in body["data"]] == ["Republic Day", "Holi"]
    assert {row["exchange"] for row in body["data"]} == {"NSE"}


async def test_an_exchange_with_no_holidays_lists_nothing(
    client: httpx.AsyncClient, venues: None
) -> None:
    body = (await client.get("/api/holidays/NSE")).json()

    assert body["success"] is True
    assert body["data"] == []


async def test_an_unknown_exchange_lists_nothing_rather_than_404ing(
    client: httpx.AsyncClient,
) -> None:
    """The Console asks for each exchange in turn while building its table. A
    404 partway through that reads as a failure rather than as "none"."""
    response = await client.get("/api/holidays/XSE")

    assert response.status_code == 200
    assert response.json()["data"] == []


async def test_the_exchange_code_is_matched_case_insensitively(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, "nse", "2026-01-26")

    assert (await client.get("/api/holidays/NSE")).json()["data"][0]["exchange"] == "NSE"
    assert len((await client.get("/api/holidays/nse")).json()["data"]) == 1


async def test_creates_a_holiday(client: httpx.AsyncClient, venues: None) -> None:
    response = await add(client, "NSE", "2026-01-26", "Republic Day")

    assert response.status_code == 200
    assert response.json()["data"] == {
        "exchange": "NSE",
        "date": "2026-01-26",
        "description": "Republic Day",
    }


async def test_a_description_is_optional_and_blank_means_none(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, "NSE", "2026-01-26")
    await add(client, "NSE", "2026-03-14", "")

    stored = {
        row["date"]: row["description"]
        for row in (await client.get("/api/holidays/NSE")).json()["data"]
    }
    assert stored == {"2026-01-26": None, "2026-03-14": None}


async def test_a_holiday_for_an_exchange_that_does_not_exist_is_refused(
    client: httpx.AsyncClient, venues: None
) -> None:
    """Not a harmless orphan.

    The venue loader groups holidays by exchange code, so one that matches no
    venue is never read -- and the day it describes stays open, which is the
    failure that costs money.
    """
    response = await add(client, "XSE", "2026-01-26")

    assert response.status_code == 404
    assert "XSE" in response.json()["message"]


async def test_the_same_day_twice_is_refused_rather_than_overwriting(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, "NSE", "2026-01-26", "Republic Day")

    response = await add(client, "NSE", "2026-01-26", "Something Else")

    assert response.status_code == 409
    assert (await client.get("/api/holidays/NSE")).json()["data"][0]["description"] == (
        "Republic Day"
    )


async def test_the_same_day_on_a_different_exchange_is_fine(
    client: httpx.AsyncClient, venues: None
) -> None:
    """The key is the pair. Two venues shut on the same day is the normal case."""
    assert (await add(client, "NSE", "2026-01-26")).status_code == 200
    assert (await add(client, "BSE", "2026-01-26")).status_code == 200


@pytest.mark.parametrize("bad", ["26-01-2026", "2026-13-01", "not a date", "2026-02-30", ""])
async def test_a_date_that_is_not_one_is_refused(
    client: httpx.AsyncClient, venues: None, bad: str
) -> None:
    response = await add(client, "NSE", bad)

    assert response.status_code == 400
    assert (await client.get("/api/holidays/NSE")).json()["data"] == []


async def test_updates_only_the_description(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, "NSE", "2026-01-26", "Republic Day")

    response = await client.put(
        "/api/holidays/NSE/2026-01-26", json={"description": "Republic Day (observed)"}
    )

    assert response.status_code == 200
    row = (await client.get("/api/holidays/NSE")).json()["data"][0]
    assert row["description"] == "Republic Day (observed)"
    assert row["date"] == "2026-01-26"


async def test_updating_a_day_that_is_not_a_holiday_is_a_404(
    client: httpx.AsyncClient, venues: None
) -> None:
    response = await client.put("/api/holidays/NSE/2026-01-26", json={"description": "x"})

    assert response.status_code == 404


async def test_deletes_a_holiday(client: httpx.AsyncClient, venues: None) -> None:
    await add(client, "NSE", "2026-01-26")
    await add(client, "NSE", "2026-03-14")

    response = await client.delete("/api/holidays/nse/2026-01-26")

    assert response.status_code == 200
    assert [row["date"] for row in (await client.get("/api/holidays/NSE")).json()["data"]] == [
        "2026-03-14"
    ]


async def test_deleting_one_that_is_not_there_is_a_404(
    client: httpx.AsyncClient, venues: None
) -> None:
    assert (await client.delete("/api/holidays/NSE/2026-01-26")).status_code == 404


async def test_deleting_leaves_the_other_exchange_alone(
    client: httpx.AsyncClient, venues: None
) -> None:
    await add(client, "NSE", "2026-01-26")
    await add(client, "BSE", "2026-01-26")

    await client.delete("/api/holidays/NSE/2026-01-26")

    assert len((await client.get("/api/holidays/BSE")).json()["data"]) == 1
