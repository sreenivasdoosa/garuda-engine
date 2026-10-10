"""Which adapter serves which provider.

The two active settings name a provider; this turns a name into the things
that actually carry data. A provider may implement some and not others —
that is not a defect, it is the state of the port — so each is optional and
absence is reported rather than papered over.

Registering an adapter here is the whole of "adding a provider" once its
adapter exists. Nothing above this knows which one answered.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from garuda.domain.errors import DomainError
from garuda.marketdata.history import HistorySource
from garuda.protocols.feed import MarketDataFeed
from garuda.protocols.quotes import QuoteSource

#: Built with whatever the caller has to hand -- credentials, a registry, a
#: clock. Deliberately untyped in its arguments: the composition root supplies
#: them and each adapter takes what it needs.
FeedFactory = Callable[..., MarketDataFeed]
HistoryFactory = Callable[..., HistorySource]
QuoteFactory = Callable[..., QuoteSource]


class ProviderUnsupportedError(DomainError):
    """The provider is configured and logged in, but cannot do what was asked.

    Raised rather than returning None so the reason reaches the operator: a
    provider selected for ticks that has no feed adapter looks exactly like an
    outage otherwise.
    """


@dataclass(frozen=True)
class ProviderAdapters:
    """What one provider can actually do in this engine."""

    #: Streams ticks. None means it cannot be the active ticker provider.
    feed: FeedFactory | None = None
    #: Answers candles. None means it cannot be the active history provider.
    history: HistoryFactory | None = None
    #: Answers prices on demand.
    quotes: QuoteFactory | None = None

    @property
    def can_stream(self) -> bool:
        return self.feed is not None

    @property
    def can_answer_history(self) -> bool:
        return self.history is not None


#: Every provider the engine can talk to, and what each one can do here.
#:
#: The four beyond Zerodha are configured, log in and store a session, and
#: carry no data yet: their instrument masters, REST adapters and socket
#: clients are not written. They are listed with empty adapters rather than
#: omitted, so selecting one fails with "cannot stream ticks" instead of
#: "unknown provider", which is a different and more confusing thing to debug.
ADAPTERS: dict[str, ProviderAdapters] = {
    "zerodha": ProviderAdapters(),
    "fyers": ProviderAdapters(),
    "dhan": ProviderAdapters(),
    "xts": ProviderAdapters(),
    "truedata": ProviderAdapters(),
}


def register(provider: str, adapters: ProviderAdapters) -> None:
    """Say what a provider can do. Called at import by each adapter module."""
    ADAPTERS[provider] = adapters


def adapters_for(provider: str) -> ProviderAdapters:
    found = ADAPTERS.get(provider)
    if found is None:
        raise ProviderUnsupportedError(f"{provider} is not a provider this engine knows")
    return found


def feed_factory(provider: str) -> FeedFactory:
    adapters = adapters_for(provider)
    if adapters.feed is None:
        raise ProviderUnsupportedError(
            f"{provider} is configured but cannot stream ticks here yet; its feed adapter is "
            "not written. Choose another provider for ticks."
        )
    return adapters.feed


def history_factory(provider: str) -> HistoryFactory:
    adapters = adapters_for(provider)
    if adapters.history is None:
        raise ProviderUnsupportedError(
            f"{provider} is configured but cannot answer candles here yet; its history adapter "
            "is not written. Choose another provider for history."
        )
    return adapters.history


def quote_factory(provider: str) -> QuoteFactory:
    adapters = adapters_for(provider)
    if adapters.quotes is None:
        raise ProviderUnsupportedError(
            f"{provider} is configured but cannot answer quotes here yet; its quote adapter is "
            "not written. Choose another provider for quotes."
        )
    return adapters.quotes
