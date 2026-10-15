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

**Every index on an enabled exchange is watched from the open**, whether or not
anything trades it. Three reasons, and none of them is a strategy: the Console
shows a card per index and a card with no price is the page looking broken; a
derived series is centred on its underlying, so an index that does not tick
produces no straddle and no volatility; and an index costs one subscription
where its chain costs forty. Nothing is traded as a result -- an index is not
tradable -- so this only ever adds prices.

**An underlying that derives a series needs its chain too.** A rolling
straddle is the at-the-money call plus the at-the-money put, and an implied
volatility is solved from those same two quotes -- so a series configured on
the Symbols page subscribes the chain around its underlying whether or not any
strategy trades it. Without this the index ticks, the series cannot be priced,
and nothing says so: a straddle with no quotes looks exactly like a quiet one.

**What carries the price is not always an index.** A commodity underlying has
no spot instrument at all: MCX publishes no CRUDEOIL level, only its futures.
The reference market-data service keeps two reference symbols per underlying
for exactly this -- the index where there is one, the **current-month future**
otherwise -- and warns when there is neither. That is ported here, because
without it every MCX underlying subscribes to a symbol the master has never
heard of and never ticks.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date

from garuda.domain.enums import OptionType
from garuda.domain.instrument import InstrumentId
from garuda.domain.strikes import atm_strike
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.hub import TickHub
from garuda.marketdata.reference import reference_for, underlying_instrument
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
    #: Exchange codes the operator has enabled. An index listed on an exchange
    #: that is switched off is not watched: the feed would refuse it, and on a
    #: venue that is closed today it would never tick anyway.
    exchanges: frozenset[str] = frozenset()
    _watched: set[InstrumentId] = field(default_factory=set)

    @property
    def watched(self) -> frozenset[InstrumentId]:
        return frozenset(self._watched)

    async def ensure(
        self,
        underlyings: Iterable[InstrumentId],
        registry: InstrumentRegistry,
        trading_day: date,
        *,
        held: Iterable[InstrumentId] = (),
    ) -> int:
        """Subscribe to anything newly needed. Returns how many were added."""
        wanted: set[InstrumentId] = set(held) | self.indices(registry, trading_day)
        for underlying in underlyings:
            wanted.add(underlying)
            wanted.update(self._chain(underlying, registry, trading_day))
        for info in self.configured_indices():
            # A derived series is priced from the chain, not from the level, so
            # switching one on has to subscribe the strikes as well.
            if not info.derives_anything:
                continue
            # The underlying, not the price carrier: options record `NSE:NIFTY`
            # as their underlying, and a lookup by `NSE:NIFTY_50` matches none
            # of them and subscribes nothing.
            keyed_by = underlying_instrument(info)
            if keyed_by is not None:
                wanted.update(self._chain(keyed_by, registry, trading_day))

        fresh = wanted - self._watched
        if not fresh:
            return 0

        await self.hub.subscribe(sorted(fresh, key=lambda i: i.value))
        self._watched |= fresh
        logger.info("watching %d more instrument(s); %d in total", len(fresh), len(self._watched))
        return len(fresh)

    def configured_indices(self) -> list[SymbolInfo]:
        """Curated indices on an enabled exchange, resolvable or not.

        Separate from :meth:`indices` because it answers a different question:
        whether this engine has any reason to sweep at all. That is decided
        before the instrument master has loaded, when nothing is resolvable
        yet.
        """
        return [
            info
            for info in self.symbols.values()
            if info.is_index and info.exchange_code in self.exchanges
        ]

    def indices(self, registry: InstrumentRegistry, trading_day: date) -> set[InstrumentId]:
        """What actually carries each curated index's price.

        The index's own feed symbol where it has one -- NIFTY's level arrives
        as "NIFTY 50", so subscribing to the derivative name would subscribe
        to nothing at all, silently. Otherwise the current-month future, which
        is the only thing quoted for a commodity underlying.
        """
        found: set[InstrumentId] = set()
        for info in self.configured_indices():
            carrier = self._reference(info, registry, trading_day)
            if carrier is not None:
                found.add(carrier)
        return found

    def _reference(
        self, info: SymbolInfo, registry: InstrumentRegistry, trading_day: date
    ) -> InstrumentId | None:
        """Shared with the Console, so a card and its subscription agree."""
        found = reference_for(info, registry, trading_day)
        if found is None:
            # Before the master loads this is every underlying, so debug rather
            # than a warning that fires once per sweep until then.
            logger.debug(
                "%s has neither a spot nor a current-month future in today's master",
                info.symbol,
            )
        return found

    def _chain(
        self, underlying: InstrumentId, registry: InstrumentRegistry, trading_day: date
    ) -> set[InstrumentId]:
        """The strikes near the money, once there is a money to be near.

        Empty until the underlying ticks, which is why this is recomputed: the
        chain is not knowable at the open, and a strategy choosing strikes it
        has no prices for chooses nothing at all.
        """
        # SymbolInfo refuses a gap of zero or less, so an absent symbol is
        # the only way there is no spacing to centre on.
        info = self.symbols.get(underlying.value.split(":", 1)[-1])
        if info is None:
            return set()
        gap = info.strike_gap

        # Centred on whatever carries the level, which for an index is a
        # different instrument from the one the chain is keyed by. Reading the
        # underlying's own id here finds nothing and quietly subscribes no
        # strikes at all.
        carrier = self._reference(info, registry, trading_day) or underlying
        quote = self.hub.latest(carrier)
        if quote is None:
            return set()

        # The kind this underlying actually lists. A commodity has no weekly
        # expiry, and asking for one subscribes no strikes at all.
        expiry = registry.option_expiry_for(underlying, info.option_expiry_kind, trading_day)
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
