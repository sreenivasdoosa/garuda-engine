"""Trading clients: the accounts orders go to, as the Console manages them.

Behavioural: what the page gets for what it sends. The claims that matter are
the ones that cost money when wrong -- one account registered twice, a
session stored against the wrong account, a login button on an account that
has nothing to log in to -- and the ones a morning turns on: a login after
the open reaches the engine, and a failed one says why.
"""

from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import data_providers, trading_clients
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.persistence.repositories import (
    DataProviderSessionsRepository,
    TradingClientLoginStatusRepository,
)
from garuda.persistence.secrets import SecretBox

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)
SECRETS = SecretBox("a-test-key")


class Renewals:
    """Records what the API told the engine, without an engine.

    The telling happens in a background task, so a test waits for it with
    :meth:`settled` before asserting what was told.
    """

    def __init__(self) -> None:
        self.reloads = 0
        self.app: FastAPI | None = None

    async def reload_sessions(self) -> None:
        self.reloads += 1

    async def settled(self) -> int:
        assert self.app is not None
        pending = list(getattr(self.app.state, "renewals", set()))
        if pending:
            await asyncio.gather(*pending)
        return self.reloads


class EngineWithoutAFeed:
    class Parts:
        market_data = None
        downloads = None

    parts = Parts()


@pytest.fixture
def renewals() -> Renewals:
    return Renewals()


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession], renewals: Renewals
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    # An engine with nothing nominated for ticks and no instrument files:
    # enough for the login hook to run, which is what is being asserted.
    app.state.engine = EngineWithoutAFeed()
    app.state.reload_sessions = renewals.reload_sessions
    renewals.app = app
    clock = ReplayClock(NOW)
    app.include_router(trading_clients.build(session_factory, SECRETS, clock))
    app.include_router(data_providers.build(session_factory, SECRETS, clock))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def add(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    payload = {"displayName": "Appa", "broker": "zerodha", "clientId": "AB1234", **body}
    response = await client.post("/api/trading-clients", json=payload)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()["data"]
    return created


async def one(client: httpx.AsyncClient, trading_client_id: str) -> dict[str, Any]:
    body: dict[str, Any] = (await client.get(f"/api/trading-clients/{trading_client_id}")).json()[
        "data"
    ]
    return body


class TestCreating:
    async def test_an_account_is_created_with_a_readable_id(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await add(client, displayName="Appa", apiKey="kite-key", apiSecret="kite-secret")

        assert created["id"] == "appa"
        assert created["broker"] == "ZERODHA"
        assert created["clientId"] == "AB1234"
        assert created["enabled"] is True
        assert created["hasApiSecret"] is True
        assert created["isLoggedIn"] is False
        assert created["callbackPath"] == "/api/auth/callback/zerodha/appa"

    async def test_the_secret_is_never_returned(self, client: httpx.AsyncClient) -> None:
        created = await add(client, apiSecret="kite-secret")
        listed = (await client.get("/api/trading-clients")).json()["data"]

        for body in (created, *listed):
            assert "apiSecret" not in body
            assert "kite-secret" not in str(body)

    async def test_the_same_broker_account_cannot_be_registered_twice(
        self, client: httpx.AsyncClient
    ) -> None:
        """Two rows for one account would place every order twice."""
        await add(client, displayName="Appa")
        response = await client.post(
            "/api/trading-clients",
            json={"displayName": "Appa again", "broker": "zerodha", "clientId": "AB1234"},
        )
        assert response.status_code == 409
        assert "Appa" in response.json()["message"]

    async def test_a_display_name_is_unique(self, client: httpx.AsyncClient) -> None:
        await add(client, displayName="Appa")
        response = await client.post(
            "/api/trading-clients",
            json={"displayName": "appa", "broker": "zerodha", "clientId": "ZZ9999"},
        )
        assert response.status_code == 201, "names differ by case; the id does not"
        assert response.json()["data"]["id"] == "appa-2"

    async def test_an_unknown_broker_is_refused_by_name(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            "/api/trading-clients",
            json={"displayName": "X", "broker": "upstox", "clientId": "U1"},
        )
        assert response.status_code == 400
        assert "ZERODHA" in response.json()["message"]

    async def test_the_list_is_in_display_order(self, client: httpx.AsyncClient) -> None:
        await add(client, displayName="Thatha", clientId="TH1")
        await add(client, displayName="Amma", clientId="AM1")
        listed = (await client.get("/api/trading-clients")).json()["data"]
        assert [row["displayName"] for row in listed] == ["Amma", "Thatha"]


class TestEditing:
    async def test_fields_are_changed_one_at_a_time(self, client: httpx.AsyncClient) -> None:
        await add(client)
        response = await client.put(
            "/api/trading-clients/appa", json={"staticIp": "10.0.0.5", "isPro": True}
        )
        assert response.status_code == 200
        body = response.json()["data"]
        assert body["staticIp"] == "10.0.0.5"
        assert body["isPro"] is True
        assert body["clientId"] == "AB1234", "untouched"

    async def test_an_empty_secret_clears_it_and_an_absent_one_keeps_it(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, apiSecret="kite-secret")
        await client.put("/api/trading-clients/appa", json={"apiKey": "new-key"})
        assert (await one(client, "appa"))["hasApiSecret"] is True

        await client.put("/api/trading-clients/appa", json={"apiSecret": ""})
        assert (await one(client, "appa"))["hasApiSecret"] is False

    async def test_choosing_the_market_data_source_unchooses_the_previous(
        self, client: httpx.AsyncClient
    ) -> None:
        """At most one; the operator simply picks, and the database agrees."""
        await add(client, displayName="Appa", clientId="A1", isMarketDataSource=True)
        await add(client, displayName="Amma", clientId="M1")

        await client.put("/api/trading-clients/amma", json={"isMarketDataSource": True})

        assert (await one(client, "amma"))["isMarketDataSource"] is True
        assert (await one(client, "appa"))["isMarketDataSource"] is False

    async def test_a_dealer_account_names_who_logs_in_for_it(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, displayName="Dealer", clientId="D1")
        created = await add(client, displayName="Sub", clientId="S1", usesCredentialsOf="dealer")
        assert created["usesCredentialsOf"] == "dealer"
        assert created["canLogin"] is False

    async def test_it_cannot_ride_on_an_account_at_another_broker(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, displayName="Dealer", clientId="D1", broker="zerodha")
        response = await client.post(
            "/api/trading-clients",
            json={
                "displayName": "Sub",
                "broker": "fyers",
                "clientId": "S1",
                "usesCredentialsOf": "dealer",
            },
        )
        assert response.status_code == 400
        assert "ZERODHA" in response.json()["message"]

    async def test_the_account_others_log_in_through_cannot_be_deleted(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, displayName="Dealer", clientId="D1")
        await add(client, displayName="Sub", clientId="S1", usesCredentialsOf="dealer")

        response = await client.delete("/api/trading-clients/dealer")

        assert response.status_code == 409
        assert "Sub" in response.json()["message"]
        assert (await client.get("/api/trading-clients/dealer")).status_code == 200

    async def test_an_ordinary_account_is_deleted(self, client: httpx.AsyncClient) -> None:
        await add(client)
        assert (await client.delete("/api/trading-clients/appa")).status_code == 200
        assert (await client.get("/api/trading-clients/appa")).status_code == 404


class TestLoggingIn:
    async def test_zerodha_returns_the_browser_url_and_the_callback_to_register(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, apiKey="kite-key", apiSecret="kite-secret")

        response = await client.post("/api/trading-clients/appa/login")

        assert response.status_code == 200
        body = response.json()["data"]
        assert body["loginStyle"] == "REDIRECT"
        assert "kite.zerodha.com/connect/login" in body["url"]
        assert "api_key=kite-key" in body["url"]
        assert body["callbackPath"] == "/api/auth/callback/zerodha/appa"

    async def test_without_a_key_and_secret_there_is_nothing_to_log_in_with(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client)
        response = await client.post("/api/trading-clients/appa/login")
        assert response.status_code == 400
        assert "API key" in response.json()["message"]

    async def test_a_dealer_sub_account_is_sent_to_the_account_that_logs_in(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, displayName="Dealer", clientId="D1", apiKey="k", apiSecret="s")
        await add(client, displayName="Sub", clientId="S1", usesCredentialsOf="dealer")
        response = await client.post("/api/trading-clients/sub/login")
        assert response.status_code == 400
        assert "Dealer" in response.json()["message"]

    async def test_a_broker_with_no_login_built_says_so(self, client: httpx.AsyncClient) -> None:
        await add(client, broker="kotak", apiKey="k", apiSecret="s")
        response = await client.post("/api/trading-clients/appa/login")
        assert response.status_code == 400
        assert "KOTAK" in response.json()["message"]


class TestTheCallback:
    """The vendor sends the browser back here with a code."""

    async def test_a_completed_login_is_stored_against_the_account(
        self,
        client: httpx.AsyncClient,
        session_factory: async_sessionmaker[AsyncSession],
        renewals: Renewals,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        await add(client, apiKey="kite-key", apiSecret="kite-secret")
        _kite_answers(monkeypatch, user_id="AB1234")

        response = await client.get(
            "/api/auth/callback/zerodha/appa?request_token=rt-1", follow_redirects=False
        )

        assert response.status_code == 307
        assert (
            response.headers["location"]
            == "/console/trading-clients?login=zerodha&ok=1&client=appa"
        )
        body = await one(client, "appa")
        assert body["isLoggedIn"] is True
        assert body["loginError"] is None
        assert body["sessionCreatedOn"] == NOW.isoformat()
        async with session_factory() as session:
            status = await TradingClientLoginStatusRepository(session).get("appa")
            assert status is not None
            assert SECRETS.open(status.access_token_encrypted) == "access-1"
            assert SECRETS.open(status.public_token_encrypted) == "public-1"
            assert status.request_token == "rt-1"
            # Nothing in the provider table: the session is the account's.
            assert await DataProviderSessionsRepository(session).get("zerodha") is None
        assert await renewals.settled() == 1, "the engine was told to re-read its sessions"

    async def test_a_login_as_the_wrong_account_is_refused_and_recorded(
        self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Routing orders to whoever happened to log in would put them on
        the wrong account. The reason is kept on the row, as the reference
        does, so the page says why rather than only that."""
        await add(client, apiKey="kite-key", apiSecret="kite-secret")
        _kite_answers(monkeypatch, user_id="ZZ0000")

        response = await client.get(
            "/api/auth/callback/zerodha/appa?request_token=rt-1", follow_redirects=False
        )

        assert response.status_code == 307
        assert "error=" in response.headers["location"]
        body = await one(client, "appa")
        assert body["isLoggedIn"] is False
        assert "ZZ0000" in body["loginError"]
        assert body["lastLoginAttemptAt"] == NOW.isoformat()

    async def test_the_callback_for_an_unknown_account_says_so(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get(
            "/api/auth/callback/zerodha/nobody?request_token=rt-1", follow_redirects=False
        )
        assert response.status_code == 307
        assert "not+a+trading+client" in response.headers["location"]

    async def test_a_provider_borrowing_the_account_sees_the_login_too(
        self, client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """One session, read from two pages. Storing it as a provider
        session -- which the callback did -- left this page saying logged
        out while a token nothing read sat in the other table."""
        await add(client, apiKey="kite-key", apiSecret="kite-secret")
        await client.put(
            "/api/data-providers/zerodha",
            json={"enabled": True, "credentialSource": "TRADING_CLIENT", "tradingClientId": "appa"},
        )
        _kite_answers(monkeypatch, user_id="AB1234")

        await client.get("/api/auth/callback/zerodha/appa?request_token=rt-1")

        providers = (await client.get("/api/data-providers")).json()["data"]
        assert next(p for p in providers if p["provider"] == "zerodha")["isLoggedIn"] is True


class TestLoggingOut:
    async def test_logging_out_forgets_the_session(
        self,
        client: httpx.AsyncClient,
        session_factory: async_sessionmaker[AsyncSession],
        renewals: Renewals,
    ) -> None:
        await add(client)
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
        assert (await one(client, "appa"))["isLoggedIn"] is True

        response = await client.post("/api/trading-clients/appa/logout")

        assert response.status_code == 200
        assert response.json()["data"]["isLoggedIn"] is False
        assert await renewals.settled() == 1


def _kite_answers(monkeypatch: pytest.MonkeyPatch, *, user_id: str) -> None:
    """Kite's token exchange, answered locally."""

    async def exchange(self: Any, request_token: str) -> Any:
        from garuda.domain.session import BrokerSession
        from garuda.protocols.broker import FatalBrokerError

        if user_id != self._credentials.client_id:
            raise FatalBrokerError(
                f"logged in as {user_id}, but this trading client is {self._credentials.client_id}"
            )
        return BrokerSession(
            client_id=self._credentials.client_id,
            access_token="access-1",
            public_token="public-1",
            request_token=request_token,
            created_at=self._clock.now(),
        )

    monkeypatch.setattr("garuda.brokers.zerodha.auth.ZerodhaAuth.exchange", exchange)
