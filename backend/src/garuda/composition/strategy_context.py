"""What a strategy sees when it runs for real.

One object answering two protocols: what a rule may consult, and what a leg
selector needs. Two protocols because they answer different questions — a
selector reaching for candles is doing a rule's job — and one object because
every answer in a single evaluation must come from the same instant.

Built fresh per evaluation. It is a view, not a cache: the hub and the registry
are the sources, and this holds a moment's worth of them.

Candles come from the cache, which holds what the broker's history API has
answered. Reads never wait: asking for a series nobody has fetched registers
the demand and answers empty, so the first pass over a new instrument says it
cannot tell — which is true — and the next one has the data.

Indicators are computed from those candles and cached for the length of one
evaluation, so a tree asking for the same average in three rules computes it
once and all three see one number.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time
from decimal import ROUND_DOWN, Decimal
from zoneinfo import ZoneInfo

from garuda.capital.event_days import EventDays
from garuda.domain.calendar import TradingCalendar
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ExpiryKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.domain.symbol import SymbolInfo
from garuda.domain.trade import Trade
from garuda.engine.config import ResolvedConfig
from garuda.engine.daycondition import DayCondition, conditions_on
from garuda.engine.indicators import build as build_indicator
from garuda.engine.lots import DayAllocation
from garuda.marketdata.history import CandleCache
from garuda.marketdata.hub import TickHub
from garuda.marketdata.reference import reference_for
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.synthetics import SYNTHETIC
from garuda.trademgmt.client import TradingClientManager

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class MarketView:
    """The sources a context reads. Shared by every evaluation in a pass."""

    hub: TickHub
    registry: Callable[[], InstrumentRegistry]
    symbols: Mapping[str, SymbolInfo]
    timezone: ZoneInfo
    #: Candle history, as far as it has been fetched. None before anything
    #: supplies one, which makes every candle rule read UNAVAILABLE.
    candles: CandleCache | None = None

    def spot_price(self, underlying: InstrumentId, trading_day: date) -> Money | None:
        """The level strikes are chosen around.

        **Not the underlying's own id.** An index publishes its level under a
        separate feed symbol -- NIFTY's arrives as "NIFTY 50" -- and a
        commodity publishes none at all, only futures. The option chain is
        keyed by the underlying (`NSE:NIFTY`), so a lookup that reuses that key
        for the price finds nothing: no spot, no at-the-money strike, and every
        synthetic silently prices to None.

        That is exactly what happened: real ticks flowed and not one derived
        series did, with nothing logged, because a straddle that cannot be
        priced is indistinguishable from a quiet one.

        Resolved through the same rule the watchlist subscribes by, so the
        instrument quoted and the instrument read are the same instrument.
        """
        info = self.symbols.get(underlying.value.split(":", 1)[-1])
        if info is None:
            # No curated symbol, so no reference to redirect through. The
            # underlying's own id is the only candidate left.
            quote = self.hub.latest(underlying)
            return quote.last_price if quote is not None else None
        carrier = reference_for(info, self.registry(), trading_day)
        quote = self.hub.latest(carrier or underlying)
        return quote.last_price if quote is not None else None


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
    #: Indicators computed in this pass, so a ten-rule tree is not ten
    #: computations of the same average.
    _indicators: dict[tuple[object, ...], Decimal | None] = field(default_factory=dict)

    @property
    def timezone(self) -> ZoneInfo:
        return self.market.timezone

    # -- what a rule sees ---------------------------------------------------

    def quote(self, instrument: InstrumentId) -> Tick | None:
        if instrument not in self._seen:
            self._seen[instrument] = self.market.hub.latest(instrument)
        return self._seen[instrument]

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        """Closed bars, as far as they have been fetched.

        Empty when nothing has been, which registers the demand rather than
        waiting on a broker inside a rule.
        """
        if self.market.candles is None:
            return ()
        fetched: Sequence[Bar] = self.market.candles.get(instrument, interval, count)
        return fetched

    def indicator(
        self,
        name: str,
        instrument: InstrumentId,
        interval: BarInterval,
        *,
        back: int = 0,
        params: Mapping[str, object] | None = None,
    ) -> Decimal | None:
        """One indicator, computed from closed bars.

        An indicator nobody knows raises, because that is a configuration
        error; one whose history is too short answers None, because that is a
        morning.

        ``back`` drops that many bars off the end of the window, so the value
        is the one the indicator had then. The bars behind it are asked for as
        well: a twenty-period average one bar ago still needs twenty bars.
        """
        if back < 0:
            raise DomainError(f"{name}: cannot look {back} bars back")
        shape = params or {}
        key = (name.lower(), instrument, interval, back, tuple(sorted(shape.items(), key=str)))
        if key in self._indicators:
            return self._indicators[key]

        built = build_indicator(name, **shape)
        bars = self.candles(instrument, interval, built.bars_needed + back)
        window = bars[: len(bars) - back] if back else bars
        value = built.compute(window)
        self._indicators[key] = value
        return value

    def positions(self) -> Sequence[Trade]:
        return self.book.trades_for(self.strategy)

    # -- what a selector needs ----------------------------------------------

    def spot(self, underlying: InstrumentId) -> Money | None:
        """The price strikes are chosen around.

        Read from whichever instrument carries this underlying's level, which
        for an index is a separate feed symbol. A strategy whose underlying is
        not quoted has no spot, and every leg of it fails to resolve — loudly,
        at the evaluator, rather than by picking a strike around a stale
        number.
        """
        return self.market.spot_price(underlying, self.trading_day)

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        info = self._symbol(underlying)
        return info.strike_gap if info is not None else None

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        # The option chain's expiry, not the underlying's soonest: a
        # commodity's options expire before its future, and every caller of
        # this is choosing strikes.
        return self.market.registry().option_expiry_for(underlying, kind, self.trading_day)

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        listed = self.market.registry().option_at(underlying, expiry, strike, option_type)
        return listed.id if listed is not None else None

    def strikes(self, underlying: InstrumentId, expiry: date) -> Sequence[Decimal]:
        return self.market.registry().strikes_for(underlying, expiry)

    def premium(self, instrument: InstrumentId) -> Money | None:
        """What an option is trading at, if anything is subscribed to it.

        The same read as any other quote — an option is an instrument — but
        named apart because a selector asking for one means something
        specific, and a selector reaching for the general quote would be a
        selector that could reach for anything.
        """
        quote = self.quote(instrument)
        return quote.last_price if quote is not None else None

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


@dataclass(frozen=True)
class ChainOnly:
    """The chain, with no strategy attached.

    What a synthetic reads. A rolling straddle belongs to an underlying rather
    than to whoever happens to be trading it, so pricing one through a
    strategy's context would mean inventing a strategy — and inventing one
    means choosing an underlying for it, which is the very thing the caller is
    iterating over.
    """

    market: MarketView
    trading_day: date

    def spot(self, underlying: InstrumentId) -> Money | None:
        return self.market.spot_price(underlying, self.trading_day)

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        info = self.market.symbols.get(underlying.value.split(":", 1)[-1])
        return info.strike_gap if info is not None else None

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        # The option chain's expiry, not the underlying's soonest: a
        # commodity's options expire before its future, and every caller of
        # this is choosing strikes.
        return self.market.registry().option_expiry_for(underlying, kind, self.trading_day)

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        listed = self.market.registry().option_at(underlying, expiry, strike, option_type)
        return listed.id if listed is not None else None

    def quote(self, instrument: InstrumentId) -> Tick | None:
        return self.market.hub.latest(instrument)

    def today(self) -> date:
        return self.trading_day


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


@dataclass(frozen=True)
class LiveEnvironment:
    """What the strategy pipeline reads, from one instant.

    `garuda.engine.base_strategy.StrategyEnvironment`, over the engine's own
    sources: the tick hub, the instrument master, the curated symbols, the
    venue's calendar, the day allocation and the event days. Built fresh per
    evaluation, like :class:`LiveContext`, because it holds a moment.
    """

    market: MarketView
    venue: Exchange
    now: datetime
    trading_day: date
    conditions: frozenset[DayCondition]
    day_allocation: DayAllocation
    event_days: EventDays
    underlying: InstrumentId
    memory: Mapping[str, object] = field(default_factory=dict)
    #: Derived-series values as they stood a number of minutes ago, kept by
    #: the loop as it publishes them. None means no history is kept.
    history: Callable[[InstrumentId, int], Decimal | None] | None = None
    #: The strategy's indicator direction rules, evaluated in a rule
    #: context. None when it has none.
    indicator: Callable[[], Direction | None] | None = None
    #: Stock universes by id, as loaded with the strategies.
    universes: Mapping[int, tuple[str, ...]] = field(default_factory=dict)

    def universe(self, universe_id: int) -> tuple[str, ...]:
        return self.universes.get(universe_id, ())

    def synthetic(self, kind: str) -> Decimal | None:
        quote = self.market.hub.latest(synthetic_id(kind, self.underlying))
        return quote.last_price.amount if quote is not None else None

    def synthetic_ago(self, kind: str, minutes: int) -> Decimal | None:
        if self.history is None:
            return None
        return self.history(synthetic_id(kind, self.underlying), minutes)

    def indicator_direction(self) -> Direction | None:
        return self.indicator() if self.indicator is not None else None

    @property
    def timezone(self) -> ZoneInfo:
        return self.market.timezone

    @property
    def calendar(self) -> TradingCalendar:
        return self.venue.calendar

    @property
    def market_close(self) -> time:
        windows = self.venue.calendar.windows_on(self.trading_day)
        if not windows:
            raise DomainError(f"{self.venue.code} has no session on {self.trading_day}")
        return windows[-1].end.astimezone(self.timezone).time()

    def spot(self, underlying: InstrumentId) -> Money | None:
        return self.market.spot_price(underlying, self.trading_day)

    def future_price(self, underlying: InstrumentId) -> Money | None:
        future = self.market.registry().near_month_future(underlying, self.trading_day)
        if future is None:
            return None
        quote = self.market.hub.latest(future.id)
        return quote.last_price if quote is not None else None

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        info = self._symbol(underlying)
        return info.strike_gap if info is not None else None

    def hedge_rounding(self, underlying: InstrumentId) -> Decimal | None:
        info = self._symbol(underlying)
        if info is None or info.hedge_strike_rounding <= 0:
            return None
        return info.hedge_strike_rounding

    def option_expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        return self.market.registry().option_expiry_for(underlying, kind, self.trading_day)

    def is_monthly_expiry_week(self, underlying: InstrumentId) -> bool:
        monthly = self.option_expiry(underlying, ExpiryKind.MONTHLY)
        if monthly is None:
            return False
        return monthly.isocalendar()[:2] == self.trading_day.isocalendar()[:2]

    def option(
        self, underlying: InstrumentId, expiry: date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None:
        listed = self.market.registry().option_at(underlying, expiry, strike, option_type)
        return listed.id if listed is not None else None

    def strikes(self, underlying: InstrumentId, expiry: date) -> list[Decimal]:
        return list(self.market.registry().strikes_for(underlying, expiry))

    def instrument(self, instrument: InstrumentId) -> Instrument | None:
        return self.market.registry().get(instrument)

    def quote(self, instrument: InstrumentId) -> Tick | None:
        return self.market.hub.latest(instrument)

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        if self.market.candles is None:
            return ()
        fetched: Sequence[Bar] = self.market.candles.get(instrument, interval, count)
        return fetched

    def near_future(self, underlying: InstrumentId) -> InstrumentId | None:
        future = self.market.registry().near_month_future(underlying, self.trading_day)
        return future.id if future is not None else None

    def straddle_max_diff(self, underlying: InstrumentId) -> Decimal | None:
        info = self._symbol(underlying)
        return info.straddle_max_premium_diff if info is not None else None

    def option_chain_levels(self, underlying: InstrumentId) -> int:
        info = self._symbol(underlying)
        return info.option_chain_levels if info is not None else 10

    def day_allocation_percent(self, strategy: str) -> int:
        del strategy
        return self.day_allocation.percentage_for(self.conditions)

    def event_day_percent(self, strategy: str, exchange: str) -> int:
        share = self.event_days.percentage_for(self.trading_day, exchange, strategy)
        return int(share.to_integral_value(rounding=ROUND_DOWN))

    def _symbol(self, underlying: InstrumentId) -> SymbolInfo | None:
        return self.market.symbols.get(underlying.value.split(":", 1)[-1])


def synthetic_id(kind: str, underlying: InstrumentId) -> InstrumentId:
    """Where a derived series for an underlying is published on the hub."""
    return InstrumentId(f"{SYNTHETIC}:{kind.upper()}-{underlying.value.split(':', 1)[-1]}")
