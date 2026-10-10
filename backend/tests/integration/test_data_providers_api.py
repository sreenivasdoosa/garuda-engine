"""The data-provider endpoints, against a real database.

The behaviour worth pinning is the one the page turns on: a provider that
borrows a trading client's credentials has **no session of its own**, so
logging in on either page shows on both. Everything else here is refusing a
pairing that cannot work, before it becomes "market data is down".
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
from garuda.api.routers import data_providers
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.persistence.secrets import SecretBox

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 9, 1, 4, 0, tzinfo=dt.UTC)
SECRETS = SecretBox("a-test-key")


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    app = FastAPI()
    envelope.install(app)
    app.include_router(data_providers.build(session_factory, SECRETS, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as open_client:
        yield open_client


@pytest.fixture
async def accounts(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """A Zerodha trading client with an app key, and no session yet."""
    async with session_factory() as session:
        session.add(
            models.TradingClientRow(
                id="appa",
                display_name="Appa",
                broker="ZERODHA",
                client_id="AB1234",
                enabled=True,
                api_key="kite-key",
                api_secret_encrypted=SECRETS.seal("kite-secret"),
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()


async def configure(client: httpx.AsyncClient, provider: str, **body: Any) -> httpx.Response:
    return await client.put(f"/api/data-providers/{provider}", json=body)


async def sign_in_the_trading_client(session_factory: async_sessionmaker[AsyncSession]) -> None:
    """What completing a Zerodha login writes against the trading client."""
    async with session_factory() as session:
        session.add(
            models.TradingClientLoginStatusRow(
                trading_client_id="appa",
                client_id="AB1234",
                access_token_encrypted=SECRETS.seal("live-token"),
                session_created_on=NOW,
                updated_on=NOW,
            )
        )
        await session.commit()


class TestListing:
    async def test_every_known_provider_is_listed_even_unconfigured(
        self, client: httpx.AsyncClient
    ) -> None:
        """The page shows what is possible, not only what is set up."""
        rows = (await client.get("/api/data-providers")).json()["data"]

        assert {row["provider"] for row in rows} == {
            "zerodha",
            "fyers",
            "dhan",
            "xts",
            "truedata",
        }
        assert all(row["isConfigured"] is False for row in rows)

    async def test_they_come_back_in_the_order_the_page_should_show_them(
        self, client: httpx.AsyncClient
    ) -> None:
        """The two that carry data first, then the three that only configure.

        Order is served rather than sorted in the Console: which providers
        matter is something the server knows, and alphabetically the page opens
        on Dhan above Zerodha and TrueData above both.
        """
        rows = (await client.get("/api/data-providers")).json()["data"]

        assert [row["provider"] for row in rows] == [
            "zerodha",
            "dhan",
            "fyers",
            "xts",
            "truedata",
        ]

    async def test_it_says_which_login_each_provider_uses(self, client: httpx.AsyncClient) -> None:
        by_name = {
            row["provider"]: row for row in (await client.get("/api/data-providers")).json()["data"]
        }

        assert by_name["zerodha"]["loginStyle"] == "REDIRECT"
        assert by_name["fyers"]["loginStyle"] == "REDIRECT"
        assert by_name["dhan"]["loginStyle"] == "REDIRECT"
        assert by_name["xts"]["loginStyle"] == "DIRECT"
        assert by_name["truedata"]["loginStyle"] == "DIRECT"

    async def test_it_says_which_can_borrow_a_trading_client(
        self, client: httpx.AsyncClient
    ) -> None:
        by_name = {
            row["provider"]: row for row in (await client.get("/api/data-providers")).json()["data"]
        }

        assert by_name["zerodha"]["canBorrowTradingClient"] is True
        assert by_name["xts"]["canBorrowTradingClient"] is False
        assert by_name["truedata"]["canBorrowTradingClient"] is False

    async def test_the_ported_rate_limits_are_the_defaults(self, client: httpx.AsyncClient) -> None:
        by_name = {
            row["provider"]: row for row in (await client.get("/api/data-providers")).json()["data"]
        }

        assert by_name["zerodha"]["quoteMinIntervalMs"] > 0
        assert by_name["zerodha"]["historyMinIntervalMs"] > 0


class TestPairing:
    async def test_a_data_only_provider_cannot_borrow_a_trading_client(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        """TrueData has no trading side, so there is nothing to borrow.

        Checked at the point of enabling, which is where a provider that
        cannot work would otherwise be put in front of the engine.
        """
        response = await configure(
            client,
            "truedata",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )

        assert response.status_code == 400
        assert "no trading side" in response.json()["message"]

    async def test_xts_cannot_borrow_because_its_data_keys_are_separate(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        response = await configure(
            client,
            "xts",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )

        assert response.status_code == 400
        assert "separate market-data credentials" in response.json()["message"]

    async def test_borrowing_without_naming_a_client_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await configure(
            client, "zerodha", enabled=True, credentialSource="TRADING_CLIENT"
        )

        assert response.status_code == 400

    async def test_a_trading_client_that_does_not_exist_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await configure(
            client, "zerodha", credentialSource="TRADING_CLIENT", tradingClientId="nobody"
        )

        assert response.status_code == 404

    async def test_an_unknown_provider_is_refused(self, client: httpx.AsyncClient) -> None:
        assert (await configure(client, "quandl", enabled=True)).status_code == 404


class TestSharedLogin:
    """The point of the whole design."""

    async def test_a_borrowed_provider_reports_the_trading_clients_session(
        self,
        client: httpx.AsyncClient,
        accounts: None,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        await configure(
            client,
            "zerodha",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )
        before = (await client.get("/api/data-providers")).json()["data"]
        assert next(r for r in before if r["provider"] == "zerodha")["isLoggedIn"] is False

        # The operator signs the trading client in, from the other page.
        await sign_in_the_trading_client(session_factory)

        after = (await client.get("/api/data-providers")).json()["data"]
        assert next(r for r in after if r["provider"] == "zerodha")["isLoggedIn"] is True

    async def test_a_borrowed_provider_stores_no_session_of_its_own(
        self,
        client: httpx.AsyncClient,
        accounts: None,
        session_factory: async_sessionmaker[AsyncSession],
    ) -> None:
        """Two rows would be two things to keep in step, and they would
        disagree the first time one was refreshed without the other."""
        await configure(
            client,
            "zerodha",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )
        await sign_in_the_trading_client(session_factory)

        async with session_factory() as session:
            from garuda.persistence.repositories import DataProviderSessionsRepository

            assert await DataProviderSessionsRepository(session).get("zerodha") is None


class TestConfiguring:
    async def test_the_secret_is_never_returned(self, client: httpx.AsyncClient) -> None:
        await configure(client, "truedata", enabled=True, apiKey="user", apiSecret="password")

        row = next(
            r
            for r in (await client.get("/api/data-providers")).json()["data"]
            if r["provider"] == "truedata"
        )
        assert row["hasApiSecret"] is True
        assert "apiSecret" not in row

    async def test_the_secret_is_encrypted_at_rest(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await configure(client, "truedata", apiKey="user", apiSecret="password")

        async with session_factory() as session:
            from garuda.persistence.repositories import DataProvidersRepository

            row = await DataProvidersRepository(session).require("truedata")
        assert row.api_secret_encrypted is not None
        assert "password" not in row.api_secret_encrypted
        assert SECRETS.open(row.api_secret_encrypted) == "password"

    async def test_an_update_touches_only_what_was_sent(self, client: httpx.AsyncClient) -> None:
        await configure(client, "truedata", apiKey="user", apiSecret="password", historyPort=8082)

        await configure(client, "truedata", enabled=True)

        row = next(
            r
            for r in (await client.get("/api/data-providers")).json()["data"]
            if r["provider"] == "truedata"
        )
        assert row["enabled"] is True
        assert row["apiKey"] == "user"
        assert row["historyPort"] == 8082
        assert row["hasApiSecret"] is True

    async def test_rate_limits_are_editable_and_cannot_be_negative(
        self, client: httpx.AsyncClient
    ) -> None:
        assert (await configure(client, "zerodha", quoteMinIntervalMs=250)).status_code == 200
        assert (await configure(client, "zerodha", quoteMinIntervalMs=-1)).status_code == 400

    async def test_a_draft_can_be_saved_half_filled_but_not_enabled(
        self, client: httpx.AsyncClient
    ) -> None:
        """An operator fills a form in the order it asks. Refusing every save
        until it is complete would make it unfillable; enabling is where it has
        to make sense."""
        assert (await configure(client, "zerodha", apiKey="partly-done")).status_code == 200

        response = await configure(client, "zerodha", enabled=True)

        assert response.status_code == 400
        assert "names none" in response.json()["message"]

    async def test_own_credentials_clear_any_named_trading_client(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        await configure(
            client,
            "zerodha",
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )

        await configure(client, "zerodha", credentialSource="OWN", apiKey="k", apiSecret="s")

        row = next(
            r
            for r in (await client.get("/api/data-providers")).json()["data"]
            if r["provider"] == "zerodha"
        )
        assert row["credentialSource"] == "OWN"
        assert row["tradingClientId"] is None


class TestActiveProviders:
    async def test_they_start_unset(self, client: httpx.AsyncClient) -> None:
        assert (await client.get("/api/data-providers/active")).json()["data"] == {
            "ticker": None,
            "history": None,
        }

    async def test_ticker_and_history_are_chosen_independently(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        await configure(
            client,
            "zerodha",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )
        await configure(client, "truedata", enabled=True, apiKey="u", apiSecret="p")

        await client.put(
            "/api/data-providers/active", json={"ticker": "truedata", "history": "zerodha"}
        )

        assert (await client.get("/api/data-providers/active")).json()["data"] == {
            "ticker": "truedata",
            "history": "zerodha",
        }

    async def test_a_provider_that_is_not_enabled_cannot_be_active(
        self, client: httpx.AsyncClient
    ) -> None:
        """Choosing one would stop market data with no indication of why."""
        await configure(client, "truedata", enabled=False, apiKey="u", apiSecret="p")

        response = await client.put("/api/data-providers/active", json={"ticker": "truedata"})

        assert response.status_code == 400
        assert (await client.get("/api/data-providers/active")).json()["data"]["ticker"] is None

    async def test_the_active_provider_cannot_be_removed(self, client: httpx.AsyncClient) -> None:
        await configure(client, "truedata", enabled=True, apiKey="u", apiSecret="p")
        await client.put("/api/data-providers/active", json={"history": "truedata"})

        response = await client.delete("/api/data-providers/truedata")

        assert response.status_code == 409


class TestLoggingIn:
    async def test_a_redirect_provider_returns_a_url_and_the_callback_to_register(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        await configure(
            client,
            "zerodha",
            enabled=True,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )

        body = (await client.post("/api/data-providers/zerodha/login")).json()["data"]

        assert body["loginStyle"] == "REDIRECT"
        assert "kite.zerodha.com/connect/login" in body["url"]
        assert "api_key=kite-key" in body["url"]
        # The path the operator registers with the broker: the identity is in
        # the path because Kite has no state parameter to carry it.
        assert body["callbackPath"] == "/api/auth/callback/zerodha/appa"

    async def test_a_provider_that_is_not_configured_cannot_log_in(
        self, client: httpx.AsyncClient
    ) -> None:
        assert (await client.post("/api/data-providers/zerodha/login")).status_code == 404

    async def test_a_provider_that_is_not_enabled_cannot_log_in(
        self, client: httpx.AsyncClient, accounts: None
    ) -> None:
        await configure(
            client,
            "zerodha",
            enabled=False,
            credentialSource="TRADING_CLIENT",
            tradingClientId="appa",
        )

        assert (await client.post("/api/data-providers/zerodha/login")).status_code == 400

    async def test_logging_out_clears_an_own_session(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await configure(client, "truedata", enabled=True, apiKey="u", apiSecret="p")
        async with session_factory() as session:
            session.add(
                models.DataProviderSessionsRow(
                    provider="truedata",
                    client_id="u",
                    access_token_encrypted=SECRETS.seal("token") or "",
                    obtained_at=NOW,
                )
            )
            await session.commit()

        await client.post("/api/data-providers/truedata/logout")

        row = next(
            r
            for r in (await client.get("/api/data-providers")).json()["data"]
            if r["provider"] == "truedata"
        )
        assert row["isLoggedIn"] is False
