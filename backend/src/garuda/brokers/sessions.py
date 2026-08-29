"""Turning a configured account into credentials something can connect with.

Three questions, all of which have to be answered before any connection is
made and none of which the connection itself can answer:

**Which account holds the session?** Usually the account itself. Under a dealer
terminal one account logs in and the others ride its token, so the account an
order is *for* and the account it is *authorised by* are different, and both
are needed: the token from one, the client id from the other.

**Which account provides market data?** Exactly one, chosen by the operator,
and not necessarily one that trades. It is the single point of failure for
every strategy's prices, so failing to resolve it says so plainly rather than
returning nothing and letting the feed look merely idle.

**Is the session still good?** Broker sessions die at a wall-clock hour rather
than after a duration, and an expired one is refused here rather than at the
first order of the day.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, time
from zoneinfo import ZoneInfo

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.session import DEFAULT_SESSION_CUTOFF, BrokerSession

#: A chain of accounts borrowing each other's credentials is already unusual;
#: this many is a configuration mistake rather than a dealer hierarchy.
MAX_CREDENTIAL_HOPS = 4


class SessionUnavailableError(DomainError):
    """No usable session for an account. Trading for it does not start."""


@dataclass(frozen=True, slots=True)
class Account:
    """A trading client, as connecting to a broker needs it."""

    id: TradingClientId
    broker: str
    #: The broker's own id for the account. Orders are placed against this.
    client_id: str
    enabled: bool = True
    api_key: str | None = None
    static_ip: str | None = None
    websocket_enabled: bool = True
    #: The account whose session this one uses instead of logging in itself.
    uses_credentials_of: TradingClientId | None = None
    is_market_data_source: bool = False


@dataclass(frozen=True, slots=True)
class Credentials:
    """Everything needed to open a connection for one account."""

    trading_client: TradingClientId
    broker: str
    #: The account the orders belong to.
    client_id: str
    api_key: str
    access_token: str
    static_ip: str | None = None
    #: The account that actually logged in. Differs from ``trading_client``
    #: only under a shared dealer session.
    authenticated_as: TradingClientId | None = None

    @property
    def is_borrowed(self) -> bool:
        return self.authenticated_as is not None and self.authenticated_as != self.trading_client


class SessionResolver:
    """Reads accounts and sessions; hands out credentials or a clear refusal."""

    def __init__(
        self,
        accounts: Mapping[TradingClientId, Account],
        sessions: Mapping[TradingClientId, BrokerSession],
        *,
        timezone: ZoneInfo,
        cutoff: time = DEFAULT_SESSION_CUTOFF,
    ) -> None:
        self._accounts = dict(accounts)
        self._sessions = dict(sessions)
        self._timezone = timezone
        self._cutoff = cutoff

    @property
    def accounts(self) -> Sequence[Account]:
        return list(self._accounts.values())

    def account(self, trading_client: TradingClientId) -> Account:
        found = self._accounts.get(trading_client)
        if found is None:
            raise SessionUnavailableError(f"{trading_client} is not a configured trading client")
        return found

    # -- the market data account -------------------------------------------

    def market_data_client(self) -> TradingClientId | None:
        """The account whose session feeds ticks and quotes, if one is chosen.

        None is a legitimate answer on a fresh install -- nobody has picked one
        yet. It is not an answer once trading starts, which is why the caller
        distinguishes the two rather than treating an absent feed as quiet.
        """
        chosen = [account for account in self._accounts.values() if account.is_market_data_source]
        if not chosen:
            return None
        if len(chosen) > 1:  # pragma: no cover - the database refuses this
            raise SessionUnavailableError(
                "more than one account is marked as the market data source: "
                + ", ".join(str(account.id) for account in chosen)
            )
        return chosen[0].id

    def market_data_credentials(self, now: datetime) -> Credentials:
        chosen = self.market_data_client()
        if chosen is None:
            raise SessionUnavailableError(
                "no account is marked as the market data source, so there are no ticks and "
                "no quotes for any strategy; choose one in the Console"
            )
        return self.credentials_for(chosen, now)

    # -- credentials --------------------------------------------------------

    def credentials_for(self, trading_client: TradingClientId, now: datetime) -> Credentials:
        """Credentials for an account, following whose session it uses."""
        account = self.account(trading_client)
        if not account.enabled:
            raise SessionUnavailableError(f"{trading_client} is disabled")

        holder = self._session_holder(account)
        session = self._sessions.get(holder.id)
        if session is None:
            raise SessionUnavailableError(
                f"{trading_client} has no broker session"
                + (
                    f" (it uses {holder.id}'s, which has not logged in)"
                    if holder.id != account.id
                    else ""
                )
            )
        if session.is_expired(now, timezone=self._timezone, cutoff=self._cutoff):
            raise SessionUnavailableError(
                f"{trading_client}: the session created at {session.created_at.isoformat()} "
                "predates today's cutoff; the operator must log in again"
            )

        api_key = holder.api_key
        if not api_key:
            # The key belongs to the account that registered the app, which is
            # the one that logs in -- not necessarily the one trading.
            raise SessionUnavailableError(f"{holder.id} has no API key configured")

        return Credentials(
            trading_client=account.id,
            broker=account.broker,
            # The account the order is for, never the one that authorised it.
            client_id=account.client_id,
            api_key=api_key,
            access_token=session.access_token,
            # The route is the trading account's own: a dealer session is
            # shared, but each account's orders leave from its own address.
            static_ip=account.static_ip,
            authenticated_as=holder.id,
        )

    def _session_holder(self, account: Account) -> Account:
        """Walk to the account that actually logs in."""
        seen = [account.id]
        current = account
        while current.uses_credentials_of is not None:
            if current.uses_credentials_of in seen:
                raise SessionUnavailableError(
                    "accounts borrow each other's credentials in a loop: "
                    + " -> ".join(str(name) for name in [*seen, current.uses_credentials_of])
                )
            if len(seen) > MAX_CREDENTIAL_HOPS:
                raise SessionUnavailableError(
                    f"{account.id} is {len(seen)} accounts away from one that logs in; "
                    "that is a misconfiguration, not a dealer hierarchy"
                )
            current = self.account(current.uses_credentials_of)
            seen.append(current.id)
        return current

    def streaming_clients(self) -> Sequence[Account]:
        """Accounts that should have an order update stream open.

        Not every account wants one: some brokers rate-limit sockets, and an
        account can be configured to be polled instead.
        """
        return [
            account
            for account in self._accounts.values()
            if account.enabled and account.websocket_enabled
        ]
