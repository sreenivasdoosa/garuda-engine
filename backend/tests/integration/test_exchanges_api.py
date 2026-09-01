"""The exchanges endpoints, against a real database.

Behavioural throughout: every assertion is on what came back over HTTP or on
what a later read shows, never on how the router is written. The router is
built directly rather than through `create_app`, because these tests are about
venues and not about signing in.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator

import httpx
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import exchanges
from garuda.persistence import models

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    from fastapi import FastAPI

    app = FastAPI()
    envelope.install(app)
    app.include_router(exchanges.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def nse(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        session.add(
            models.ExchangesRow(
                exchange_code="NSE",
                exchange_name="National Stock Exchange",
                currency="INR",
                timezone="Asia/Kolkata",
                segments="EQUITY,FNO",
                market_open=dt.time(9, 15),
                market_close=dt.time(15, 30),
                report_minutes_after_close=15,
                weekend_days="SATURDAY,SUNDAY",
                is_active=True,
            )
        )
        await session.commit()


async def test_lists_what_is_stored(client: httpx.AsyncClient, nse: None) -> None:
    body = (await client.get("/api/exchanges")).json()

    assert body["success"] is True
    assert [row["exchange"] for row in body["data"]] == ["NSE"]
    venue = body["data"][0]
    assert venue["marketOpen"] == "09:15"
    assert venue["marketClose"] == "15:30"
    # Stored comma-separated in one column; a list on the wire, because a list
    # is what it is.
    assert venue["segments"] == ["EQUITY", "FNO"]
    assert venue["weekendDays"] == ["SATURDAY", "SUNDAY"]


async def test_an_empty_database_lists_nothing_rather_than_failing(
    client: httpx.AsyncClient,
) -> None:
    body = (await client.get("/api/exchanges")).json()

    assert body["success"] is True
    assert body["data"] == []


async def test_fetches_one_by_code_case_insensitively(
    client: httpx.AsyncClient, nse: None
) -> None:
    for code in ("NSE", "nse", "Nse"):
        response = await client.get(f"/api/exchanges/{code}")
        assert response.status_code == 200
        assert response.json()["data"]["exchange"] == "NSE"


async def test_an_unknown_code_is_a_404_naming_it(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/exchanges/XSE")

    assert response.status_code == 404
    assert "XSE" in response.json()["message"]


async def test_an_update_touches_only_the_fields_sent(
    client: httpx.AsyncClient, nse: None
) -> None:
    """The whole point of the partial update.

    The Console's exchange form round-trips some fields and not others. If an
    absent field were read as ``null``, saving the report offset would blank
    the venue's name, its hours and its segments.
    """
    response = await client.put("/api/exchanges/NSE", json={"reportMinutesAfterClose": 25})

    assert response.status_code == 200
    saved = response.json()["data"]
    assert saved["reportMinutesAfterClose"] == 25
    assert saved["exchangeName"] == "National Stock Exchange"
    assert saved["marketOpen"] == "09:15"
    assert saved["segments"] == ["EQUITY", "FNO"]

    # And it is on the row, not only in the response.
    assert (await client.get("/api/exchanges/NSE")).json()["data"]["reportMinutesAfterClose"] == 25


async def test_a_null_sent_deliberately_does_clear_a_column(
    client: httpx.AsyncClient, nse: None
) -> None:
    await client.put("/api/exchanges/NSE", json={"reportMinutesAfterClose": None})

    assert (await client.get("/api/exchanges/NSE")).json()["data"][
        "reportMinutesAfterClose"
    ] is None


async def test_updating_an_unknown_exchange_is_a_404(client: httpx.AsyncClient) -> None:
    response = await client.put("/api/exchanges/XSE", json={"reportMinutesAfterClose": 5})

    assert response.status_code == 404


async def test_a_time_that_is_not_a_time_is_refused_and_nothing_changes(
    client: httpx.AsyncClient, nse: None
) -> None:
    response = await client.put("/api/exchanges/NSE", json={"marketOpen": "half nine"})

    assert response.status_code == 400
    assert "half nine" in response.json()["message"]
    assert (await client.get("/api/exchanges/NSE")).json()["data"]["marketOpen"] == "09:15"


async def test_creates_a_venue_and_normalises_its_code_and_currency(
    client: httpx.AsyncClient,
) -> None:
    response = await client.post(
        "/api/exchanges",
        json={
            "exchange": "nyse",
            "exchangeName": "New York Stock Exchange",
            "currency": "usd",
            "timezone": "America/New_York",
            "segments": ["EQUITY"],
            "marketOpen": "09:30",
            "marketClose": "16:00",
            "isActive": False,
        },
    )

    assert response.status_code == 200
    created = response.json()["data"]
    assert created["exchange"] == "NYSE"
    assert created["currency"] == "USD"
    assert created["isActive"] is False
    assert (await client.get("/api/exchanges/NYSE")).json()["data"]["timezone"] == (
        "America/New_York"
    )


@pytest.mark.parametrize(
    "missing",
    ["exchangeName", "currency", "marketOpen", "marketClose"],
)
async def test_a_venue_missing_something_it_cannot_run_without_is_refused(
    client: httpx.AsyncClient, missing: str
) -> None:
    """A venue with no hours has no session, and a P&L figure with no currency
    is a number without a unit. Refused by name, not defaulted."""
    body = {
        "exchange": "NYSE",
        "exchangeName": "New York Stock Exchange",
        "currency": "USD",
        "marketOpen": "09:30",
        "marketClose": "16:00",
    }
    del body[missing]

    response = await client.post("/api/exchanges", json=body)

    assert response.status_code == 400
    assert missing in response.json()["message"]
    assert (await client.get("/api/exchanges")).json()["data"] == []


async def test_creating_one_that_exists_is_refused_rather_than_overwriting(
    client: httpx.AsyncClient, nse: None
) -> None:
    response = await client.post(
        "/api/exchanges",
        json={
            "exchange": "NSE",
            "exchangeName": "Something Else",
            "currency": "USD",
            "marketOpen": "10:00",
            "marketClose": "17:00",
        },
    )

    assert response.status_code == 409
    kept = (await client.get("/api/exchanges/NSE")).json()["data"]
    assert kept["exchangeName"] == "National Stock Exchange"
    assert kept["marketOpen"] == "09:15"


async def test_deletes_a_venue(client: httpx.AsyncClient, nse: None) -> None:
    response = await client.delete("/api/exchanges/nse")

    assert response.status_code == 200
    assert (await client.get("/api/exchanges")).json()["data"] == []


async def test_deleting_one_that_is_not_there_is_a_404(client: httpx.AsyncClient) -> None:
    assert (await client.delete("/api/exchanges/XSE")).status_code == 404


async def test_seconds_on_a_time_are_accepted_and_dropped(client: httpx.AsyncClient) -> None:
    """The Console's older forms send `HH:MM:SS`. Accept it; report `HH:MM`,
    because seconds on a market open are noise."""
    await client.post(
        "/api/exchanges",
        json={
            "exchange": "NSE",
            "exchangeName": "National Stock Exchange",
            "currency": "INR",
            "marketOpen": "09:15:00",
            "marketClose": "15:30:00",
        },
    )

    venue = (await client.get("/api/exchanges/NSE")).json()["data"]
    assert venue["marketOpen"] == "09:15"
    assert venue["marketClose"] == "15:30"


async def test_a_blank_segment_does_not_become_a_segment(client: httpx.AsyncClient) -> None:
    await client.post(
        "/api/exchanges",
        json={
            "exchange": "NSE",
            "exchangeName": "National Stock Exchange",
            "currency": "INR",
            "marketOpen": "09:15",
            "marketClose": "15:30",
            "segments": ["EQUITY", "", "  ", "FNO"],
        },
    )

    assert (await client.get("/api/exchanges/NSE")).json()["data"]["segments"] == [
        "EQUITY",
        "FNO",
    ]
