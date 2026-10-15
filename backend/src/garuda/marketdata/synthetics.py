"""Series the engine prices itself.

A rolling straddle, a put-call ratio, a synthetic future: nobody publishes
them, so market data computes them from the chain and publishes them as
ordinary ticks. Everything downstream then treats them as instruments, which
is the whole return on doing it this way — every price rule, and every rule
over a price, works on them for free.

**They are never traded.** `InstrumentKind.SYNTHETIC` and `is_tradable` keep
orders away; nothing can be bought at a rolling straddle's price.

**They carry their own day.** No broker has a synthetic's history, so the
opening value, the high and the low are tracked here and travel on the tick.
That is what makes "the rolling straddle is 10% below its open" answerable
without a candle store for something no candle store could fill.

**A rolling series steps.** When the underlying moves enough the straddle
rolls to a different strike, and the series jumps. Comparing this afternoon's
at-the-money straddle with this morning's is the intended meaning, but it is
not a path anything could have held, so each source records how it rolls.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol, runtime_checkable

from garuda.core.plugins import Registration, Registry
from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.domain.pricing import implied_volatility, years_to_expiry
from garuda.domain.strikes import atm_strike
from garuda.domain.symbol import SymbolInfo

logger = logging.getLogger(__name__)

#: The prefix every synthetic's id carries, so an instrument that cannot be
#: traded is recognisable at a glance in a log line.
SYNTHETIC = "SYNTH"


@runtime_checkable
class ChainView(Protocol):
    """What a synthetic may read: the chain, and what it is quoting."""

    def spot(self, underlying: InstrumentId) -> Money | None: ...

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None: ...

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None: ...

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None: ...

    def quote(self, instrument: InstrumentId) -> Tick | None: ...

    def today(self) -> date:
        """The trading day, for anything counting down to an expiry."""
        ...


@runtime_checkable
class Synthetic(Protocol):
    """One series the engine prices."""

    @property
    def underlying(self) -> InstrumentId: ...

    def instrument(self) -> InstrumentId:
        """What this series is called, as an instrument."""
        ...

    def price(self, view: ChainView) -> Money | None:
        """The value now, or None when the chain cannot answer."""
        ...


_SYNTHETICS: Registry[Synthetic] = Registry("synthetic", Synthetic)


def synthetic(name: str) -> Callable[[type[Synthetic]], type[Synthetic]]:
    return _SYNTHETICS.register(name)


def build(config: object) -> Synthetic:
    return _SYNTHETICS.build(config)


def registered() -> Mapping[str, Registration]:
    return _SYNTHETICS.known()


def _name(underlying: InstrumentId) -> str:
    return underlying.value.split(":", 1)[-1]


@dataclass(frozen=True)
class _OverTheChain:
    """Shared shape: a series computed from strikes around the money."""

    underlying: InstrumentId
    #: Strikes either side of the money to read.
    levels: int = 10
    expiry_kind: ExpiryKind = ExpiryKind.WEEKLY

    def __post_init__(self) -> None:
        if self.levels < 1:
            raise DomainError(f"{self.levels} strikes either side is not a chain")

    def _strikes(self, view: ChainView) -> tuple[date, list[Decimal]] | None:
        spot = view.spot(self.underlying)
        gap = view.strike_gap(self.underlying)
        expiry = view.expiry(self.underlying, self.expiry_kind)
        if spot is None or gap is None or expiry is None:
            return None
        middle = atm_strike(spot, gap)
        return expiry, [middle + step * gap for step in range(-self.levels, self.levels + 1)]


@synthetic("rolling_straddle")
@dataclass(frozen=True)
class RollingStraddle(_OverTheChain):
    """The cheapest call-and-put pair on the board.

    Not simply the nearest strike: the strike whose call and put together cost
    least *is* the market's at-the-money, and it can sit a strike away from the
    one nearest spot when the underlying has moved and the options have not
    caught up.

    **Rolls whenever that strike changes**, which is what makes the series
    step. Comparing this afternoon's value with this morning's compares two
    different pairs of contracts, deliberately.
    """

    #: How many strikes either side must be quoted before a value is published.
    #: A thin chain would otherwise offer a minimum that is only the minimum
    #: because its neighbours are missing.
    min_strikes_per_side: int = 2

    def instrument(self) -> InstrumentId:
        return InstrumentId(f"{SYNTHETIC}:STRADDLE-{_name(self.underlying)}")

    def price(self, view: ChainView) -> Money | None:
        found = self._strikes(view)
        if found is None:
            return None
        expiry, strikes = found

        middle = strikes[self.levels]
        cheapest: Money | None = None
        below = above = 0
        at_the_money = False

        for strike in strikes:
            pair = self._pair(view, expiry, strike)
            if pair is None:
                continue
            if strike < middle:
                below += 1
            elif strike > middle:
                above += 1
            else:
                at_the_money = True
            if cheapest is None or pair < cheapest:
                cheapest = pair

        if not at_the_money or below < self.min_strikes_per_side:
            return None
        if above < self.min_strikes_per_side:
            return None
        return cheapest

    def _pair(self, view: ChainView, expiry: date, strike: Decimal) -> Money | None:
        call = view.option(self.underlying, expiry, strike, OptionType.CALL)
        put = view.option(self.underlying, expiry, strike, OptionType.PUT)
        if call is None or put is None:
            return None
        call_tick = view.quote(call)
        put_tick = view.quote(put)
        if call_tick is None or put_tick is None:
            return None
        return call_tick.last_price + put_tick.last_price


@synthetic("put_call_ratio")
@dataclass(frozen=True)
class PutCallRatio(_OverTheChain):
    """Put open interest against call open interest, across the chain.

    Above one, more puts are held than calls. It is a ratio rather than a
    price, and is published as one anyway: an instrument is whatever has a
    number that moves, and a rule comparing it against 1.2 neither knows nor
    cares that the number is not rupees.
    """

    def instrument(self) -> InstrumentId:
        return InstrumentId(f"{SYNTHETIC}:PCR-{_name(self.underlying)}")

    def price(self, view: ChainView) -> Money | None:
        found = self._strikes(view)
        if found is None:
            return None
        expiry, strikes = found

        calls = puts = 0
        for strike in strikes:
            calls += self._interest(view, expiry, strike, OptionType.CALL)
            puts += self._interest(view, expiry, strike, OptionType.PUT)

        if calls == 0:
            # Undefined rather than infinite, and a chain with no call
            # interest at all is a chain nobody is quoting.
            return None
        return Money(Decimal(puts) / Decimal(calls), Currency.INR)

    def _interest(self, view: ChainView, expiry: date, strike: Decimal, side: OptionType) -> int:
        listed = view.option(self.underlying, expiry, strike, side)
        if listed is None:
            return 0
        quote = view.quote(listed)
        return quote.open_interest or 0 if quote is not None else 0


@synthetic("synthetic_future")
@dataclass(frozen=True)
class SyntheticFuture(_OverTheChain):
    """What the options imply the future is worth.

    Put-call parity at the money: strike plus call minus put. Against the
    actual future it is the basis, and against spot it is the cost of carry
    the option market is charging.
    """

    def instrument(self) -> InstrumentId:
        return InstrumentId(f"{SYNTHETIC}:SYNFUT-{_name(self.underlying)}")

    def price(self, view: ChainView) -> Money | None:
        found = self._strikes(view)
        if found is None:
            return None
        expiry, strikes = found
        middle = strikes[self.levels]

        call = view.option(self.underlying, expiry, middle, OptionType.CALL)
        put = view.option(self.underlying, expiry, middle, OptionType.PUT)
        if call is None or put is None:
            return None
        call_tick = view.quote(call)
        put_tick = view.quote(put)
        if call_tick is None or put_tick is None:
            return None
        currency = call_tick.last_price.currency
        return Money(middle, currency) + call_tick.last_price - put_tick.last_price


@dataclass(frozen=True)
class _AtTheMoney(_OverTheChain):
    """Shared shape: something read from the pair at the money."""

    #: The rate the model discounts at. A percentage point either way moves an
    #: implied volatility by far less than the bid-ask spread does, so this is
    #: a setting rather than a feed.
    rate: Decimal = Decimal("0.065")

    def _implied(self, view: ChainView, side: OptionType, today: date) -> Decimal | None:
        found = self._strikes(view)
        spot = view.spot(self.underlying)
        if found is None or spot is None:
            return None
        expiry, strikes = found
        middle = strikes[self.levels]

        listed = view.option(self.underlying, expiry, middle, side)
        if listed is None:
            return None
        quote = view.quote(listed)
        if quote is None:
            return None

        # On expiry day there is no time for the model to work with, and the
        # solver answers None for that — which is the whole reason not to
        # check it again here.
        days = Decimal((expiry - today).days)
        return implied_volatility(
            option_type=side,
            price=quote.last_price.amount,
            spot=spot.amount,
            strike=middle,
            years=years_to_expiry(days),
            rate=self.rate,
        )


@dataclass(frozen=True, slots=True)
class IVReading:
    """Both legs of an at-the-money implied volatility, taken together.

    The published :class:`ImpliedVolatility` tick carries the *average*,
    deliberately -- one number for a threshold to be written against. The
    stored series carries both sides, because that is what a volatility chart
    shows and what the reference service records.

    Both legs are required. The reference refuses the sample unless the solver
    answered for each, and a call IV stored beside an empty put is a chart with
    one line that silently changes meaning.

    Volatilities are percentages, as every screen shows them. The strikes and
    the spot are prices.
    """

    call: Decimal
    put: Decimal
    call_strike: Decimal
    put_strike: Decimal
    spot: Money


@synthetic("implied_volatility")
@dataclass(frozen=True)
class ImpliedVolatility(_AtTheMoney):
    """The volatility the at-the-money options imply, as a percentage.

    Averaged across the call and the put, because either alone carries the
    skew and this series is meant to carry the level. Published as a
    percentage rather than a fraction, which is how every screen shows it and
    therefore how a threshold will be configured.
    """

    def instrument(self) -> InstrumentId:
        return InstrumentId(f"{SYNTHETIC}:IV-{_name(self.underlying)}")

    def price(self, view: ChainView) -> Money | None:
        today = view.today()
        call = self._implied(view, OptionType.CALL, today)
        put = self._implied(view, OptionType.PUT, today)
        readable = [value for value in (call, put) if value is not None]
        if not readable:
            return None
        average = sum(readable, Decimal(0)) / Decimal(len(readable))
        return Money(average * Decimal(100), Currency.INR)

    def reading(self, view: ChainView) -> IVReading | None:
        """Both legs, their strikes and the spot -- what gets stored.

        None unless every part is there. Garuda reads both legs at the same
        at-the-money strike, so the two strikes agree today; they are recorded
        separately because the shape allows a future series that walks them
        apart, and because a stored strike is the only way to read an IV
        across a roll.
        """
        today = view.today()
        call = self._implied(view, OptionType.CALL, today)
        put = self._implied(view, OptionType.PUT, today)
        found = self._strikes(view)
        spot = view.spot(self.underlying)
        if call is None or put is None or found is None or spot is None:
            return None
        strike = found[1][self.levels]
        return IVReading(
            call=call * Decimal(100),
            put=put * Decimal(100),
            call_strike=strike,
            put_strike=strike,
            spot=spot,
        )


@synthetic("iv_skew")
@dataclass(frozen=True)
class ImpliedVolatilitySkew(_AtTheMoney):
    """Call volatility less put volatility, in percentage points.

    Positive when calls are dearer than puts for the same strike — the market
    paying up for upside. Negative is the usual state in an index, where puts
    carry a premium for protection, so a threshold is rarely zero.

    Both sides are required. A skew computed from one leg is not a skew.
    """

    def instrument(self) -> InstrumentId:
        return InstrumentId(f"{SYNTHETIC}:IVSKEW-{_name(self.underlying)}")

    def price(self, view: ChainView) -> Money | None:
        today = view.today()
        call = self._implied(view, OptionType.CALL, today)
        put = self._implied(view, OptionType.PUT, today)
        if call is None or put is None:
            return None
        return Money((call - put) * Decimal(100), Currency.INR)


# -- publishing -------------------------------------------------------------


@dataclass
class _Session:
    """A synthetic's day, which nothing else records."""

    day: date
    open: Money
    high: Money
    low: Money

    def seen(self, price: Money) -> None:
        self.high = max(self.high, price)
        self.low = min(self.low, price)


@dataclass
class SyntheticPublisher:
    """Prices the declared synthetics and publishes them as ticks."""

    sources: tuple[Synthetic, ...] = ()
    _days: dict[InstrumentId, _Session] = field(default_factory=dict)

    def ticks(self, view: ChainView, now: datetime) -> list[Tick]:
        """One tick per synthetic that can be priced right now.

        A synthetic the chain cannot answer for produces nothing rather than a
        stale repeat: a series that stops moving because its inputs went away
        is indistinguishable from a quiet market, and one of those is a fault.
        """
        produced: list[Tick] = []
        for source in self.sources:
            price = self._priced(source, view)
            if price is None:
                continue
            instrument = source.instrument()
            session = self._day(instrument, price, now.date())
            session.seen(price)
            produced.append(
                Tick(
                    instrument=instrument,
                    last_price=price,
                    timestamp=now,
                    open=session.open,
                    high=session.high,
                    low=session.low,
                    is_synthetic=True,
                )
            )
        return produced

    def _priced(self, source: Synthetic, view: ChainView) -> Money | None:
        try:
            return source.price(view)
        except Exception:
            logger.exception("could not price %s", type(source).__name__)
            return None

    def _day(self, instrument: InstrumentId, price: Money, today: date) -> _Session:
        session = self._days.get(instrument)
        if session is None or session.day != today:
            session = _Session(day=today, open=price, high=price, low=price)
            self._days[instrument] = session
        return session

    def forget_day(self) -> None:
        """Start the opening values again. Run at day-init."""
        self._days.clear()


def for_symbol(
    underlying: InstrumentId, info: SymbolInfo, *, levels: int = 10
) -> tuple[Synthetic, ...]:
    """The series this underlying is configured to price.

    Each flag is a row an operator edits, not a global: every one of these
    walks the option chain on each tick, so running all five for every listed
    underlying is most of a core spent on series nobody reads. The reference
    service ran them for a handful of indices, and that is the shape.

    The skew rides on the IV flag rather than having one of its own. It is
    read off the same two at-the-money options IV already fetched, so once IV
    is on it is nearly free -- and a skew without an IV to read it beside is
    not a chart anyone asked for.
    """
    sources: list[Synthetic] = []
    # The expiry this underlying actually lists. A commodity has no weekly
    # options, so a series built for a weekly expiry finds no chain and prices
    # to nothing -- with no error, because an unpriceable straddle and a quiet
    # one are the same thing from here.
    kind = info.option_expiry_kind
    if info.derives_straddle:
        sources.append(RollingStraddle(underlying=underlying, levels=levels, expiry_kind=kind))
    if info.derives_pcr:
        sources.append(
            PutCallRatio(
                underlying=underlying,
                levels=info.pcr_strikes_each_side or levels,
                expiry_kind=kind,
            )
        )
    if info.derives_synthetic:
        sources.append(SyntheticFuture(underlying=underlying, levels=levels, expiry_kind=kind))
    if info.derives_iv:
        sources.append(ImpliedVolatility(underlying=underlying, levels=levels, expiry_kind=kind))
        sources.append(
            ImpliedVolatilitySkew(underlying=underlying, levels=levels, expiry_kind=kind)
        )
    return tuple(sources)


def for_symbols(
    symbols: Mapping[InstrumentId, SymbolInfo], *, levels: int = 10
) -> tuple[Synthetic, ...]:
    """Every configured series, across every curated underlying.

    Underlyings with nothing switched on contribute nothing, so an install that
    has not asked for any of this pays for none of it.
    """
    return tuple(
        source
        for underlying, info in symbols.items()
        for source in for_symbol(underlying, info, levels=levels)
    )
