"""What the feed is asked to quote.

A strategy needs prices for three different reasons, and they arrive at
different times:

* **its underlying**, from the open, because every strike is chosen around it;
* **the option chain near the money**, once there is a spot to centre it on,
  because a selector choosing by premium can only see what is quoted;
* **whatever it is already holding**, always, because a position with no price
  cannot be stopped out.

So the watchlist is recomputed rather than fixed. The chain cannot be known
before the first tick of the underlying, and pinning it at the open would
leave a strategy choosing strikes it has no prices for — silently, since an
unquoted strike simply never wins a premium search.

**It only ever adds.** Unsubscribing a strike because spot moved would drop the
price of a position still open at that strike, and a position with no price is
one the engine cannot manage. The chain drifts wider through the day, which
costs a little bandwidth and is the right trade.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date

from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.instrument import InstrumentId
from garuda.domain.symbol import SymbolInfo
from garuda.engine.strategy import StrategySubscription
from garuda.engine.strikes import atm_strike
from garuda.marketdata.hub import TickHub
from garuda.marketdata.registry import InstrumentRegistry

logger = logging.getLogger(__name__)

#: Strikes either side of the money to watch when a symbol does not say. Wide
#: enough for a premium search to have somewhere to look, narrow enough that a
#: dozen strategies do not exhaust a connection's subscription budget.
DEFAULT_CHAIN_LEVELS = 10


@dataclass
class Watchlist:
    """Keeps the feed subscribed to what the strategies need."""

    hub: TickHub
    symbols: Mapping[str, SymbolInfo]
    _watched: set[InstrumentId] = field(default_factory=set)

    @property
    def watched(self) -> frozenset[InstrumentId]:
        return frozenset(self._watched)

    async def ensure(
        self,
        subscriptions: Sequence[StrategySubscription],
        registry: InstrumentRegistry,
        trading_day: date,
        *,
        held: Iterable[InstrumentId] = (),
    ) -> int:
        """Subscribe to anything newly needed. Returns how many were added."""
        wanted: set[InstrumentId] = set(held)
        for subscription in subscriptions:
            underlying = subscription.spec.underlying
            wanted.add(underlying)
            wanted.update(self._chain(underlying, registry, trading_day))

        fresh = wanted - self._watched
        if not fresh:
            return 0

        await self.hub.subscribe(sorted(fresh, key=lambda i: i.value))
        self._watched |= fresh
        logger.info("watching %d more instrument(s); %d in total", len(fresh), len(self._watched))
        return len(fresh)

    def _chain(
        self, underlying: InstrumentId, registry: InstrumentRegistry, trading_day: date
    ) -> set[InstrumentId]:
        """The strikes near the money, once there is a money to be near.

        Empty until the underlying ticks, which is why this is recomputed: the
        chain is not knowable at the open, and a strategy choosing strikes it
        has no prices for chooses nothing at all.
        """
        quote = self.hub.latest(underlying)
        if quote is None:
            return set()

        # SymbolInfo refuses a gap of zero or less, so an absent symbol is
        # the only way there is no spacing to centre on.
        info = self.symbols.get(underlying.value.split(":", 1)[-1])
        if info is None:
            return set()
        gap = info.strike_gap

        expiry = registry.expiry_for(underlying, ExpiryKind.WEEKLY, trading_day)
        if expiry is None:
            return set()

        levels = info.option_chain_levels
        middle = atm_strike(quote.last_price, gap)
        return {
            listed.id
            for step in range(-levels, levels + 1)
            for side in (OptionType.CALL, OptionType.PUT)
            if (listed := registry.option_at(underlying, expiry, middle + step * gap, side))
            is not None
        }


def held_instruments(trades: Iterable[object]) -> set[InstrumentId]:
    """What the account is holding, so its prices never lapse."""
    return {
        trade.instrument  # type: ignore[attr-defined]
        for trade in trades
        if getattr(trade, "is_live", False)
    }
