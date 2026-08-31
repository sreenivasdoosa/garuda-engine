"""What a strategy sees when it runs for real.

One object answering two protocols: what a rule may consult, and what a leg
selector needs. Two protocols because they answer different questions — a
selector reaching for candles is doing a rule's job — and one object because
every answer in a single evaluation must come from the same instant.

Built fresh per evaluation. It is a view, not a cache: the hub and the registry
are the sources, and this holds a moment's worth of them.

**Candles and indicators are not available yet.** There is no candle store, so
``candles`` answers empty and ``indicator`` answers None, and every rule that
needs either reads UNAVAILABLE. That is the honest answer and the loud one: a
strategy waiting on an indicator will say it cannot tell, rather than looking
like one whose condition did not hold.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain.calendar import TradingCalendar
from garuda.domain.client import TradingClientId
from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.domain.symbol import SymbolInfo
from garuda.domain.trade import Trade
from garuda.engine.config import ResolvedConfig
from garuda.engine.daycondition import DayCondition, conditions_on
from garuda.marketdata.hub import TickHub
from garuda.marketdata.registry import InstrumentRegistry
from garuda.trademgmt.client import TradingClientManager

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MarketView:
    """The sources a context reads. Shared by every evaluation in a pass."""

    hub: TickHub
    registry: Callable[[], InstrumentRegistry]
    symbols: Mapping[str, SymbolInfo]
    timezone: ZoneInfo


@dataclass(frozen=True)
class LiveContext:
    """One evaluation's view of the world."""

    market: MarketView
    book: TradingClientManager
    now: datetime
    trading_day: date
    strategy: str
    trading_client: TradingClientId
    tranche: int
    config: ResolvedConfig
    underlying: InstrumentId
    day_conditions: frozenset[DayCondition] = frozenset()
    trade: Trade | None = None
    #: Ticks read in this pass, so two rules asking for one price get one
    #: answer. A tree whose first rule saw 100 and whose fifth saw 101 can
    #: contradict itself.
    _seen: dict[InstrumentId, Tick | None] = field(default_factory=dict)

    @property
    def timezone(self) -> ZoneInfo:
        return self.market.timezone

    # -- what a rule sees ---------------------------------------------------

    def quote(self, instrument: InstrumentId) -> Tick | None:
        if instrument not in self._seen:
            self._seen[instrument] = self.market.hub.latest(instrument)
        return self._seen[instrument]

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        """Nothing yet. There is no candle store, and saying so is the point."""
        del instrument, interval, count
        return ()

    def indicator(
        self,
        name: str,
        instrument: InstrumentId,
        interval: BarInterval,
        **params: object,
    ) -> Decimal | None:
        """Nothing yet, for the same reason: an indicator is candles."""
        del name, instrument, interval, params
        return None

    def positions(self) -> Sequence[Trade]:
        return self.book.trades_for(self.strategy)

    # -- what a selector needs ----------------------------------------------

    def spot(self, underlying: InstrumentId) -> Money | None:
        """The price strikes are chosen around.

        The underlying's own last trade, which for an index is the index level
        the feed publishes. A strategy whose underlying is not subscribed has
        no spot, and every leg of it will fail to resolve — loudly, at the
        evaluator, rather than by picking a strike around a stale number.
        """
        quote = self.quote(underlying)
        return quote.last_price if quote is not None else None

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        info = self._symbol(underlying)
        return info.strike_gap if info is not None else None

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        return self.market.registry().expiry_for(underlying, kind, self.trading_day)

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        listed = self.market.registry().option_at(underlying, expiry, strike, option_type)
        return listed.id if listed is not None else None

    def future(self, underlying: InstrumentId, expiry: date) -> InstrumentId | None:
        for candidate in self.market.registry().futures_for(underlying):
            if candidate.expiry == expiry:
                return candidate.id
        return None

    def _symbol(self, underlying: InstrumentId) -> SymbolInfo | None:
        """The curated knowledge about an underlying.

        Keyed by the bare symbol, because that is how an operator curates it —
        one row for the underlying, not one per venue it might be listed on.
        """
        name = underlying.value.split(":", 1)[-1]
        info = self.market.symbols.get(name)
        if info is None:
            logger.warning(
                "%s: %s has no curated symbol info, so no strike gap and no strikes",
                self.strategy,
                underlying,
            )
        return info


def day_conditions_for(
    underlying: InstrumentId,
    trading_day: date,
    registry: InstrumentRegistry,
    calendar: TradingCalendar,
) -> frozenset[DayCondition]:
    """Which kinds of day this is, for the series the strategy trades.

    Measured against the nearest listed expiry, which is the weekly for
    anything that has one and the monthly for anything that does not — because
    that is then the only expiry it has.
    """
    return conditions_on(trading_day, registry.nearest_expiry(underlying, trading_day), calendar)
