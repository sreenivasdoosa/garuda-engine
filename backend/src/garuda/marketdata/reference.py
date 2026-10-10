"""What actually carries an underlying's price.

Three cases, and the difference matters because getting it wrong is silent:

* **An index with its own feed symbol.** NIFTY's level is published as
  "NIFTY 50". Subscribing to "NIFTY" subscribes to nothing.
* **A symbol that is its own spot.** A stock quotes under its own name.
* **A symbol with no spot at all.** MCX publishes no CRUDEOIL level, only its
  futures, so the **current-month future** is the reference. The reference
  market-data service keeps exactly this pair -- an index reference and a
  futures reference -- and warns when it has neither.

It lives here, below both the composition root and the API, because both need
the same answer: the watchlist decides what to subscribe from it, and the
Console decides which instrument a card should watch for. Two copies of this
rule would put a card on one symbol and the subscription on another, and the
card would sit empty with nothing logged anywhere.
"""

from __future__ import annotations

import logging
from datetime import date

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId, canonical_symbol
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.registry import InstrumentRegistry

logger = logging.getLogger(__name__)


def named_instrument(info: SymbolInfo) -> InstrumentId | None:
    """Where the **price** is expected, from the symbol's own spelling.

    Built from ``spot_symbol``, so for NIFTY this is ``NSE:NIFTY_50``. It is
    not the id the option chain is keyed by -- see
    :func:`underlying_instrument` -- and the two are easy to confuse because
    they are equal for every symbol whose level happens to be published under
    its own name.
    """
    return _id_for(info, info.spot_symbol)


def underlying_instrument(info: SymbolInfo) -> InstrumentId | None:
    """What the **chain** is keyed by: the underlying itself.

    Built from the symbol, so for NIFTY this is ``NSE:NIFTY`` -- which is what
    every option in the master records as its underlying, and therefore the
    only id an option lookup answers to.

    Distinct from :func:`named_instrument` on purpose. Passing the price
    carrier where the underlying belongs looks harmless and silently finds no
    options at all, because ``NIFTY_50`` is not a curated symbol; SENSEX hides
    the mistake by having the same name for both.
    """
    return _id_for(info, info.symbol)


def _id_for(info: SymbolInfo, name: str) -> InstrumentId | None:
    try:
        return InstrumentId(f"{info.exchange_code}:{canonical_symbol(name)}")
    except DomainError as error:
        logger.warning("%s has no usable instrument id: %s", info.symbol, error)
        return None


def reference_for(
    info: SymbolInfo, registry: InstrumentRegistry, trading_day: date
) -> InstrumentId | None:
    """Which instrument's ticks are this underlying's price.

    None when the master lists neither a spot nor a current-month future, which
    before the master loads is every underlying -- so callers treat it as "not
    yet" rather than as a fault.
    """
    named = named_instrument(info)
    if named is None:
        return None

    # An index symbol is the operator saying "the level arrives under this
    # name". Trust it; the feed reports it if the master disagrees.
    if info.index_symbol:
        return named

    if registry.get(named) is not None:
        return named

    future = registry.near_month_future(named, trading_day)
    return future.id if future is not None else None
