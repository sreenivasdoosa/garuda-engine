"""Brokers, as the Console manages them.

The set is fixed and seeded; the page edits what is editable about each one
and switches it on or off. The claims that matter: nothing can be invented,
a vendor's endpoint cannot be edited into a typo, the brake writes the row
the engine reads, and a broker in use cannot be deleted.
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
from garuda.api.routers import brokers
from garuda.persistence import models

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)


def seeded(name: str, **overrides: Any) -> models.BrokersRow:
    values: dict[str, Any] = {
        "broker_name": name,
        "enabled": True,
        "stopped": False,
        "description": f"{name} seeded",
        "provider": None if name == "zerodha" else name,
        "use_dealer_apis": False,
        "server_url": f"https://api.{name}.example",
        "web_socket_enabled": True,
        "api_version": 1,
        "server_start_time": "08:00",
        "order_update_interval_secs": 30,
        "position_update_interval_secs": 60,
        "mtf_interest_rate_per_annum": Decimal(0),
    }
    values.update(overrides)
    return models.BrokersRow(**values)


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add_all([seeded("zerodha"), seeded("dhan"), seeded("kotak", enabled=False)])
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.include_router(brokers.build(session_factory))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def one(client: httpx.AsyncClient, name: str) -> dict[str, Any]:
    body: dict[str, Any] = (await client.get(f"/api/brokers/{name}")).json()["data"]
    return body


class TestListing:
    async def test_every_seeded_broker_is_listed_in_name_order(
        self, client: httpx.AsyncClient
    ) -> None:
        rows = (await client.get("/api/brokers")).json()["data"]
        assert [row["name"] for row in rows] == ["dhan", "kotak", "zerodha"]

    async def test_a_blank_provider_reads_as_the_broker_itself(
        self, client: httpx.AsyncClient
    ) -> None:
        """The page's type picker matches on it, and the seeded Zerodha row
        leaves it blank."""
        assert (await one(client, "zerodha"))["provider"] == "zerodha"
        assert (await one(client, "dhan"))["provider"] == "dhan"

    async def test_nothing_unattended_is_ever_reported_on(self, client: httpx.AsyncClient) -> None:
        row = await one(client, "zerodha")
        assert row["autoLogin"] is False
        assert row["totpEnabled"] is False
        assert "marketDataAppSecret" not in row
        assert "marketDataAppKey" not in row

    async def test_the_types_are_the_adapters_garuda_ships(self, client: httpx.AsyncClient) -> None:
        types = (await client.get("/api/brokers/types")).json()["data"]
        assert {t["value"] for t in types} == {"zerodha", "fyers", "dhan", "kotak"}
        assert all(t["fixedName"] for t in types)

    async def test_an_unknown_broker_is_a_404(self, client: httpx.AsyncClient) -> None:
        assert (await client.get("/api/brokers/upstox")).status_code == 404


class TestEditing:
    async def test_the_editable_fields_are_saved(self, client: httpx.AsyncClient) -> None:
        response = await client.put(
            "/api/brokers/zerodha",
            json={
                "description": "Appa's broker",
                "orderUpdateIntervalSecs": 15,
                "mtfInterestRatePerAnnum": 12.5,
                "serverStopTime": "23:30",
                "naicCode": "118",
            },
        )
        assert response.status_code == 200, response.text
        row = response.json()["data"]
        assert row["description"] == "Appa's broker"
        assert row["orderUpdateIntervalSecs"] == 15
        assert row["mtfInterestRatePerAnnum"] == 12.5
        assert row["serverStopTime"] == "23:30"
        assert row["naicCode"] == "118"

    async def test_a_vendor_endpoint_cannot_be_changed(self, client: httpx.AsyncClient) -> None:
        """A URL is a fact about someone else's API and lives in code."""
        response = await client.put(
            "/api/brokers/zerodha", json={"serverUrl": "https://typo.example"}
        )
        assert response.status_code == 400
        assert "serverUrl" in response.json()["message"]
        assert (await one(client, "zerodha"))["serverUrl"] == "https://api.zerodha.example"

    async def test_sending_the_endpoint_back_unchanged_is_fine(
        self, client: httpx.AsyncClient
    ) -> None:
        """The form round-trips everything it was shown."""
        response = await client.put(
            "/api/brokers/zerodha",
            json={"serverUrl": "https://api.zerodha.example", "description": "same"},
        )
        assert response.status_code == 200

    async def test_a_bad_clock_time_is_refused_by_name(self, client: httpx.AsyncClient) -> None:
        response = await client.put("/api/brokers/zerodha", json={"serverStartTime": "8am"})
        assert response.status_code == 400
        assert "serverStartTime" in response.json()["message"]

    async def test_a_zero_interval_is_refused(self, client: httpx.AsyncClient) -> None:
        response = await client.put("/api/brokers/zerodha", json={"orderUpdateIntervalSecs": 0})
        assert response.status_code == 400

    async def test_nothing_can_be_added(self, client: httpx.AsyncClient) -> None:
        response = await client.post("/api/brokers", json={"name": "upstox", "enabled": True})
        assert response.status_code == 400
        assert "seeded" in response.json()["message"]
        assert (await client.get("/api/brokers/upstox")).status_code == 404


class TestTheSwitches:
    async def test_stop_and_unstop_write_the_brake(self, client: httpx.AsyncClient) -> None:
        stopped = (await client.put("/api/brokers/zerodha/stop")).json()["data"]
        assert stopped["stopped"] is True
        assert stopped["enabled"] is True, "stopped is not disabled"

        resumed = (await client.put("/api/brokers/zerodha/unstop")).json()["data"]
        assert resumed["stopped"] is False

    async def test_enabled_is_an_ordinary_edit(self, client: httpx.AsyncClient) -> None:
        response = await client.put("/api/brokers/kotak", json={"enabled": True})
        assert response.json()["data"]["enabled"] is True


class TestDeleting:
    async def test_a_broker_with_accounts_cannot_be_deleted(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(
                models.TradingClientRow(
                    id="appa",
                    display_name="Appa",
                    broker="ZERODHA",
                    client_id="AB1234",
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            await session.commit()

        usage = (await client.get("/api/brokers/zerodha/usage")).json()["data"]
        assert usage["blockers"]["tradingClients"] == 1
        assert usage["sampleClients"] == ["Appa"]

        response = await client.delete("/api/brokers/zerodha")
        assert response.status_code == 409
        assert "tradingClients 1" in response.json()["message"]
        assert (await client.get("/api/brokers/zerodha")).status_code == 200

    async def test_an_unused_broker_is_deleted(self, client: httpx.AsyncClient) -> None:
        assert (await client.delete("/api/brokers/kotak")).status_code == 200
        assert (await client.get("/api/brokers/kotak")).status_code == 404
