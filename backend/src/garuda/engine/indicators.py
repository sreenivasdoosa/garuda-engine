"""Indicators.

Pure functions of closed bars. No I/O, no clock, no state between calls — so
one is testable against a list of numbers, and two evaluations of the same
bars cannot disagree.

They are plug-ins like rules and selectors, registered by name and configured
by parameters, so `{"indicator": "RSI", "params": {"period": 14}}` builds one
and a new indicator changes nothing above it.

**Decimal throughout.** An indicator feeds a comparison that decides whether
money moves, and a float there would be the defect the whole engine is
arranged to prevent — invisible until two runs of the same day disagree in the
last place and one of them crosses a threshold.

Wilder's smoothing is used where Wilder defined the indicator (RSI, ATR),
because that is what every chart an operator compares against will be showing.
A simple mean over the same period gives a different number, and "my platform
says 62" is not a conversation worth having.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from itertools import pairwise
from typing import Protocol, runtime_checkable

from garuda.core.plugins import Registration, Registry
from garuda.domain.errors import DomainError
from garuda.domain.market import Bar

HUNDRED = Decimal(100)
TWO = Decimal(2)

#: How much history to ask for beyond an indicator's strict minimum. Wilder's
#: smoothing never quite forgets its seed, so a value computed from exactly
#: the minimum differs from the one a chart shows. Five times the period is
#: past the point where the difference is visible.
WARMUP = 5


@runtime_checkable
class Indicator(Protocol):
    """One indicator, configured."""

    @property
    def bars_needed(self) -> int:
        """How many closed bars to ask for. More than the strict minimum."""
        ...

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        """The value, or None when the history is too short."""
        ...


_INDICATORS: Registry[Indicator] = Registry("indicator")


def indicator(name: str) -> Callable[[type[Indicator]], type[Indicator]]:
    return _INDICATORS.register(name)


def build(name: str, **params: object) -> Indicator:
    """One indicator by name. Refuses a name or a parameter it does not know."""
    return _INDICATORS.build({"type": name.strip().lower(), **params})


def registered() -> Mapping[str, Registration]:
    return _INDICATORS.known()


def compute(name: str, bars: Sequence[Bar], **params: object) -> Decimal | None:
    """Build and evaluate in one go."""
    return build(name, **params).compute(bars)


# -- shapes -----------------------------------------------------------------


@dataclass(frozen=True)
class _Periodic:
    """An indicator over a fixed number of bars."""

    period: int = 14

    def __post_init__(self) -> None:
        if self.period < 1:
            raise DomainError(f"a period of {self.period} bars is not a period")

    @property
    def bars_needed(self) -> int:
        return self.period * WARMUP


def _closes(bars: Sequence[Bar]) -> list[Decimal]:
    return [bar.close.amount for bar in bars]


def _mean(values: Sequence[Decimal]) -> Decimal:
    return sum(values, Decimal(0)) / Decimal(len(values))


def _wilder(values: Sequence[Decimal], period: int) -> Decimal | None:
    """Wilder's smoothing: seed with a mean, then decay one period's worth.

    Not an exponential moving average with the same period — Wilder's uses
    1/n where an EMA uses 2/(n+1), and the two differ by enough to matter at a
    threshold.
    """
    if len(values) < period:
        return None
    smoothed = _mean(values[:period])
    span = Decimal(period)
    for value in values[period:]:
        smoothed = (smoothed * (span - 1) + value) / span
    return smoothed


def _true_ranges(bars: Sequence[Bar]) -> list[Decimal]:
    """True range, which is the first bar's range and then the gapped one."""
    ranges: list[Decimal] = []
    for index, bar in enumerate(bars):
        high, low = bar.high.amount, bar.low.amount
        if index == 0:
            ranges.append(high - low)
            continue
        previous = bars[index - 1].close.amount
        ranges.append(max(high - low, abs(high - previous), abs(low - previous)))
    return ranges


# -- the indicators ---------------------------------------------------------


class BarField(StrEnum):
    """Which price of a bar. The reference spells these upper case."""

    OPEN = "OPEN"
    HIGH = "HIGH"
    LOW = "LOW"
    CLOSE = "CLOSE"
    #: (high + low + close) / 3, which is what a pivot or a VWAP is built on.
    TYPICAL = "TYPICAL"

    def of(self, bar: Bar) -> Decimal:
        if self is BarField.OPEN:
            return bar.open.amount
        if self is BarField.HIGH:
            return bar.high.amount
        if self is BarField.LOW:
            return bar.low.amount
        if self is BarField.CLOSE:
            return bar.close.amount
        return (bar.high.amount + bar.low.amount + bar.close.amount) / Decimal(3)


@indicator("price")
@dataclass(frozen=True)
class BarPrice:
    """The price itself, so a rule can compare an indicator against it.

    Not an indicator, and registered as one on purpose: every real rule in the
    reference engine is one indicator against another, and "SuperTrend above
    the close" is the shape half of them take. Without a price to name on the
    other side of the comparison, that rule cannot be written at all -- and
    writing a `price_vs_indicator` rule instead would mean two rules, two sets
    of parameters and two places for the interval to disagree.

    The last **closed** bar, like every other indicator here. The forming bar
    is a guess that will change, and "close above the moving average" answered
    from a bar half way through its five minutes is the repainting bug.
    """

    field: BarField = BarField.CLOSE

    @property
    def bars_needed(self) -> int:
        return 1

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        return self.field.of(bars[-1]) if bars else None


@indicator("sma")
@dataclass(frozen=True)
class SimpleMovingAverage(_Periodic):
    """The mean close of the last n bars."""

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        closes = _closes(bars)
        if len(closes) < self.period:
            return None
        return _mean(closes[-self.period :])


@indicator("ema")
@dataclass(frozen=True)
class ExponentialMovingAverage(_Periodic):
    """Smoothed with 2/(n+1), seeded with the simple mean of the first n."""

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        closes = _closes(bars)
        if len(closes) < self.period:
            return None
        alpha = TWO / Decimal(self.period + 1)
        value = _mean(closes[: self.period])
        for close in closes[self.period :]:
            value = close * alpha + value * (1 - alpha)
        return value


@indicator("rsi")
@dataclass(frozen=True)
class RelativeStrength(_Periodic):
    """Wilder's relative strength index, 0 to 100."""

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        closes = _closes(bars)
        gains: list[Decimal] = []
        losses: list[Decimal] = []
        for previous, current in pairwise(closes):
            change = current - previous
            gains.append(max(change, Decimal(0)))
            losses.append(max(-change, Decimal(0)))

        average_gain = _wilder(gains, self.period)
        average_loss = _wilder(losses, self.period)
        if average_gain is None or average_loss is None:
            return None
        if average_loss == 0:
            # Nothing fell over the whole window. The ratio is undefined and
            # the index is at its ceiling, which is what a chart shows.
            return HUNDRED
        strength = average_gain / average_loss
        return HUNDRED - HUNDRED / (1 + strength)


@indicator("atr")
@dataclass(frozen=True)
class AverageTrueRange(_Periodic):
    """Wilder's average true range, in price."""

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        # The first bar has no previous close, so its range is not a true
        # range. Dropped rather than averaged in, where a quiet first bar
        # would understate the risk for the rest of the window.
        return _wilder(_true_ranges(bars)[1:], self.period)


@indicator("stddev")
@dataclass(frozen=True)
class StandardDeviation(_Periodic):
    """Population standard deviation of the last n closes."""

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        closes = _closes(bars)
        if len(closes) < self.period:
            return None
        window = closes[-self.period :]
        mean = _mean(window)
        variance = _mean([(close - mean) ** 2 for close in window])
        return variance.sqrt()


@indicator("vwap")
@dataclass(frozen=True)
class VolumeWeighted:
    """Volume-weighted average price over the bars given.

    Which bars those are is the caller's choice, and for the usual reading —
    the session's VWAP — they are the session's bars. A bar with no volume
    contributes nothing rather than being counted as one unit, because a feed
    that omits volume would otherwise turn this into an unweighted mean.
    """

    @property
    def bars_needed(self) -> int:
        return 0  # whatever the caller has

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        traded = Decimal(0)
        volume = Decimal(0)
        for bar in bars:
            if not bar.volume:
                continue
            quantity = Decimal(bar.volume)
            traded += bar.typical_price.amount * quantity
            volume += quantity
        if volume == 0:
            return None
        return traded / volume


@indicator("supertrend")
@dataclass(frozen=True)
class SuperTrend:
    """The Supertrend line, in price.

    Above the close when the trend is down and below it when up, which is what
    makes "close above Supertrend" a trend test. Its *direction* is a separate
    question and a separate rule; this answers the line.
    """

    period: int = 10
    multiplier: Decimal = Decimal(3)

    def __post_init__(self) -> None:
        if self.period < 1:
            raise DomainError(f"a period of {self.period} bars is not a period")
        if self.multiplier <= 0:
            raise DomainError(f"a multiplier of {self.multiplier} makes no band")

    @property
    def bars_needed(self) -> int:
        return self.period * WARMUP

    def compute(self, bars: Sequence[Bar]) -> Decimal | None:
        line = self.line(bars)
        return line[-1] if line else None

    def rising(self, bars: Sequence[Bar]) -> bool | None:
        """Whether the trend is up: the line sits below the close."""
        line = self.line(bars)
        if not line:
            return None
        return bars[-1].close.amount > line[-1]

    def line(self, bars: Sequence[Bar]) -> list[Decimal]:
        """The line at each bar it can be computed for, oldest first."""
        if len(bars) < self.period + 1:
            return []

        ranges = _true_ranges(bars)
        upper: Decimal | None = None
        lower: Decimal | None = None
        trend_up = True
        values: list[Decimal] = []
        smoothed: Decimal | None = None

        for index in range(1, len(bars)):
            window = ranges[1 : index + 1]
            if len(window) < self.period:
                continue
            smoothed = (
                _mean(window[: self.period])
                if smoothed is None
                else (smoothed * Decimal(self.period - 1) + ranges[index]) / Decimal(self.period)
            )

            bar = bars[index]
            middle = (bar.high.amount + bar.low.amount) / TWO
            band = self.multiplier * smoothed
            basic_upper, basic_lower = middle + band, middle - band
            previous_close = bars[index - 1].close.amount

            upper = (
                basic_upper
                if upper is None or basic_upper < upper or previous_close > upper
                else upper
            )
            lower = (
                basic_lower
                if lower is None or basic_lower > lower or previous_close < lower
                else lower
            )

            close = bar.close.amount
            if trend_up and close < lower:
                trend_up = False
            elif not trend_up and close > upper:
                trend_up = True
            values.append(lower if trend_up else upper)

        return values
