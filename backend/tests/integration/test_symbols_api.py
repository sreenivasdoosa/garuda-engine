"""The symbol endpoints, against a real database.

The engine already reads this table: `strike_gap` places every strike a
strategy picks, `contract_multiplier` is what a lot is worth. So the tests
that matter most are the ones about refusing a row the loader would skip --
because a skipped row is a strategy that never finds its instrument, and
nothing about the saved form looks wrong.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import symbols
from garuda.persistence import models

pytestmark = pytest.mark.integration


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(symbols.build(session_factory))
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
                    segments="EQUITY,FNO",
                    market_open=dt.time(9, 15),
                    market_close=dt.time(15, 30),
                )
            )
        session.add(
            models.BrokersRow(
                broker_name="ZERODHA",
                order_update_interval_secs=30,
                position_update_interval_secs=30,
                mtf_interest_rate_per_annum=Decimal("14.99"),
            )
        )
        await session.commit()


NIFTY: dict[str, Any] = {
    "symbol": "NIFTY",
    "exchange": "NSE",
    "indexSymbol": "NIFTY 50",
    "isIndex": True,
    "strikeGap": 50,
    "freezeLimitQty": 1800,
    "maxOptionChainLevels": 10,
    "contractMultiplier": 1,
    "hasOptionsWeeklyExpiry": True,
    "hasOptionsMonthlyExpiry": True,
}


async def add(client: httpx.AsyncClient, **overrides: Any) -> httpx.Response:
    return await client.post("/api/symbols", json={**NIFTY, **overrides})


class TestReading:
    async def test_creates_and_reads_one_back(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client)).status_code == 200

        row = (await client.get("/api/symbols/NIFTY")).json()["data"]

        assert row["symbol"] == "NIFTY"
        assert row["indexSymbol"] == "NIFTY 50"
        assert row["isIndex"] is True
        assert row["strikeGap"] == 50
        assert row["hasOptionsWeeklyExpiry"] is True
        assert row["hasFuturesWeeklyExpiry"] is False

    async def test_lists_alphabetically(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client, symbol="NIFTY")
        await add(client, symbol="BANKNIFTY")
        await add(client, symbol="CRUDEOIL", exchange="MCX", contractMultiplier=100)

        rows = (await client.get("/api/symbols")).json()["data"]

        assert [row["symbol"] for row in rows] == ["BANKNIFTY", "CRUDEOIL", "NIFTY"]

    async def test_narrows_by_exchange(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client, symbol="NIFTY")
        await add(client, symbol="CRUDEOIL", exchange="MCX", contractMultiplier=100)

        rows = (await client.get("/api/symbols?exchange=mcx")).json()["data"]

        assert [row["symbol"] for row in rows] == ["CRUDEOIL"]

    async def test_an_unknown_symbol_is_a_404(self, client: httpx.AsyncClient) -> None:
        assert (await client.get("/api/symbols/NOPE")).status_code == 404


class TestWhatTheLoaderWouldSkip:
    """Each of these stores cleanly and then never trades, if it is allowed."""

    @pytest.mark.parametrize("gap", [0, -50])
    async def test_a_strike_gap_of_zero_or_less_is_refused(
        self, client: httpx.AsyncClient, venues: None, gap: int
    ) -> None:
        response = await add(client, strikeGap=gap)

        assert response.status_code == 400
        assert "strikeGap" in response.json()["message"]
        assert (await client.get("/api/symbols")).json()["data"] == []

    async def test_a_contract_multiplier_of_zero_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, contractMultiplier=0)).status_code == 400

    async def test_a_freeze_limit_below_one_unit_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, freezeLimitQty=0)).status_code == 400

    async def test_no_option_chain_levels_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, maxOptionChainLevels=0)).status_code == 400

    async def test_negative_hedge_rounding_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, hedgeStrikeRoundingMultiple=-100)).status_code == 400

    async def test_zero_hedge_rounding_is_fine_because_it_means_use_the_gap(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, hedgeStrikeRoundingMultiple=0)).status_code == 200

    async def test_an_update_cannot_sneak_a_bad_value_in(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client)

        response = await client.put("/api/symbols/NIFTY", json={"strikeGap": 0})

        assert response.status_code == 400
        assert (await client.get("/api/symbols/NIFTY")).json()["data"]["strikeGap"] == 50


class TestWriting:
    async def test_an_exchange_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        assert (await add(client, exchange="XSE")).status_code == 404

    async def test_the_same_symbol_twice_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client)

        response = await add(client, strikeGap=100)

        assert response.status_code == 409
        assert (await client.get("/api/symbols/NIFTY")).json()["data"]["strikeGap"] == 50

    async def test_an_update_touches_only_the_fields_sent(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client)

        await client.put("/api/symbols/NIFTY", json={"strikeGap": 100})

        row = (await client.get("/api/symbols/NIFTY")).json()["data"]
        assert row["strikeGap"] == 100
        assert row["indexSymbol"] == "NIFTY 50"
        assert row["freezeLimitQty"] == 1800

    async def test_the_straddle_premium_difference_round_trips(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client, straddleMaxPremiumDiff=12.5)

        assert (await client.get("/api/symbols/NIFTY")).json()["data"][
            "straddleMaxPremiumDiff"
        ] == 12.5

    async def test_deletes_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client)

        assert (await client.delete("/api/symbols/NIFTY")).status_code == 200
        assert (await client.get("/api/symbols")).json()["data"] == []

    async def test_deleting_an_unknown_symbol_is_a_404(self, client: httpx.AsyncClient) -> None:
        assert (await client.delete("/api/symbols/NOPE")).status_code == 404


class TestPerBrokerFreezeLimits:
    async def test_sets_and_lists_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client)

        response = await client.post(
            "/api/symbols/NIFTY/brokers",
            json={"brokerName": "zerodha", "freezeLimitQty": 900},
        )

        assert response.status_code == 200
        assert (await client.get("/api/symbols/NIFTY/brokers")).json()["data"] == [
            {"symbol": "NIFTY", "brokerName": "ZERODHA", "freezeLimitQty": 900}
        ]

    async def test_a_broker_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client)

        response = await client.post(
            "/api/symbols/NIFTY/brokers", json={"brokerName": "NOPE", "freezeLimitQty": 900}
        )

        assert response.status_code == 404

    async def test_a_symbol_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        response = await client.post(
            "/api/symbols/NOPE/brokers", json={"brokerName": "ZERODHA", "freezeLimitQty": 900}
        )

        assert response.status_code == 404

    async def test_a_limit_below_one_unit_is_refused(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        await add(client)

        response = await client.post(
            "/api/symbols/NIFTY/brokers", json={"brokerName": "ZERODHA", "freezeLimitQty": 0}
        )

        assert response.status_code == 400

    async def test_updates_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client)
        await client.post(
            "/api/symbols/NIFTY/brokers", json={"brokerName": "ZERODHA", "freezeLimitQty": 900}
        )

        await client.put("/api/symbols/NIFTY/brokers/zerodha", json={"freezeLimitQty": 450})

        assert (await client.get("/api/symbols/NIFTY/brokers")).json()["data"][0][
            "freezeLimitQty"
        ] == 450

    async def test_deletes_one(self, client: httpx.AsyncClient, venues: None) -> None:
        await add(client)
        await client.post(
            "/api/symbols/NIFTY/brokers", json={"brokerName": "ZERODHA", "freezeLimitQty": 900}
        )

        assert (await client.delete("/api/symbols/NIFTY/brokers/ZERODHA")).status_code == 200
        assert (await client.get("/api/symbols/NIFTY/brokers")).json()["data"] == []

    async def test_deleting_the_symbol_takes_its_overrides_with_it(
        self, client: httpx.AsyncClient, venues: None
    ) -> None:
        """They are keyed by symbol, so a left-behind row describes something
        that no longer exists."""
        await add(client)
        await client.post(
            "/api/symbols/NIFTY/brokers", json={"brokerName": "ZERODHA", "freezeLimitQty": 900}
        )

        await client.delete("/api/symbols/NIFTY")

        assert (await client.get("/api/symbols/NIFTY/brokers")).json()["data"] == []
