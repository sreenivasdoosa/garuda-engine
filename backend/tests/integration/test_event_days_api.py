"""The event-day endpoints, against a real database.

Two levels: the exchange-level day, and one strategy's override of it. The
engine's own reading of these is tested in `tests/unit/engine/test_signals.py`,
on the quantity of the signal it emits; these tests are about the endpoints.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import event_days
from garuda.persistence import models

pytestmark = pytest.mark.integration

BUDGET = "2026-02-02"


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(event_days.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def venues(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with session_factory() as session:
        for code in ("NSE", "MCX"):
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


async def add_day(
    client: httpx.AsyncClient, exchange: str = "NSE", date: str = BUDGET, **body: Any
) -> httpx.Response:
    payload: dict[str, Any] = {"eventDate": date, "capitalPercentage": 50, **body}
    return await client.post(f"/api/event-days/{exchange}", json=payload)


async def add_override(
    client: httpx.AsyncClient,
    strategy: str = "short-strangle",
    *,
    exchange: str = "NSE",
    date: str = BUDGET,
    percentage: float = 60,
) -> httpx.Response:
    return await client.post(
        f"/api/strategy-event-day-actions/{strategy}",
        json={"eventDate": date, "exchangeCode": exchange, "capitalPercentage": percentage},
    )


class TestTheExchangeLevelDay:
    async def test_creates_and_lists_one(self, client: httpx.AsyncClient, venues: None) -> None:
        response = await add_day(client, eventName="Union Budget")

        assert response.status_code == 200
        assert (await client.get("/api/event-days/NSE")).json()["data"] == [
            {
                "exchange": "NSE",
                "eventDate": BUDGET,
                "eventName": "Union Budget",
                "capitalPercentage": 50.0,
            }
        ]

    async def test_lists_oldest_first(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_day(client, date="2026-05-16")
        await add_day(client, date=BUDGET)

        rows = (await client.get("/api/event-days/NSE")).json()["data"]

        assert [row["eventDate"] for row in rows] == [BUDGET, "2026-05-16"]

    async def test_an_unknown_exchange_lists_nothing(self, client: httpx.AsyncClient) -> None:
        response = await client.get("/api/event-days/XSE")

        assert response.status_code == 200
        assert response.json()["data"] == []

    async def test_a_day_for_a_venue_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        """The engine keys event days by exchange code, so one matching no
        venue is never read and the day trades full size."""
        response = await add_day(client, exchange="XSE")

        assert response.status_code == 404

    async def test_the_same_day_twice_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_day(client, eventName="Union Budget")

        response = await add_day(client, eventName="Something Else")

        assert response.status_code == 409
        rows = (await client.get("/api/event-days/NSE")).json()["data"]
        assert rows[0]["eventName"] == "Union Budget"

    @pytest.mark.parametrize("bad", [-1, 101, 150])
    async def test_a_percentage_outside_nought_to_a_hundred_is_refused(
        self, client: httpx.AsyncClient, venues: None, bad: int
    ) -> None:
        """The engine drops such a row when it builds its lookup, and the day
        would then trade full size -- the opposite of what was asked."""
        response = await add_day(client, capitalPercentage=bad)

        assert response.status_code == 400
        assert (await client.get("/api/event-days/NSE")).json()["data"] == []

    async def test_zero_is_allowed_because_it_means_sit_the_day_out(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        response = await add_day(client, capitalPercentage=0)

        assert response.status_code == 200
        assert (await client.get("/api/event-days/NSE")).json()["data"][0][
            "capitalPercentage"
        ] == 0.0

    async def test_a_percentage_is_required(self, client: httpx.AsyncClient, venues: None) -> None:
        """A day with no figure states nothing. The engine skips it, so
        accepting one stores a row that does not do what it looks like."""
        response = await client.post(
            "/api/event-days/NSE", json={"eventDate": BUDGET, "eventName": "Union Budget"}
        )

        assert response.status_code == 400
        assert "capitalPercentage" in response.json()["message"]

    async def test_updates_only_the_fields_sent(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_day(client, eventName="Union Budget")

        await client.put(f"/api/event-days/NSE/{BUDGET}", json={"capitalPercentage": 25})

        row = (await client.get("/api/event-days/NSE")).json()["data"][0]
        assert row["capitalPercentage"] == 25.0
        assert row["eventName"] == "Union Budget"

    async def test_deletes_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_day(client)

        assert (await client.delete(f"/api/event-days/nse/{BUDGET}")).status_code == 200
        assert (await client.get("/api/event-days/NSE")).json()["data"] == []

    async def test_a_bad_date_is_refused(self, client: httpx.AsyncClient, venues: None) -> None:
        assert (await add_day(client, date="02-02-2026")).status_code == 400


class TestTheStrategyOverride:
    async def test_creates_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_day(client)

        response = await add_override(client)

        assert response.status_code == 200
        assert response.json()["data"] == {
            "strategyName": "short-strangle",
            "exchangeCode": "NSE",
            "eventDate": BUDGET,
            "capitalPercentage": 60.0,
        }

    async def test_lists_every_override(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_override(client, "short-strangle")
        await add_override(client, "iron-fly", percentage=0)

        rows = (await client.get("/api/strategy-event-day-actions")).json()["data"]

        assert {row["strategyName"] for row in rows} == {"short-strangle", "iron-fly"}

    async def test_lists_one_strategys_overrides(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_override(client, "short-strangle")
        await add_override(client, "iron-fly")

        rows = (await client.get("/api/strategy-event-day-actions/short-strangle")).json()["data"]

        assert [row["strategyName"] for row in rows] == ["short-strangle"]

    async def test_narrows_by_exchange_and_date(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_override(client, exchange="NSE")
        await add_override(client, exchange="MCX")

        rows = (
            await client.get("/api/strategy-event-day-actions/short-strangle?exchange=MCX")
        ).json()["data"]

        assert [row["exchangeCode"] for row in rows] == ["MCX"]

    async def test_an_override_needs_no_event_day_under_it(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        """Deliberate: it scales that strategy on that date whether or not the
        operator has flagged the day for everything else."""
        response = await add_override(client)

        assert response.status_code == 200

    async def test_an_override_for_a_venue_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add_override(client, exchange="XSE")).status_code == 404

    async def test_the_same_override_twice_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_override(client, percentage=60)

        response = await add_override(client, percentage=10)

        assert response.status_code == 409
        rows = (await client.get("/api/strategy-event-day-actions/short-strangle")).json()["data"]
        assert rows[0]["capitalPercentage"] == 60.0

    @pytest.mark.parametrize("bad", [-5, 101])
    async def test_a_percentage_outside_the_range_is_refused(
        self, client: httpx.AsyncClient, venues: None, bad: int
    ) -> None:
        assert (await add_override(client, percentage=bad)).status_code == 400

    async def test_updates_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_override(client, percentage=60)

        response = await client.put(
            f"/api/strategy-event-day-actions/short-strangle?exchange=NSE&eventDate={BUDGET}",
            json={"capitalPercentage": 75},
        )

        assert response.status_code == 200
        assert response.json()["data"]["capitalPercentage"] == 75.0

    async def test_updating_one_that_is_not_there_is_a_404(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        response = await client.put(
            f"/api/strategy-event-day-actions/short-strangle?exchange=NSE&eventDate={BUDGET}",
            json={"capitalPercentage": 75},
        )

        assert response.status_code == 404

    async def test_deletes_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add_override(client, exchange="NSE")
        await add_override(client, exchange="MCX")

        response = await client.delete(
            f"/api/strategy-event-day-actions/short-strangle?exchange=NSE&eventDate={BUDGET}"
        )

        assert response.status_code == 200
        rows = (await client.get("/api/strategy-event-day-actions/short-strangle")).json()["data"]
        assert [row["exchangeCode"] for row in rows] == ["MCX"]

    async def test_deletes_all_of_one_strategys(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add_override(client, "short-strangle", exchange="NSE")
        await add_override(client, "short-strangle", exchange="MCX")
        await add_override(client, "iron-fly")

        await client.delete("/api/strategy-event-day-actions/short-strangle")

        remaining = (await client.get("/api/strategy-event-day-actions")).json()["data"]
        assert [row["strategyName"] for row in remaining] == ["iron-fly"]

    async def test_half_a_key_is_refused_rather_than_guessed(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        """ "Every override on NSE" is not something the Console offers, and
        guessing at it would make a half-filled query destructive."""
        await add_override(client)

        response = await client.delete(
            "/api/strategy-event-day-actions/short-strangle?exchange=NSE"
        )

        assert response.status_code == 400
        assert len((await client.get("/api/strategy-event-day-actions")).json()["data"]) == 1
