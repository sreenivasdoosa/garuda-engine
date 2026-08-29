"""Reading the configured accounts and their sessions out of the database.

The bridge between rows and the value objects everything above works in. It is
deliberately dumb: it maps, it does not decide. Whether an account may trade is
the session resolver's answer, not this file's.
"""

from __future__ import annotations

import logging
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.sessions import Account, SessionResolver
from garuda.domain.client import TradingClientId
from garuda.domain.session import BrokerSession
from garuda.persistence.secrets import SecretBox
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


async def load_accounts(
    sessions: async_sessionmaker[AsyncSession],
) -> dict[TradingClientId, Account]:
    """Every configured trading client, enabled or not.

    Disabled accounts are loaded too. They are refused later, by name, which
    is a better answer for an operator than an account that has silently
    vanished from the engine.
    """
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.trading_clients.all()

    return {
        TradingClientId(row.id): Account(
            id=TradingClientId(row.id),
            broker=row.broker,
            client_id=row.client_id,
            display_name=row.display_name,
            enabled=row.enabled,
            api_key=row.api_key,
            static_ip=row.static_ip,
            websocket_enabled=row.websocket_enabled,
            uses_credentials_of=(
                TradingClientId(row.uses_credentials_of) if row.uses_credentials_of else None
            ),
            is_market_data_source=row.is_market_data_source,
        )
        for row in rows
    }


async def load_sessions(
    sessions: async_sessionmaker[AsyncSession], secrets: SecretBox
) -> dict[TradingClientId, BrokerSession]:
    """The broker sessions an operator has already established.

    A row with no access token is not a session -- the account has a login
    record because it tried, not because it succeeded. Tokens are encrypted at
    rest, so a row that will not decrypt is skipped rather than crashing the
    load: one unreadable secret must not stop every other account trading.
    """
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.trading_client_login_status.all()

    loaded: dict[TradingClientId, BrokerSession] = {}
    for row in rows:
        if not row.access_token_encrypted or not row.session_created_on:
            continue
        try:
            token = secrets.open(row.access_token_encrypted)
        except Exception:
            logger.exception(
                "could not decrypt the stored session for %s; it will be treated as not logged in",
                row.trading_client_id,
            )
            continue
        if not token:
            # A login row with no readable token is an account that tried, not
            # one that succeeded.
            continue
        loaded[TradingClientId(row.trading_client_id)] = BrokerSession(
            client_id=row.client_id,
            access_token=token,
            created_at=row.session_created_on,
            public_token=secrets.open(row.public_token_encrypted),
        )
    return loaded


async def build_resolver(
    sessions: async_sessionmaker[AsyncSession], secrets: SecretBox, timezone: ZoneInfo
) -> SessionResolver:
    accounts = await load_accounts(sessions)
    broker_sessions = await load_sessions(sessions, secrets)
    logger.info(
        "%d trading clients configured, %d with a broker session",
        len(accounts),
        len(broker_sessions),
    )
    return SessionResolver(accounts, broker_sessions, timezone=timezone)
