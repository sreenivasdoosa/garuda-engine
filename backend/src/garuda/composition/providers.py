"""Saying what each data provider can actually do.

The registry is a table of names to adapters; this is where the table is
filled in. It lives in the composition root because that is the one place
allowed to see both the adapters and the seam they plug into — a broker
adapter importing the market-data registry would be one adapter reaching
into another.

Zerodha and Dhan have adapters. Fyers, XTS and TrueData are configured, log
in and hold a session, and carry no data: their instrument masters and REST
and socket clients are not written. They stay in the registry with nothing
attached so that choosing one fails with *why*, rather than as an unknown
name or, worse, as silence.
"""

from __future__ import annotations

import logging
from typing import Any

from garuda.brokers.routing import trading_client_factory
from garuda.brokers.zerodha.feed import ZerodhaFeed
from garuda.brokers.zerodha.history import ZerodhaHistory
from garuda.brokers.zerodha.rest import KiteClient
from garuda.marketdata.history import HistorySource
from garuda.marketdata.providers.dhan_data import DhanHistory, DhanQuotes
from garuda.marketdata.providers.dhan_feed import DhanFeed
from garuda.marketdata.providers.dhan_rest import DhanRest
from garuda.marketdata.providers.registry import ProviderAdapters, register
from garuda.protocols.feed import MarketDataFeed
from garuda.protocols.quotes import QuoteSource

logger = logging.getLogger(__name__)


def _zerodha_feed(
    *, api_key: str, access_token: str, registry: Any, clock: Any, connector: Any, **_: Any
) -> MarketDataFeed:
    return ZerodhaFeed(api_key, access_token, registry, clock, connector)


def _zerodha_history(
    *, api_key: str, access_token: str, registry: Any, static_ip: str | None = None, **_: Any
) -> HistorySource:
    return ZerodhaHistory(
        KiteClient(api_key, access_token, trading_client_factory(static_ip)), registry
    )


def _dhan_rest(
    *,
    access_token: str,
    client_id: str,
    http: Any,
    clock: Any,
    quote_gate: Any,
    history_gate: Any,
    **_: Any,
) -> DhanRest:
    return DhanRest(
        access_token,
        client_id,
        http,
        clock,
        quote_gate=quote_gate,
        history_gate=history_gate,
    )


def _dhan_feed(
    *,
    access_token: str,
    client_id: str,
    catalogue: Any,
    registry: Any,
    clock: Any,
    connector: Any,
    **_: Any,
) -> MarketDataFeed:
    return DhanFeed(access_token, client_id, catalogue, registry, clock, connector)


def _dhan_history(*, catalogue: Any, registry: Any, **kwargs: Any) -> HistorySource:
    return DhanHistory(
        _dhan_rest(catalogue=catalogue, registry=registry, **kwargs), catalogue, registry
    )


def _dhan_quotes(*, catalogue: Any, registry: Any, clock: Any, **kwargs: Any) -> QuoteSource:
    rest = _dhan_rest(catalogue=catalogue, registry=registry, clock=clock, **kwargs)
    return DhanQuotes(rest, catalogue, registry, clock)


def register_providers() -> None:
    """Fill in the registry. Idempotent, and called once when an engine is built."""
    register(
        "zerodha",
        ProviderAdapters(feed=_zerodha_feed, history=_zerodha_history),
    )
    register(
        "dhan",
        ProviderAdapters(feed=_dhan_feed, history=_dhan_history, quotes=_dhan_quotes),
    )
