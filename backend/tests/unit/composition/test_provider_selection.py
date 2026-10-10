"""Which provider actually carries the day's data.

Two settings choose it -- one for ticks, one for candles -- and each falls back
to the account nominated on the Trading Clients page. The fallback is not a
degraded mode: it is what every install predating the Data Providers page has,
and it must keep working untouched.

Behavioural throughout: what got built, and from whose credentials, rather than
what the selection function returned.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.websocket import Connector
from garuda.composition.data_providers import DataProviders
from garuda.composition.engine import Engine, build_engine
from garuda.composition.venues import Venues
from garuda.core.clock import ReplayClock
from garuda.domain.session import BrokerSession
from garuda.marketdata.providers.catalogues import CatalogueHolder
from garuda.marketdata.providers.credentials import ProviderCredentials, ProviderSession
from garuda.marketdata.providers.registry import ADAPTERS, ProviderAdapters, register
from tests.unit.composition.conftest import (
    APPA,
    LOGGED_IN_AT,
    NOW,
    account,
    resolver_for,
    session,
)

#: What each built adapter recorded about how it was built. A list rather than
#: a flag so "built twice" is visible.
type Built = list[dict[str, object]]


@pytest.fixture(autouse=True)
def restore_registry() -> object:
    before = dict(ADAPTERS)
    yield
    ADAPTERS.clear()
    ADAPTERS.update(before)


@pytest.fixture
def built() -> Built:
    return []


@pytest.fixture(autouse=True)
def recording_adapters(built: Built, monkeypatch: pytest.MonkeyPatch) -> None:
    """Every provider builds the same recorder, so a test can assert which one
    was asked and what it was handed.

    ``build_engine`` fills the registry with the real adapters as it starts, so
    that is stubbed out first -- otherwise it would overwrite these and the
    tests would silently be exercising a real Kite client.
    """
    monkeypatch.setattr("garuda.composition.engine.register_providers", lambda: None)

    def recorder(provider: str) -> Callable[..., object]:
        def build(**kwargs: object) -> object:
            built.append({"provider": provider, **kwargs})
            return object()

        return build

    for name in ("zerodha", "dhan", "fyers"):
        register(
            name,
            ProviderAdapters(
                feed=recorder(name),  # type: ignore[arg-type]
                history=recorder(name),  # type: ignore[arg-type]
            ),
        )


def provider_row(
    provider: str,
    *,
    api_key: str = "provider-key",
    logged_in: bool = True,
    quote_min_interval_ms: int = 0,
    static_ip: str | None = None,
) -> DataProviders:
    credentials = ProviderCredentials(
        provider=provider,
        api_key=api_key,
        api_secret="secret",
        client_id="DHAN99",
        quote_min_interval_ms=quote_min_interval_ms,
        static_ip=static_ip,
    )
    sessions = (
        {
            provider: ProviderSession(
                provider=provider,
                access_token="provider-token",
                obtained_at=LOGGED_IN_AT,
                client_id="DHAN99",
            )
        }
        if logged_in
        else {}
    )
    return DataProviders(
        configured={provider: credentials},
        sessions=sessions,
        unusable={} if logged_in else {provider: "it has not logged in"},
    )


def build(
    *,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
    active_ticker: str | None = None,
    active_history: str | None = None,
    data_providers: DataProviders | None = None,
    market_data_account: bool = True,
    now: datetime = NOW,
) -> Engine:
    accounts = [account(APPA, "AB1234", market_data=market_data_account)]
    return build_engine(
        sessions=sessions,
        resolver=resolver_for(accounts, {APPA: session("AB1234")}),
        venues=venues,
        clock=clock,
        now=now,
        connector=connector,
        active_ticker=active_ticker,
        active_history=active_history,
        data_providers=data_providers,
        catalogues=CatalogueHolder(),
    )


def test_a_nominated_provider_carries_the_feed(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    engine = build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_ticker="dhan",
        data_providers=provider_row("dhan"),
    )

    assert engine.parts.market_data is not None
    # The feed is opened lazily by the supervisor, so selecting Dhan for ticks
    # has not yet built a Dhan anything. Only history, which is eager, has.
    assert [entry["provider"] for entry in built] == ["zerodha"]


def test_the_nominated_provider_is_built_from_its_own_credentials(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """The Data Providers row's key and its own session token -- not the
    trading client's. Getting this backwards authenticates one provider with
    another's token, which fails as "market data is down"."""
    build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_history="dhan",
        data_providers=provider_row("dhan"),
    )

    [history] = built
    assert history["provider"] == "dhan"
    assert history["api_key"] == "provider-key"
    assert history["access_token"] == "provider-token"
    assert history["client_id"] == "DHAN99"


def test_a_nominated_provider_that_has_not_logged_in_falls_back(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """An ordinary morning state, not a failure: the account nominated on the
    Trading Clients page still answers."""
    build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_history="dhan",
        data_providers=provider_row("dhan", logged_in=False),
    )

    [history] = built
    assert history["access_token"] == "tok"


def test_with_no_page_filled_in_the_nominated_account_answers(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """What every install predating the Data Providers page has."""
    build(sessions=sessions, venues=venues, clock=clock, connector=connector)

    [history] = built
    assert history["provider"] == "zerodha"
    assert history["access_token"] == "tok"


def test_ticks_and_history_can_come_from_different_providers(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """The whole reason the two settings are separate."""
    engine = build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_ticker="dhan",
        active_history="zerodha",
        data_providers=provider_row("dhan"),
    )

    assert engine.parts.market_data is not None
    [history] = built
    assert history["provider"] == "zerodha"


def test_a_provider_with_no_adapter_leaves_the_engine_without_that_part(
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """Selecting a provider whose adapter is not written must not stop the
    engine being built: it starts, and says what has no prices."""
    register("fyers", ProviderAdapters())

    engine = build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_ticker="fyers",
        data_providers=provider_row("fyers"),
    )

    assert engine.parts.market_data is None


def test_the_providers_rate_limit_reaches_the_adapter(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """The spacing is a row an operator edits; an adapter built without it
    would lean on the API as hard as the loop allows."""
    build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_history="dhan",
        data_providers=provider_row("dhan", quote_min_interval_ms=250),
    )

    [history] = built
    assert history["quote_gate"] is not None
    assert history["history_gate"] is not None


def test_a_borrowed_providers_whitelisted_address_is_honoured(
    built: Built,
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> None:
    """A provider borrowing an IP-whitelisted trading client must call from
    that client's address. Calling from the engine's own is refused by the
    vendor in a way that reads as a bad token."""
    build(
        sessions=sessions,
        venues=venues,
        clock=clock,
        connector=connector,
        active_history="dhan",
        data_providers=provider_row("dhan", static_ip="10.1.2.3"),
    )

    [history] = built
    assert history["static_ip"] == "10.1.2.3"


class TestTheSessionFollowsTheLogin:
    """A token written by the Console reaches the feed without a restart."""

    async def test_a_re_login_reaches_the_next_connect(
        self,
        built: Built,
        sessions: async_sessionmaker[AsyncSession],
        venues: Venues,
        clock: ReplayClock,
        connector: Connector,
    ) -> None:
        resolver = resolver_for(
            [account(APPA, "AB1234", market_data=True)], {APPA: session("AB1234")}
        )
        engine = build_engine(
            sessions=sessions,
            resolver=resolver,
            venues=venues,
            clock=clock,
            now=NOW,
            connector=connector,
            catalogues=CatalogueHolder(),
        )
        service = engine.parts.market_data
        assert service is not None
        await service.start()
        assert [entry["access_token"] for entry in built if entry["provider"] == "zerodha"][
            -1:
        ] == ["tok"]

        # The operator logs in again from the Console, and the engine re-reads.
        resolver.replace(
            {APPA: account(APPA, "AB1234", market_data=True)},
            {APPA: BrokerSession(client_id="AB1234", access_token="fresh", created_at=NOW)},
        )
        await service.reconnect("logged in again")
        await service.stop()

        # The monitor may have retried in between; what matters is that every
        # connect before the re-login carried the old token and the one after
        # it carries the new.
        tokens = [entry["access_token"] for entry in built if "connector" in entry]
        assert tokens[-1] == "fresh"
        assert set(tokens[:-1]) == {"tok"}

    async def test_a_nominated_provider_that_has_not_logged_in_falls_back_to_the_accounts_broker(
        self,
        built: Built,
        sessions: async_sessionmaker[AsyncSession],
        venues: Venues,
        clock: ReplayClock,
        connector: Connector,
    ) -> None:
        """A Dhan row that has not logged in falls back to a Zerodha account,
        and that account's token must open a Zerodha socket -- not a Dhan one
        handed a token it cannot use."""
        engine = build(
            sessions=sessions,
            venues=venues,
            clock=clock,
            connector=connector,
            active_ticker="dhan",
            data_providers=provider_row("dhan", logged_in=False),
        )
        service = engine.parts.market_data
        assert service is not None
        await service.start()
        await service.stop()

        feeds = [entry for entry in built if "connector" in entry]
        assert feeds, "a connect was attempted"
        assert {entry["provider"] for entry in feeds} == {"zerodha"}
        assert {entry["access_token"] for entry in feeds} == {"tok"}

    async def test_nobody_logged_in_at_build_still_leaves_a_feed_to_log_in_to(
        self,
        built: Built,
        sessions: async_sessionmaker[AsyncSession],
        venues: Venues,
        clock: ReplayClock,
        connector: Connector,
    ) -> None:
        """The service exists; connecting fails cleanly until a login lands."""
        resolver = resolver_for([account(APPA, "AB1234", market_data=True)], {})
        engine = build_engine(
            sessions=sessions,
            resolver=resolver,
            venues=venues,
            clock=clock,
            now=NOW,
            connector=connector,
            catalogues=CatalogueHolder(),
        )
        service = engine.parts.market_data
        assert service is not None
        assert await service.start() is False
        assert [entry for entry in built if "connector" in entry] == []

        resolver.replace(
            {APPA: account(APPA, "AB1234", market_data=True)},
            {APPA: BrokerSession(client_id="AB1234", access_token="fresh", created_at=NOW)},
        )
        await service.reconnect("logged in")
        await service.stop()
        assert [entry["access_token"] for entry in built if "connector" in entry] == ["fresh"]
