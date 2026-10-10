"""Where a data provider's credentials and session come from.

The distinction the whole page turns on: a **trading client** places orders, a
**data provider** supplies prices, and whether they are the same login depends
on the vendor.

* **Zerodha, Fyers, Dhan** issue one app key covering trading and market data.
  A provider configured `TRADING_CLIENT` borrows that account's key *and its
  session* — not a copy of them. There is one token, so signing in from either
  page signs in both, and neither can show a stale answer about the other.
* **XTS** issues separate market-data credentials from its trading ones, so a
  provider for it holds its own even when an XTS trading client exists.
* **TrueData** is not a broker. No orders, no trading client, only prices.

Borrowed sessions are read from the trading client's login row; own sessions
live in `data_provider_sessions`. That asymmetry is deliberate: two rows for
one login would be two things to keep in step, and they would disagree the
first time one was refreshed without the other.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError

#: The provider borrows a trading client's app credentials and session.
TRADING_CLIENT = "TRADING_CLIENT"
#: The provider holds its own.
OWN = "OWN"
CREDENTIAL_SOURCES = (TRADING_CLIENT, OWN)

#: Providers whose vendor issues one app key for trading and market data, so a
#: trading client's login can serve both.
SHAREABLE = frozenset({"zerodha", "fyers", "dhan"})

#: Providers that have no trading side at all here, so `TRADING_CLIENT` is
#: never a valid source for them.
DATA_ONLY = frozenset({"truedata"})

#: Every provider this engine can talk to, in the order an operator should meet
#: them: the two that carry data today first, then the three that configure and
#: log in but have no adapter yet. Alphabetical would open the page on a
#: provider that cannot currently do anything.
#:
#: A tuple, because this is the order the API serves and the Console renders --
#: a set has none, and sorting one at each call site is how two pages end up
#: disagreeing about where Dhan belongs.
PROVIDERS = ("zerodha", "dhan", "fyers", "xts", "truedata")

#: The same names, for membership tests. Derived so the two cannot drift.
KNOWN = frozenset(PROVIDERS)


class ProviderNotConfiguredError(DomainError):
    """The provider cannot be used: no credentials, or an impossible pairing."""


class ProviderNotLoggedInError(DomainError):
    """The provider is configured but has no live session. The operator logs in."""


@dataclass(frozen=True, slots=True)
class ProviderCredentials:
    """What connecting to one provider needs.

    `client_id` is checked against whoever the vendor says logged in, so a
    session belonging to a different account is refused rather than used.
    """

    provider: str
    api_key: str
    api_secret: str
    client_id: str | None = None
    redirect_url: str | None = None
    websocket_port: int | None = None
    history_port: int | None = None
    #: Set when these came from a trading client rather than the provider's own
    #: row -- which is what makes one login serve both pages.
    borrowed_from: TradingClientId | None = None
    #: The outbound address the vendor whitelisted, when the credentials were
    #: borrowed from a trading client that has one. Carried rather than looked
    #: up again because it belongs to whoever's key is being used: a borrowed
    #: provider calling from the wrong address is refused by the vendor in a
    #: way that reads as a bad token. A provider holding its own credentials
    #: has no such row and goes direct.
    static_ip: str | None = None

    #: Minimum spacing between calls of each kind, in milliseconds, straight
    #: from the provider's row. Zero is no gate. These belong to the provider
    #: even when the credentials are borrowed: how hard to lean on an API is a
    #: property of the API, not of whose key opens it.
    quote_min_interval_ms: int = 0
    history_min_interval_ms: int = 0
    #: How many instruments go in one quote request, where the provider batches.
    batch_size: int | None = None

    @property
    def is_borrowed(self) -> bool:
        return self.borrowed_from is not None


@dataclass(frozen=True, slots=True)
class ProviderSession:
    """A live token for one provider."""

    provider: str
    access_token: str
    obtained_at: datetime
    client_id: str | None = None
    borrowed_from: TradingClientId | None = None


def check_pairing(provider: str, source: str, trading_client: str | None) -> None:
    """Refuse a combination that cannot work, naming why.

    Stored and then discovered at connect time, these read as "market data is
    down" rather than as a configuration mistake, so they are refused when the
    row is written.
    """
    if provider not in KNOWN:
        raise ProviderNotConfiguredError(
            f"{provider} is not a provider this engine knows; one of {', '.join(PROVIDERS)}"
        )
    if source not in CREDENTIAL_SOURCES:
        raise ProviderNotConfiguredError(
            f"credential source must be {TRADING_CLIENT} or {OWN}, not {source!r}"
        )
    if source == TRADING_CLIENT:
        if provider in DATA_ONLY:
            raise ProviderNotConfiguredError(
                f"{provider} is a data feed with no trading side, so it cannot borrow a "
                "trading client's credentials; give it its own"
            )
        if provider not in SHAREABLE:
            raise ProviderNotConfiguredError(
                f"{provider} issues separate market-data credentials from its trading ones, "
                "so it cannot borrow a trading client's; give it its own"
            )
        if not trading_client:
            raise ProviderNotConfiguredError(
                f"{provider} is set to use a trading client's credentials but names none"
            )
    elif trading_client:
        raise ProviderNotConfiguredError(
            f"{provider} holds its own credentials, so it should not also name a trading "
            "client; the trading client would be ignored"
        )
