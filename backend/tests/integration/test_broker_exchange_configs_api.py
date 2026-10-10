"""Broker exchange configs, as the Console edits them.

Behavioural: what the page gets, and what the running engine is told. The
rules that matter are the ones that would otherwise be learnt from a
refused order: a row must name a real broker and venue, a buffer is a
percentage of the price, and every write reaches the engine at once.
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
from garuda.api.routers import broker_exchange_configs
from garuda.persistence import models

pytestmark = pytest.mark.integration


class Reloads:
    def __init__(self) -> None:
        self.count = 0

    async def __call__(self) -> None:
        self.count += 1


@pytest.fixture
def reloads() -> Reloads:
    return Reloads()


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession], reloads: Reloads
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(
            models.BrokersRow(
                broker_name="zerodha",
                enabled=True,
                stopped=False,
                order_update_interval_secs=30,
                position_update_interval_secs=60,
                mtf_interest_rate_per_annum=Decimal(0),
            )
        )
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
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.state.reload_protection = reloads
    app.include_router(broker_exchange_configs.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def add(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    payload = {"brokerName": "zerodha", "exchangeCode": "NSE", **body}
    response = await client.post("/api/broker-exchange-configs", json=payload)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()["data"]
    return created


class TestCreating:
    async def test_a_new_row_protects_with_everything_unset(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await add(client)
        assert created["marketOrdersAllowed"] is False
        assert created["limitOrderBufferPercentageOptions"] == 0.0, "zero means the default"
        assert created["positionalSquareOffMinutesBeforeClose"] is None

    async def test_the_numbers_are_saved(self, client: httpx.AsyncClient) -> None:
        created = await add(
            client,
            limitOrderBufferPercentageOptions=7.5,
            slTriggerToLimitGapPercentageEquity=2,
            marketOrdersAllowed=True,
            loginMinutesBeforeMarketOpen=45,
        )
        assert created["limitOrderBufferPercentageOptions"] == 7.5
        assert created["slTriggerToLimitGapPercentageEquity"] == 2.0
        assert created["marketOrdersAllowed"] is True
        assert created["loginMinutesBeforeMarketOpen"] == 45

    async def test_the_pair_is_normalised_and_unique(self, client: httpx.AsyncClient) -> None:
        created = await add(client, brokerName="ZERODHA", exchangeCode="nse")
        assert (created["brokerName"], created["exchangeCode"]) == ("zerodha", "NSE")
        again = await client.post(
            "/api/broker-exchange-configs", json={"brokerName": "zerodha", "exchangeCode": "NSE"}
        )
        assert again.status_code == 409

    async def test_an_unknown_broker_or_venue_is_refused(self, client: httpx.AsyncClient) -> None:
        bad_broker = await client.post(
            "/api/broker-exchange-configs", json={"brokerName": "upstox", "exchangeCode": "NSE"}
        )
        assert bad_broker.status_code == 404
        bad_venue = await client.post(
            "/api/broker-exchange-configs", json={"brokerName": "zerodha", "exchangeCode": "LSE"}
        )
        assert bad_venue.status_code == 404

    async def test_a_negative_or_impossible_percentage_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        negative = await client.post(
            "/api/broker-exchange-configs",
            json={
                "brokerName": "zerodha",
                "exchangeCode": "NSE",
                "limitOrderBufferPercentageEquity": -1,
            },
        )
        assert negative.status_code == 400
        too_much = await client.post(
            "/api/broker-exchange-configs",
            json={
                "brokerName": "zerodha",
                "exchangeCode": "NSE",
                "slTriggerToLimitGapPercentageOptions": 150,
            },
        )
        assert too_much.status_code == 400

    async def test_every_write_reaches_the_engine(
        self, client: httpx.AsyncClient, reloads: Reloads
    ) -> None:
        await add(client)
        await client.put(
            "/api/broker-exchange-configs/zerodha/NSE", json={"marketOrdersAllowed": True}
        )
        await client.delete("/api/broker-exchange-configs/zerodha/NSE")
        assert reloads.count == 3


class TestReading:
    async def test_the_list_is_ordered_by_broker_then_venue(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, exchangeCode="MCX")
        await add(client, exchangeCode="NSE")
        rows = (await client.get("/api/broker-exchange-configs")).json()["data"]
        assert [(r["brokerName"], r["exchangeCode"]) for r in rows] == [
            ("zerodha", "MCX"),
            ("zerodha", "NSE"),
        ]

    async def test_by_broker_and_by_pair(self, client: httpx.AsyncClient) -> None:
        await add(client, exchangeCode="MCX")
        by_broker = (await client.get("/api/broker-exchange-configs/zerodha")).json()["data"]
        assert [r["exchangeCode"] for r in by_broker] == ["MCX"]
        one = (await client.get("/api/broker-exchange-configs/zerodha/mcx")).json()["data"]
        assert one["exchangeCode"] == "MCX"
        assert (await client.get("/api/broker-exchange-configs/zerodha/NSE")).status_code == 404


class TestEditingAndRemoving:
    async def test_a_partial_edit_leaves_the_rest(self, client: httpx.AsyncClient) -> None:
        await add(client, limitOrderBufferPercentageOptions=7.5)
        response = await client.put(
            "/api/broker-exchange-configs/zerodha/NSE", json={"naicCode": "118"}
        )
        body = response.json()["data"]
        assert body["naicCode"] == "118"
        assert body["limitOrderBufferPercentageOptions"] == 7.5

    async def test_removing_a_row_goes_back_to_protecting(self, client: httpx.AsyncClient) -> None:
        await add(client, marketOrdersAllowed=True)
        response = await client.delete("/api/broker-exchange-configs/zerodha/NSE")
        assert response.status_code == 200
        assert "protects" in response.json()["message"]
        assert (await client.get("/api/broker-exchange-configs/zerodha/NSE")).status_code == 404
