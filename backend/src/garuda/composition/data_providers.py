"""Reading data-provider configuration and sessions out of the database.

The resolver below answers two questions per provider — what credentials does
it connect with, and is it logged in — and answers them the same way whether
the provider owns its credentials or borrows a trading client's. That is the
whole point: the Data Providers page and the Trading Clients page ask
different objects and get one answer, because there is one session underneath
rather than two kept in step.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.sessions import SessionResolver
from garuda.domain.client import TradingClientId
from garuda.marketdata.providers.credentials import (
    TRADING_CLIENT,
    ProviderCredentials,
    ProviderNotConfiguredError,
    ProviderSession,
)
from garuda.persistence.models import DataProviderSessionsRow, DataProvidersRow
from garuda.persistence.secrets import SecretBox
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class DataProviders:
    """Every configured provider, with its credentials and session resolved."""

    configured: Mapping[str, ProviderCredentials]
    sessions: Mapping[str, ProviderSession]
    #: Providers with a row that cannot be used, and why. Kept rather than
    #: dropped so the Console can show the reason instead of the provider
    #: merely being absent.
    unusable: Mapping[str, str]

    def credentials_for(self, provider: str) -> ProviderCredentials:
        found = self.configured.get(provider)
        if found is None:
            why = self.unusable.get(provider)
            raise ProviderNotConfiguredError(
                f"{provider}: {why}" if why else f"{provider} is not configured"
            )
        return found

    def is_logged_in(self, provider: str) -> bool:
        return provider in self.sessions

    def connection_for(self, provider: str) -> ProviderConnection | None:
        """Credentials and a live token together, or None if either is missing.

        None rather than a raise: a provider configured but not logged in is
        an ordinary morning state, and the caller says so in its own words.
        """
        credentials = self.configured.get(provider)
        session = self.sessions.get(provider)
        if credentials is None or session is None:
            return None
        return ProviderConnection(credentials=credentials, session=session)


@dataclass(frozen=True)
class ProviderConnection:
    """One provider, configured and logged in."""

    credentials: ProviderCredentials
    session: ProviderSession

    @property
    def provider(self) -> str:
        return self.credentials.provider

    @property
    def client_id(self) -> str:
        """Whoever the vendor says logged in, falling back to what was
        configured. Dhan sends it on every request."""
        return self.session.client_id or self.credentials.client_id or ""


async def load_data_providers(
    sessions: async_sessionmaker[AsyncSession],
    secrets: SecretBox,
    resolver: SessionResolver,
) -> DataProviders:
    """Read every provider row and resolve what it needs to connect."""
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.data_providers.all(order_by="provider")
        own_sessions = await uow.repositories.data_provider_sessions.all()

    stored: dict[str, DataProviderSessionsRow] = {r.provider: r for r in own_sessions}
    configured: dict[str, ProviderCredentials] = {}
    live: dict[str, ProviderSession] = {}
    unusable: dict[str, str] = {}

    for row in rows:
        if not row.enabled:
            unusable[row.provider] = "not enabled"
            continue
        try:
            credentials = _credentials_for(row, secrets, resolver)
        except ProviderNotConfiguredError as error:
            # One misconfigured provider must not stop the others. It is named
            # here and shows on the page as unusable with its reason.
            logger.warning("data provider %s is not usable: %s", row.provider, error)
            unusable[row.provider] = str(error)
            continue
        configured[row.provider] = credentials

        session = _session_for(row, credentials, secrets, resolver, stored.get(row.provider))
        if session is not None:
            live[row.provider] = session

    logger.info("%d data provider(s) configured, %d logged in", len(configured), len(live))
    return DataProviders(configured=configured, sessions=live, unusable=unusable)


def _credentials_for(
    row: DataProvidersRow, secrets: SecretBox, resolver: SessionResolver
) -> ProviderCredentials:
    if row.credential_source == TRADING_CLIENT:
        return _borrowed(row, resolver)
    return _own(row, secrets)


def _borrowed(row: DataProvidersRow, resolver: SessionResolver) -> ProviderCredentials:
    """Credentials taken from a trading client, not copied from it."""
    if not row.trading_client_id:
        raise ProviderNotConfiguredError("set to use a trading client but names none")
    client_id = TradingClientId(row.trading_client_id)
    account = resolver.configured(client_id)
    if account is None:
        raise ProviderNotConfiguredError(
            f"names trading client {row.trading_client_id!r}, which does not exist"
        )
    if not account.api_key:
        raise ProviderNotConfiguredError(
            f"trading client {account.label} has no API key, so there is nothing to borrow"
        )
    return ProviderCredentials(
        provider=row.provider,
        api_key=account.api_key,
        # The secret lives with the trading client and is only needed to
        # complete a login, which the trading client's own flow does.
        api_secret="",
        client_id=account.client_id,
        borrowed_from=client_id,
        static_ip=account.static_ip,
        quote_min_interval_ms=row.quote_min_interval_ms or 0,
        history_min_interval_ms=row.history_min_interval_ms or 0,
        batch_size=row.batch_size,
    )


def _own(row: DataProvidersRow, secrets: SecretBox) -> ProviderCredentials:
    if not row.api_key:
        raise ProviderNotConfiguredError("has no API key")
    try:
        secret = secrets.open(row.api_secret_encrypted)
    except Exception as error:
        raise ProviderNotConfiguredError(
            f"its stored secret cannot be decrypted ({error}); re-enter it"
        ) from None
    if not secret:
        raise ProviderNotConfiguredError("has no API secret")
    return ProviderCredentials(
        provider=row.provider,
        api_key=row.api_key,
        api_secret=secret,
        client_id=row.client_id,
        redirect_url=row.redirect_url,
        websocket_port=row.websocket_port,
        history_port=row.history_port,
        quote_min_interval_ms=row.quote_min_interval_ms or 0,
        history_min_interval_ms=row.history_min_interval_ms or 0,
        batch_size=row.batch_size,
    )


def _session_for(
    row: DataProvidersRow,
    credentials: ProviderCredentials,
    secrets: SecretBox,
    resolver: SessionResolver,
    stored: DataProviderSessionsRow | None,
) -> ProviderSession | None:
    """The provider's live token, from wherever it actually lives.

    A borrowed provider reads the trading client's session. There is no second
    copy, which is why logging in on either page shows on both.
    """
    if credentials.is_borrowed:
        assert credentials.borrowed_from is not None
        broker_session = resolver.session_of(credentials.borrowed_from)
        if broker_session is None:
            return None
        return ProviderSession(
            provider=row.provider,
            access_token=broker_session.access_token,
            obtained_at=broker_session.created_at,
            client_id=broker_session.client_id,
            borrowed_from=credentials.borrowed_from,
        )

    if stored is None:
        return None
    try:
        token = secrets.open(stored.access_token_encrypted)
    except Exception:
        logger.exception(
            "could not decrypt %s's stored session; it will be treated as logged out",
            row.provider,
        )
        return None
    if not token:
        return None
    return ProviderSession(
        provider=row.provider,
        access_token=token,
        obtained_at=stored.obtained_at,
        client_id=stored.client_id,
    )


#: Where the two choices live. The names match the API's, because they are the
#: same two rows.
ACTIVE_TICKER = "marketdata.active.ticker"
ACTIVE_HISTORY = "marketdata.active.history"


async def load_active_providers(
    sessions: async_sessionmaker[AsyncSession],
) -> tuple[str | None, str | None]:
    """Which provider streams, and which answers candles.

    Both unset is a complete answer, not a failure: an install predating the
    Data Providers page nominates a trading client instead, and the engine
    falls back to that.
    """
    async with UnitOfWork(sessions) as uow:
        ticker = await uow.repositories.system_config.value_of(ACTIVE_TICKER)
        history = await uow.repositories.system_config.value_of(ACTIVE_HISTORY)
    if ticker or history:
        logger.info("active providers: ticks=%s history=%s", ticker or "-", history or "-")
    return (ticker or None), (history or None)
