"""Direction providers: which way a directional strategy trades.

`STRATEGY_ENGINE.md` §4 step 3. A provider answers LONG, SHORT, BOTH or
declines; "LONG" always means *bullish*, and what that trades is the leg
shape's business (`OPTION_SELLING` sells the put on a bullish answer). A
definition names one provider by `direction_provider_type` and configures it
with `direction_provider_params`; the reference's `applicableDirection`
param then suppresses the side the operator does not want.

Providers are a registry, so adding one is a registration: a function from
its params to an object with ``decide``. Unknown names are refused at load,
by name.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, tzinfo
from decimal import Decimal
from enum import StrEnum
from typing import Any, Protocol

from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.engine.ranges import RangeSpec
from garuda.engine.ranges import resolve as resolve_range


class Side(StrEnum):
    """A provider's answer."""

    LONG = "LONG"
    SHORT = "SHORT"
    #: Both sides at once: a non-directional pair, or a provider that sees no
    #: reason to prefer either.
    BOTH = "BOTH"


@dataclass(frozen=True, slots=True)
class Answer:
    side: Side | None
    because: str
    #: State the provider wants kept for its next call, under its own
    #: namespace. None leaves what it had.
    remember: Mapping[str, Any] | None = None

    @classmethod
    def declined(cls, because: str) -> Answer:
        return cls(None, because)


class DirectionContext(Protocol):
    """What a provider may consult. The strategy environment implements it."""

    @property
    def memory(self) -> Mapping[str, Any]: ...
    @property
    def now(self) -> datetime: ...
    @property
    def trading_day(self) -> date: ...
    @property
    def timezone(self) -> tzinfo: ...
    @property
    def underlying(self) -> InstrumentId: ...

    def spot(self, underlying: InstrumentId) -> Money | None: ...
    def quote(self, instrument: InstrumentId) -> Tick | None: ...
    def candles(
        self, instrument: InstrumentId, interval: BarInterval, count: int
    ) -> Sequence[Bar]: ...
    def synthetic(self, kind: str) -> Decimal | None:
        """The latest value of one of the underlying's derived series --
        ``PCR``, ``IV``, ``IVSKEW`` -- or None when it is not priced."""
        ...

    def synthetic_ago(self, kind: str, minutes: int) -> Decimal | None:
        """The same series as it stood ``minutes`` ago, or None."""
        ...

    def indicator_direction(self) -> Direction | None:
        """What the strategy's indicator direction rules say: LONG rules
        first, then SHORT. None when neither holds or none is configured."""
        ...


class DirectionProvider(Protocol):
    def decide(self, context: DirectionContext) -> Answer: ...


type ProviderFactory = Callable[[Mapping[str, Any]], DirectionProvider]

_PROVIDERS: dict[str, ProviderFactory] = {}


def provider(name: str) -> Callable[[ProviderFactory], ProviderFactory]:
    """Register a provider under the name a definition stores."""

    def register(factory: ProviderFactory) -> ProviderFactory:
        key = name.strip().upper()
        if key in _PROVIDERS:
            raise DomainError(f"direction provider {key} is registered twice")
        _PROVIDERS[key] = factory
        return factory

    return register


def registered() -> tuple[str, ...]:
    return tuple(sorted(_PROVIDERS))


def build(name: str, params: Mapping[str, Any]) -> DirectionProvider:
    key = (name or "").strip().upper()
    factory = _PROVIDERS.get(key)
    if factory is None:
        raise DomainError(
            f"direction provider {name!r} is not one of {', '.join(registered()) or 'none'}"
        )
    try:
        return factory(params)
    except DomainError:
        raise
    except (TypeError, ValueError, KeyError) as error:
        raise DomainError(f"direction provider {key}: {error}") from None


def applicable(side: Side | None, params: Mapping[str, Any], *, provider_name: str) -> Side | None:
    """The reference's `applyApplicableDirectionFilter`.

    ``applicableDirection`` of LONG or SHORT suppresses the other side; BOTH
    or absent lets either through. FIXED is never filtered: the operator
    already said which way.
    """
    if side is None or provider_name.strip().upper() == "FIXED":
        return side
    wanted = str(params.get("applicableDirection") or "BOTH").strip().upper()
    if wanted in ("", "BOTH"):
        return side
    if wanted not in ("LONG", "SHORT"):
        raise DomainError(f"applicableDirection {wanted!r} is not LONG, SHORT or BOTH")
    if side is Side.BOTH:
        return Side(wanted)
    return side if side.value == wanted else None


@provider("FIXED")
def _fixed(params: Mapping[str, Any]) -> DirectionProvider:
    return FixedProvider.of(params)


@dataclass(frozen=True, slots=True)
class FixedProvider:
    """Always the configured way. NONE, blank or anything else means no trade,
    as the reference reads it."""

    side: Side | None

    @classmethod
    def of(cls, params: Mapping[str, Any]) -> FixedProvider:
        named = str(params.get("direction") or "").strip().upper()
        return cls(Side(named) if named in ("LONG", "SHORT") else None)

    def decide(self, context: DirectionContext) -> Answer:
        del context
        if self.side is None:
            return Answer.declined("FIXED provider has no direction configured")
        return Answer(self.side, f"FIXED {self.side.value}")


# -- the reference's providers ------------------------------------------------


def _side(value: object, default: Side) -> Side:
    text = str(value or "").strip().upper()
    if text in ("LONG", "SHORT"):
        return Side(text)
    return default


def _int(params: Mapping[str, Any], name: str, default: int) -> int:
    value = params.get(name)
    if value in (None, ""):
        return default
    return int(str(value))


def _decimal(params: Mapping[str, Any], name: str, default: Decimal) -> Decimal:
    value = params.get(name)
    if value in (None, ""):
        return default
    return Decimal(str(value))


_INTERVALS = {
    1: BarInterval.ONE_MINUTE,
    3: BarInterval.THREE_MINUTES,
    5: BarInterval.FIVE_MINUTES,
    15: BarInterval.FIFTEEN_MINUTES,
    30: BarInterval.THIRTY_MINUTES,
    60: BarInterval.ONE_HOUR,
}


def _interval(minutes: int) -> BarInterval:
    interval = _INTERVALS.get(minutes)
    if interval is None:
        raise DomainError(f"timeframeMinutes {minutes} is not one of {sorted(_INTERVALS)}")
    return interval


@provider("INDICATOR")
def _indicator(params: Mapping[str, Any]) -> DirectionProvider:
    del params
    return IndicatorProvider()


@dataclass(frozen=True, slots=True)
class IndicatorProvider:
    """The strategy's indicator direction rules: LONG rules first, then SHORT,
    no match declines -- the reference's `IndicatorDirectionProvider`."""

    def decide(self, context: DirectionContext) -> Answer:
        direction = context.indicator_direction()
        if direction is None:
            return Answer.declined("neither the long nor the short rules hold")
        return Answer(Side(direction.value), f"indicator rules say {direction.value}")


@provider("N_BARS_BREAKOUT")
def _n_bars(params: Mapping[str, Any]) -> DirectionProvider:
    return NBarsBreakoutProvider(
        interval=_interval(_int(params, "timeframeMinutes", 15)),
        lookback=_int(params, "lookbackBars", 20),
        on_high=_side(params.get("onHighBreak"), Side.LONG),
        on_low=_side(params.get("onLowBreak"), Side.SHORT),
    )


@dataclass(frozen=True, slots=True)
class NBarsBreakoutProvider:
    """The last closed bar's close against the high and low of the
    ``lookback`` bars before it."""

    interval: BarInterval
    lookback: int
    on_high: Side = Side.LONG
    on_low: Side = Side.SHORT

    def decide(self, context: DirectionContext) -> Answer:
        if self.lookback < 1:
            return Answer.declined("lookbackBars must be at least 1")
        bars = list(context.candles(context.underlying, self.interval, self.lookback + 1))
        if len(bars) < self.lookback + 1:
            return Answer.declined(
                f"need {self.lookback + 1} {self.interval.value} bars, have {len(bars)}"
            )
        current, prior = bars[-1], bars[-self.lookback - 1 : -1]
        high = max(bar.high.amount for bar in prior)
        low = min(bar.low.amount for bar in prior)
        close = current.close.amount
        if close > high:
            return Answer(self.on_high, f"close {close} broke the {self.lookback}-bar high {high}")
        if close < low:
            return Answer(self.on_low, f"close {close} broke the {self.lookback}-bar low {low}")
        return Answer.declined(f"close {close} inside [{low}, {high}]")


@provider("ORB_BREAKOUT")
def _orb(params: Mapping[str, Any]) -> DirectionProvider:
    return OrbBreakoutProvider(
        spec=RangeSpec.from_params(params),
        on_high=_side(params.get("onHighBreak"), Side.LONG),
        on_low=_side(params.get("onLowBreak"), Side.SHORT),
    )


@dataclass(frozen=True, slots=True)
class OrbBreakoutProvider:
    """The live price against a frozen band."""

    spec: RangeSpec
    on_high: Side = Side.LONG
    on_low: Side = Side.SHORT

    def decide(self, context: DirectionContext) -> Answer:
        band = resolve_range(
            self.spec,
            now=context.now,
            timezone=context.timezone,
            today=context.trading_day,
            minute_bars=context.candles(context.underlying, BarInterval.ONE_MINUTE, 400),
            day_bars=context.candles(
                context.underlying, BarInterval.ONE_DAY, self.spec.lookback + 2
            ),
        )
        if isinstance(band, str):
            return Answer.declined(band)
        price = context.spot(context.underlying)
        if price is None:
            return Answer.declined("no live price")
        if price.amount > band.high:
            return Answer(self.on_high, f"{price.amount} above the range high {band.high}")
        if price.amount < band.low:
            return Answer(self.on_low, f"{price.amount} below the range low {band.low}")
        return Answer.declined(f"{price.amount} inside [{band.low}, {band.high}]")


@provider("PCR")
def _pcr(params: Mapping[str, Any]) -> DirectionProvider:
    mode = str(params.get("comparisonMode") or "THRESHOLD").strip().upper()
    if mode not in ("THRESHOLD", "TREND"):
        raise DomainError(f"PCR comparisonMode {mode!r} is not THRESHOLD or TREND")
    when = str(params.get("longWhen") or "INCREASING").strip().upper()
    if when not in ("INCREASING", "DECREASING"):
        raise DomainError(f"PCR longWhen {when!r} is not INCREASING or DECREASING")
    return PcrProvider(
        trend=mode == "TREND",
        threshold=_decimal(params, "threshold", Decimal(1)),
        lookback=_int(params, "lookbackMinutes", 15),
        long_when_increasing=when == "INCREASING",
    )


@dataclass(frozen=True, slots=True)
class PcrProvider:
    """THRESHOLD: a put-call ratio below the threshold is bearish, at or above
    it bullish. TREND: the ratio now against ``lookback`` minutes ago."""

    trend: bool = False
    threshold: Decimal = Decimal(1)
    lookback: int = 15
    long_when_increasing: bool = True

    def decide(self, context: DirectionContext) -> Answer:
        now = context.synthetic("PCR")
        if now is None:
            return Answer.declined("the put-call ratio is not priced")
        if not self.trend:
            if now < self.threshold:
                return Answer(Side.SHORT, f"PCR {now} below {self.threshold}")
            return Answer(Side.LONG, f"PCR {now} at or above {self.threshold}")
        then = context.synthetic_ago("PCR", self.lookback)
        if then is None:
            return Answer.declined(f"no PCR from {self.lookback} minutes ago")
        if now == then:
            return Answer.declined(f"PCR unchanged at {now}")
        rising = now > then
        side = Side.LONG if rising == self.long_when_increasing else Side.SHORT
        return Answer(side, f"PCR {'rose' if rising else 'fell'} from {then} to {now}")


@provider("IV_SKEW")
def _iv_skew(params: Mapping[str, Any]) -> DirectionProvider:
    return IvSkewProvider(default=_side(params.get("defaultDirection"), Side.LONG))


@dataclass(frozen=True, slots=True)
class IvSkewProvider:
    """Call volatility above put volatility is bearish, below bullish, equal
    takes the default."""

    default: Side = Side.LONG

    def decide(self, context: DirectionContext) -> Answer:
        skew = context.synthetic("IVSKEW")
        if skew is None:
            return Answer.declined("the volatility skew is not priced")
        if skew > 0:
            return Answer(Side.SHORT, f"call IV above put IV by {skew}")
        if skew < 0:
            return Answer(Side.LONG, f"put IV above call IV by {-skew}")
        return Answer(self.default, "no skew")


@provider("CANDLE")
def _candle(params: Mapping[str, Any]) -> DirectionProvider:
    mode = str(params.get("comparisonMode") or "CMP_VS_REF").strip().upper()
    if mode not in ("CMP_VS_REF", "REF_VS_REF"):
        raise DomainError(f"CANDLE comparisonMode {mode!r} is not CMP_VS_REF or REF_VS_REF")
    reference = str(params.get("referenceSymbol") or "").strip() or None
    exchange = str(params.get("referenceExchange") or "").strip() or None
    if mode == "CMP_VS_REF":
        first = CandleReference.of(params, "ref", "MARKET_CLOSE", -1)
        second = None
    else:
        first = CandleReference.of(params, "ref1", "MARKET_OPEN", -1)
        second = CandleReference.of(params, "ref2", "MARKET_CLOSE", -2)
    return CandleProvider(
        first=first,
        second=second,
        long_when_greater=str(params.get("longWhen") or "GREATER").strip().upper() != "LESS",
        neutral_band=_decimal(params, "neutralBandPercent", Decimal(0)),
        reference=(
            InstrumentId(f"{exchange}:{reference}")
            if reference and exchange
            else (InstrumentId(reference) if reference and ":" in reference else None)
        ),
    )


@dataclass(frozen=True, slots=True)
class CandleReference:
    """A price at a time on a session: MARKET_OPEN, MARKET_CLOSE or HH:MM, on
    the session ``day_offset`` back (0 today, -1 the last completed), taking
    the bar's OPEN, HIGH, LOW or CLOSE for a clock time."""

    time: str
    day_offset: int
    price_type: str = "CLOSE"

    @classmethod
    def of(
        cls, params: Mapping[str, Any], prefix: str, time_default: str, day_default: int
    ) -> CandleReference:
        price_type = str(params.get(f"{prefix}PriceType") or "CLOSE").strip().upper()
        if price_type not in ("OPEN", "HIGH", "LOW", "CLOSE"):
            raise DomainError(f"{prefix}PriceType {price_type!r} is not OPEN, HIGH, LOW or CLOSE")
        return cls(
            time=str(params.get(f"{prefix}Time") or time_default).strip().upper(),
            day_offset=_int(params, f"{prefix}DayOffset", day_default),
            price_type=price_type,
        )

    def price(self, context: DirectionContext, instrument: InstrumentId) -> Decimal | None:
        if self.day_offset > 0:
            return None
        if self.time in ("MARKET_OPEN", "MARKET_CLOSE"):
            if self.day_offset == 0:
                tick = context.quote(instrument)
                if tick is None:
                    return None
                if self.time == "MARKET_OPEN":
                    return tick.open.amount if tick.open is not None else None
                return tick.last_price.amount
            days = [
                bar
                for bar in context.candles(instrument, BarInterval.ONE_DAY, -self.day_offset + 2)
                if bar.start.astimezone(context.timezone).date() < context.trading_day
            ]
            if len(days) < -self.day_offset:
                return None
            bar = days[self.day_offset]
            return (bar.open if self.time == "MARKET_OPEN" else bar.close).amount
        try:
            at = time.fromisoformat(self.time)
        except ValueError:
            raise DomainError(
                f"reference time {self.time!r} is not MARKET_OPEN, MARKET_CLOSE or HH:MM"
            ) from None
        sessions_back = -self.day_offset
        minutes = context.candles(instrument, BarInterval.ONE_MINUTE, 400 * (sessions_back + 1))
        dates = sorted({bar.start.astimezone(context.timezone).date() for bar in minutes})
        if context.trading_day in dates:
            dates.remove(context.trading_day)
        target_day = (
            context.trading_day
            if sessions_back == 0
            else (dates[-sessions_back] if len(dates) >= sessions_back else None)
        )
        if target_day is None:
            return None
        for bar in minutes:
            local = bar.start.astimezone(context.timezone)
            if local.date() == target_day and local.time().replace(second=0) == at.replace(
                second=0
            ):
                return {
                    "OPEN": bar.open,
                    "HIGH": bar.high,
                    "LOW": bar.low,
                    "CLOSE": bar.close,
                }[self.price_type].amount
        return None


@dataclass(frozen=True, slots=True)
class CandleProvider:
    """CMP_VS_REF: the live price against a reference price. REF_VS_REF: one
    reference against another. LONG when the first is greater, or less with
    ``longWhen`` LESS; a gap inside the neutral band declines."""

    first: CandleReference
    second: CandleReference | None
    long_when_greater: bool = True
    neutral_band: Decimal = Decimal(0)
    reference: InstrumentId | None = None

    def decide(self, context: DirectionContext) -> Answer:
        instrument = self.reference or context.underlying
        if self.second is None:
            live = context.spot(instrument) if self.reference is None else None
            if live is None:
                tick = context.quote(instrument)
                live = tick.last_price if tick is not None else None
            if live is None:
                return Answer.declined("no live price")
            a: Decimal | None = live.amount
            b = self.first.price(context, instrument)
        else:
            a = self.first.price(context, instrument)
            b = self.second.price(context, instrument)
        if a is None or b is None or b <= 0:
            return Answer.declined("a reference price is not available")
        if self.neutral_band > 0 and abs(a - b) / b * 100 < self.neutral_band:
            return Answer.declined(f"{a} vs {b} is inside the {self.neutral_band}% neutral band")
        # The reference's own asymmetry: CMP_VS_REF is strictly greater,
        # REF_VS_REF greater-or-equal.
        greater = a > b if self.second is None else a >= b
        bullish = greater if self.long_when_greater else a < b
        side = Side.LONG if bullish else Side.SHORT
        return Answer(side, f"{a} vs {b}")


__all__ = [
    "Answer",
    "DirectionContext",
    "DirectionProvider",
    "Side",
    "applicable",
    "build",
    "provider",
    "registered",
]
