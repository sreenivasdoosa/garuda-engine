"""The audit log, written by the middleware and read by the Console.

Behavioural: real routers are driven over HTTP with the middleware in
front of them, and the claims are about the rows that appear -- what was
changed, by whom, from what to what -- and about the rows that must not
appear: a refused request, and a secret.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import audit, envelope
from garuda.api.envelope import ok
from garuda.api.routers import audit_logs, brokers, exchanges, trading_clients
from garuda.api.tokens import issue
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.persistence.secrets import SecretBox

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 11, 4, 0, tzinfo=dt.UTC)
SECRET = "an-audit-test-secret-long-enough"
SECRETS = SecretBox("a-test-key")

NYSE = {
    "exchange": "nyse",
    "exchangeName": "New York Stock Exchange",
    "currency": "usd",
    "timezone": "America/New_York",
    "segments": ["EQUITY"],
    "marketOpen": "09:30",
    "marketClose": "16:00",
    "isActive": False,
}


def broker_row(name: str) -> models.BrokersRow:
    return models.BrokersRow(
        broker_name=name,
        enabled=True,
        stopped=False,
        description=name,
        provider=None if name == "zerodha" else name,
        use_dealer_apis=False,
        server_url=f"https://api.{name}.example",
        web_socket_enabled=True,
        api_version=1,
        server_start_time="08:00",
        order_update_interval_secs=30,
        position_update_interval_secs=60,
        mtf_interest_rate_per_annum=Decimal(0),
    )


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(broker_row("zerodha"))
        await session.commit()
    clock = ReplayClock(NOW)
    app = FastAPI()
    envelope.install(app)
    audit.install(app, sessions=session_factory, secret=SECRET, clock=clock, admin_username="admin")
    app.include_router(exchanges.build(session_factory))
    app.include_router(brokers.build(session_factory))
    app.include_router(trading_clients.build(session_factory, SECRETS, clock))
    app.include_router(audit_logs.build(session_factory, clock))

    @app.post("/api/market-data/ticker/start")
    async def start_ticker() -> dict[str, Any]:
        return ok({"status": "connected"})

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def logged(client: httpx.AsyncClient, **params: Any) -> list[dict[str, Any]]:
    response = await client.get("/api/audit-logs", params=params)
    assert response.status_code == 200, response.text
    rows: list[dict[str, Any]] = response.json()["data"]["data"]
    return rows


def as_operator() -> dict[str, str]:
    return {"Authorization": f"Bearer {issue('operator', SECRET)}"}


class TestWhatIsWritten:
    async def test_a_create_an_update_and_a_delete_each_leave_their_row(
        self, client: httpx.AsyncClient
    ) -> None:
        assert (await client.post("/api/exchanges", json=NYSE)).status_code == 200
        assert (
            await client.put("/api/exchanges/NYSE", json={"exchangeName": "NYSE"})
        ).status_code == 200
        assert (await client.delete("/api/exchanges/NYSE")).status_code == 200

        [deleted, updated, created] = await logged(client, entityType="EXCHANGE")
        assert created["action"] == "CREATE"
        assert created["entityId"] == "NYSE"
        assert created["entityName"] == "New York Stock Exchange"
        assert created["oldData"] is None
        assert json.loads(created["newData"])["exchange_name"] == "New York Stock Exchange"
        assert created["changedBy"] == "admin", "no token: the configured admin"
        assert created["changedTimestamp"] == NOW.isoformat()

        assert updated["action"] == "UPDATE"
        assert json.loads(updated["oldData"])["exchange_name"] == "New York Stock Exchange"
        assert json.loads(updated["newData"])["exchange_name"] == "NYSE"
        assert updated["entityName"] == "NYSE"

        assert deleted["action"] == "DELETE"
        assert json.loads(deleted["oldData"])["exchange_name"] == "NYSE"
        assert deleted["newData"] is None

    async def test_a_refused_request_writes_nothing(self, client: httpx.AsyncClient) -> None:
        await client.post("/api/exchanges", json=NYSE)
        assert (await client.post("/api/exchanges", json=NYSE)).status_code == 409
        assert (await client.put("/api/exchanges/XXX", json={"exchangeName": "x"})).status_code == (
            404
        )
        assert len(await logged(client)) == 1

    async def test_the_signed_in_name_is_who(self, client: httpx.AsyncClient) -> None:
        await client.post("/api/exchanges", json=NYSE, headers=as_operator())
        [row] = await logged(client)
        assert row["changedBy"] == "operator"

    async def test_a_row_edited_in_place_is_seen_with_its_old_value(
        self, client: httpx.AsyncClient
    ) -> None:
        """The brokers router sets an attribute and commits; the flush tells."""
        assert (await client.put("/api/brokers/zerodha/stop")).status_code == 200
        assert (await client.put("/api/brokers/zerodha/unstop")).status_code == 200

        [unstopped, stopped] = await logged(client, entityType="BROKER")
        assert stopped["action"] == "DISABLE", "a lone flag flip, in the reference's words"
        assert stopped["entityId"] == "zerodha"
        assert json.loads(stopped["oldData"])["stopped"] is False
        assert json.loads(stopped["newData"])["stopped"] is True
        assert unstopped["action"] == "ENABLE"

    async def test_a_secret_is_never_written_down(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            "/api/trading-clients",
            json={
                "displayName": "Appa",
                "broker": "zerodha",
                "clientId": "AB1234",
                "apiKey": "kite-key",
                "apiSecret": "kite-secret",
            },
        )
        assert response.status_code == 201, response.text
        [row] = await logged(client, entityType="TRADING_CLIENT")
        image = json.loads(row["newData"])
        assert row["entityId"] == "appa"
        assert row["entityName"] == "Appa"
        assert image["api_key"] == "kite-key"
        assert image["api_secret_encrypted"] == "***"
        assert "kite-secret" not in row["newData"]

    async def test_a_logout_is_a_logout(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await client.post(
            "/api/trading-clients",
            json={"displayName": "Appa", "broker": "zerodha", "clientId": "AB1234"},
        )
        async with session_factory() as session:
            session.add(
                models.TradingClientLoginStatusRow(
                    trading_client_id="appa",
                    client_id="AB1234",
                    is_login_success=True,
                    access_token_encrypted=SECRETS.seal("live"),
                    session_created_on=NOW,
                    updated_on=NOW,
                )
            )
            await session.commit()

        assert (await client.post("/api/trading-clients/appa/logout")).status_code == 200

        [row] = await logged(client, entityType="TRADING_CLIENT_SESSION")
        assert row["action"] == "LOGOUT"
        assert row["entityId"] == "appa"
        assert json.loads(row["oldData"])["access_token_encrypted"] == "***"
        assert json.loads(row["newData"])["access_token_encrypted"] is None

    async def test_a_button_is_recorded_from_its_path(self, client: httpx.AsyncClient) -> None:
        assert (await client.post("/api/market-data/ticker/start")).status_code == 200
        [row] = await logged(client)
        assert row["entityType"] == "MARKET_DATA"
        assert row["entityId"] == "ticker"
        assert row["action"] == "START"

    async def test_a_read_writes_nothing(self, client: httpx.AsyncClient) -> None:
        await client.get("/api/exchanges")
        await client.get("/api/brokers")
        assert await logged(client) == []


class TestTheReads:
    async def seed(self, client: httpx.AsyncClient) -> None:
        await client.post("/api/exchanges", json=NYSE, headers=as_operator())
        await client.put("/api/exchanges/NYSE", json={"exchangeName": "NYSE"})
        await client.put("/api/brokers/zerodha/stop")
        await client.post("/api/market-data/ticker/start")

    async def test_the_page_is_newest_first_with_its_count(self, client: httpx.AsyncClient) -> None:
        await self.seed(client)
        response = await client.get("/api/audit-logs", params={"page": 1, "pageSize": 3})
        body = response.json()["data"]
        assert body["pagination"] == {
            "page": 1,
            "pageSize": 3,
            "totalCount": 4,
            "totalPages": 2,
            "hasNext": True,
            "hasPrev": False,
        }
        assert [row["action"] for row in body["data"]] == ["START", "DISABLE", "UPDATE"]
        second = (await client.get("/api/audit-logs", params={"limit": 3, "offset": 3})).json()
        assert [row["action"] for row in second["data"]["data"]] == ["CREATE"]

    async def test_the_filters(self, client: httpx.AsyncClient) -> None:
        await self.seed(client)
        assert [r["action"] for r in await logged(client, action="update")] == ["UPDATE"]
        assert len(await logged(client, entityTypes="EXCHANGE,BROKER")) == 3
        assert [r["entityId"] for r in await logged(client, username="operator")] == ["NYSE"]
        assert len(await logged(client, search="nyse")) == 2
        assert len(await logged(client, search="ticker")) == 1
        assert len(await logged(client, days=1)) == 4
        assert (
            await client.get("/api/audit-logs", params={"action": "EXPLODE"})
        ).status_code == 400

    async def test_a_date_range_takes_epoch_milliseconds_as_the_reference_does(
        self, client: httpx.AsyncClient
    ) -> None:
        await self.seed(client)
        start = int((NOW - dt.timedelta(hours=1)).timestamp() * 1000)
        end = int((NOW + dt.timedelta(hours=1)).timestamp() * 1000)
        assert len(await logged(client, startDate=str(start), endDate=str(end))) == 4
        later = int((NOW + dt.timedelta(hours=1)).timestamp() * 1000)
        assert await logged(client, startDate=str(later), endDate=str(later + 1)) == []

    async def test_one_entitys_history_and_one_users(self, client: httpx.AsyncClient) -> None:
        await self.seed(client)
        history = (await client.get("/api/audit-logs/entity/exchange/NYSE")).json()["data"]
        assert [row["action"] for row in history] == ["UPDATE", "CREATE"]
        mine = (await client.get("/api/audit-logs/user/admin", params={"limit": 2})).json()
        assert [row["action"] for row in mine["data"]] == ["START", "DISABLE"]

    async def test_the_entity_types_are_the_known_ones_and_the_stored_ones(
        self, client: httpx.AsyncClient
    ) -> None:
        await self.seed(client)
        types = (await client.get("/api/audit-logs/entity-types")).json()["data"]
        assert "EXCHANGE" in types
        assert "MARKET_DATA" in types, "stored, though no table is called that"
        assert "RMS_CONFIG" in types, "known, though nothing has written it yet"
        assert types == sorted(types)
