"""Builders for the composition tests.

Nothing here touches a database, a socket or a wall clock. Building an engine
must be inspectable without any of the three -- that is most of the point of
keeping construction separate from starting.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import UTC, datetime, time
from typing import cast
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.sessions import Account, SessionResolver
from garuda.brokers.websocket import Connector, WebSocketConnection
from garuda.composition.engine import Engine, build_engine
from garuda.composition.venues import Venues, venues_from
from garuda.core.clock import ReplayClock
from garuda.domain.client import TradingClientId
from garuda.domain.session import BrokerSession
from garuda.persistence.models import ExchangesRow

IST = ZoneInfo("Asia/Kolkata")
#: A Monday morning, after the session cutoff.
NOW = datetime(2026, 8, 31, 4, 0, tzinfo=UTC)
LOGGED_IN_AT = datetime(2026, 8, 31, 3, 0, tzinfo=UTC)

APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")


def account(
    name: TradingClientId,
    client_id: str,
    *,
    enabled: bool = True,
    market_data: bool = False,
    uses: TradingClientId | None = None,
) -> Account:
    return Account(
        id=name,
        broker="zerodha",
        client_id=client_id,
        display_name=name.value.title(),
        enabled=enabled,
        api_key="key",
        uses_credentials_of=uses,
        is_market_data_source=market_data,
    )


def session(client_id: str, *, at: datetime = LOGGED_IN_AT) -> BrokerSession:
    return BrokerSession(client_id=client_id, access_token="tok", created_at=at)


def resolver_for(
    accounts: list[Account], sessions: dict[TradingClientId, BrokerSession]
) -> SessionResolver:
    return SessionResolver({a.id: a for a in accounts}, sessions, timezone=IST)


@pytest.fixture
def clock() -> ReplayClock:
    return ReplayClock(NOW)


@pytest.fixture
def venues() -> Venues:
    return venues_from(
        [
            ExchangesRow(
                exchange_code="NSE",
                exchange_name="National Stock Exchange",
                timezone="Asia/Kolkata",
                market_open=time(9, 15),
                market_close=time(15, 30),
                currency="INR",
                segments="EQUITY,FNO",
                is_active=True,
                intraday_squareoff_minutes_before_close=20,
            )
        ],
        [],
    )


@pytest.fixture
def sessions() -> async_sessionmaker[AsyncSession]:
    """A session factory nothing in these tests is allowed to open.

    Construction must not touch the database. If something does, the cast
    fails loudly at the point of use rather than quietly working against a
    real connection.
    """
    return cast("async_sessionmaker[AsyncSession]", object())


@pytest.fixture
def connector() -> Connector:
    async def refuse(url: str) -> WebSocketConnection:
        raise AssertionError(f"building an engine must not open {url}")

    return cast("Connector", refuse)


#: Builds an engine from a list of accounts and whoever has logged in.
type EngineBuilder = Callable[[list[Account], dict[TradingClientId, BrokerSession]], Engine]


@pytest.fixture
def build_with(
    sessions: async_sessionmaker[AsyncSession],
    venues: Venues,
    clock: ReplayClock,
    connector: Connector,
) -> EngineBuilder:
    def make(
        accounts: list[Account], sessions_by_client: dict[TradingClientId, BrokerSession]
    ) -> Engine:
        return build_engine(
            sessions=sessions,
            resolver=resolver_for(accounts, sessions_by_client),
            venues=venues,
            clock=clock,
            now=NOW,
            connector=connector,
        )

    return make
