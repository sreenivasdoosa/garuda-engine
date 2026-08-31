"""Direction from candles.

The reference engine's candle provider is one general shape rather than a
class per idea, and this keeps that. A comparison of two things, each of which
is either the price now or a candle picked by *when*:

    gap up          yesterday's open   against   the day before's close
    above yesterday the price now      against   yesterday's close
    above the open  the price now      against   today's open

All three are this rule with different references, which is why there is not
one class each.

**Day offsets count trading days, and the candles themselves say which those
are.** A holiday produces no candle, so counting back through the distinct
days present skips it without anyone consulting a calendar — and cannot
disagree with one.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, time
from enum import StrEnum

from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.domain.money import Money
from garuda.engine.direction.registry import direction
from garuda.engine.rules.context import RuleContext

#: How far back a reference may reach. A month of trading days is more than
#: any configured strategy looks, and the history behind it is what the cache
#: fetches.
MAX_DAYS_BACK = 25


class PriceType(StrEnum):
    OPEN = "OPEN"
    HIGH = "HIGH"
    LOW = "LOW"
    CLOSE = "CLOSE"

    def of(self, bar: Bar) -> Money:
        return {
            PriceType.OPEN: bar.open,
            PriceType.HIGH: bar.high,
            PriceType.LOW: bar.low,
            PriceType.CLOSE: bar.close,
        }[self]


class ReferenceTime(StrEnum):
    """Which candle a reference means.

    Two, not four. The reference engine names ``MARKET_OPEN`` and
    ``MARKET_CLOSE`` alongside a separate price type, which leaves a field
    that is sometimes ignored — the kind an operator sets and then wonders
    about. Here the day's open is ``DAY`` with ``price: OPEN``, and the day's
    high is the same reference with ``price: HIGH``, which the other spelling
    could not express at all.
    """

    #: The day candle at the offset, whichever of its prices is asked for.
    DAY = "DAY"
    #: A one-minute candle at a wall-clock time on that day.
    AT = "AT"


class Compare(StrEnum):
    PRICE_VS_REFERENCE = "PRICE_VS_REF"
    REFERENCE_VS_REFERENCE = "REF_VS_REF"


class LongWhen(StrEnum):
    """Which side of the comparison means long."""

    GREATER = "GREATER"
    LESS = "LESS"


@dataclass(frozen=True)
class CandleReference:
    """One value to compare against."""

    when: ReferenceTime = ReferenceTime.DAY
    #: Trading days back. 0 is today, -1 the previous trading day.
    day_offset: int = 0
    price: PriceType = PriceType.CLOSE
    #: The wall-clock time, for ``AT``.
    at: time | None = None

    def __post_init__(self) -> None:
        if self.day_offset > 0:
            raise DomainError(f"a reference {self.day_offset} days ahead is not history")
        if -self.day_offset > MAX_DAYS_BACK:
            raise DomainError(
                f"a reference {-self.day_offset} trading days back is further than "
                f"the {MAX_DAYS_BACK} days of history kept"
            )
        if self.when is ReferenceTime.AT and self.at is None:
            raise DomainError("a reference at a particular time must say which time")

    def resolve(self, context: RuleContext, instrument: InstrumentId) -> Money | None:
        """The value, or None when the history does not reach that far."""
        if self.when is ReferenceTime.AT:
            return self._at_a_time(context, instrument)
        return self._from_the_day(context, instrument)

    def _from_the_day(self, context: RuleContext, instrument: InstrumentId) -> Money | None:
        bars = context.candles(instrument, BarInterval.ONE_DAY, MAX_DAYS_BACK + 1)
        chosen = _nth_day_back(bars, -self.day_offset)
        if chosen is None:
            return None
        return self.price.of(chosen)

    def _at_a_time(self, context: RuleContext, instrument: InstrumentId) -> Money | None:
        bars = context.candles(instrument, BarInterval.ONE_MINUTE, MAX_DAYS_BACK * _MINUTES_A_DAY)
        wanted_day = _day_back(bars, -self.day_offset, context)
        if wanted_day is None or self.at is None:
            return None
        for bar in reversed(bars):
            local = bar.start.astimezone(context.timezone)
            if local.date() == wanted_day and local.time() == self.at:
                return self.price.of(bar)
        return None


#: Enough one-minute candles to cover a long session, so a day offset reaches
#: back through them.
_MINUTES_A_DAY = 900


@direction("candle")
@dataclass(frozen=True)
class CandleDirection:
    """Which way, from a comparison of candles."""

    mode: Compare = Compare.PRICE_VS_REFERENCE
    reference: CandleReference = field(default_factory=CandleReference)
    #: The second reference, for a comparison of two.
    other: CandleReference | None = None
    long_when: LongWhen = LongWhen.GREATER
    instrument: InstrumentId | None = None

    def __post_init__(self) -> None:
        if self.mode is Compare.REFERENCE_VS_REFERENCE and self.other is None:
            raise DomainError("a comparison of two references needs a second one")

    def resolve(self, context: RuleContext) -> Direction | None:
        subject = self.instrument or context.underlying

        right = self.reference.resolve(context, subject)
        if right is None:
            return None

        left = self._left(context, subject)
        if left is None:
            return None

        higher = left.amount > right.amount
        wants_higher = self.long_when is LongWhen.GREATER
        return Direction.LONG if higher is wants_higher else Direction.SHORT

    def _left(self, context: RuleContext, subject: InstrumentId) -> Money | None:
        if self.mode is Compare.REFERENCE_VS_REFERENCE:
            assert self.other is not None
            return self.other.resolve(context, subject)
        quote = context.quote(subject)
        return quote.last_price if quote is not None else None


@direction("n_bars_breakout")
@dataclass(frozen=True)
class NBarsBreakout:
    """Long on breaking the last n bars' high, short on breaking their low.

    The most recent closed bar decides, and the n before it set the range.
    Inside the range there is no opinion, which is the point: a breakout
    provider that guesses when nothing has broken is not a breakout provider.
    """

    bars: int = 5
    interval: BarInterval = BarInterval.ONE_DAY
    instrument: InstrumentId | None = None

    def __post_init__(self) -> None:
        if self.bars < 1:
            raise DomainError(f"a breakout of {self.bars} bars has no range to break")

    def resolve(self, context: RuleContext) -> Direction | None:
        subject = self.instrument or context.underlying
        history = context.candles(subject, self.interval, self.bars + 1)
        if len(history) < self.bars + 1:
            return None

        latest, before = history[-1], history[:-1]
        if latest.close > max(bar.high for bar in before):
            return Direction.LONG
        if latest.close < min(bar.low for bar in before):
            return Direction.SHORT
        return None


def _nth_day_back(bars: Sequence[Bar], back: int) -> Bar | None:
    """The day bar ``back`` trading days ago, counting the last as zero."""
    if back >= len(bars):
        return None
    return bars[-1 - back]


def _day_back(bars: Sequence[Bar], back: int, context: RuleContext) -> date | None:
    """Which calendar date is ``back`` trading days before the latest.

    Taken from the days the candles actually cover, so a holiday is skipped
    without consulting a calendar and cannot disagree with one.
    """
    days: list[date] = []
    for bar in bars:
        day = bar.start.astimezone(context.timezone).date()
        if not days or days[-1] != day:
            days.append(day)
    if back >= len(days):
        return None
    return days[-1 - back]
