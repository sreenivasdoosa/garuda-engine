"""Rules about a price.

These work on a synthetic instrument exactly as they work on a tradable one,
which is the point of publishing rolling straddles, implied volatility and
put-call ratios as instruments: "the rolling straddle is 10% below its open"
is the same rule as "spot is 1% below its open", with a different subject.

**History comes from candles, the present from the tick.** A rule comparing
against the day's open reads the first bar; a rule asking where the price is
now reads the latest tick. The comparison is satisfied the moment the tick
crosses, not at the end of the minute in which it crossed.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.domain.money import Money
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed, unavailable
from garuda.engine.rules.registry import Cost, rule

HUNDRED = Decimal(100)

#: How many one-minute bars back the day's first is looked for. A session is
#: shorter than this everywhere the engine trades, and asking for more costs a
#: larger read for no gain.
DAY_LOOKBACK_BARS = 1500


class Reference(StrEnum):
    """What a price is being compared against."""

    DAY_OPEN = "day_open"
    PREVIOUS_CLOSE = "previous_close"
    DAY_HIGH = "day_high"
    DAY_LOW = "day_low"


def _subject(rule_instrument: InstrumentId | None, context: RuleContext) -> InstrumentId:
    """A rule with no instrument of its own is about the underlying."""
    return rule_instrument or context.underlying


def _now(context: RuleContext, instrument: InstrumentId) -> Money | None:
    quote = context.quote(instrument)
    return quote.last_price if quote is not None else None


@rule("price_above", cost=Cost.CHEAP)
@dataclass(frozen=True)
class PriceAbove:
    """The latest price is above a level."""

    value: Decimal
    instrument: InstrumentId | None = None

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = _subject(self.instrument, context)
        price = _now(context, subject)
        if price is None:
            return unavailable(f"{subject} has no price")
        if price.amount > self.value:
            return passed(f"{subject} at {price.amount} is above {self.value}")
        return failed(f"{subject} at {price.amount} is not above {self.value}")


@rule("price_below", cost=Cost.CHEAP)
@dataclass(frozen=True)
class PriceBelow:
    """The latest price is below a level.

    This is the volatility rule, among others: an index of volatility is an
    instrument, so "VIX below 14" needs nothing of its own.
    """

    value: Decimal
    instrument: InstrumentId | None = None

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = _subject(self.instrument, context)
        price = _now(context, subject)
        if price is None:
            return unavailable(f"{subject} has no price")
        if price.amount < self.value:
            return passed(f"{subject} at {price.amount} is below {self.value}")
        return failed(f"{subject} at {price.amount} is not below {self.value}")


@rule("percent_from_reference", cost=Cost.CHEAP)
@dataclass(frozen=True)
class PercentFromReference:
    """The latest price has moved a given percentage from a reference.

    A negative percentage means below the reference and a positive one above,
    so "the rolling straddle is 10% below its open" is ``percent: -10``. The
    comparison is *at or beyond*: a move further than asked for still counts.
    """

    percent: Decimal
    reference: Reference = Reference.DAY_OPEN
    instrument: InstrumentId | None = None

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = _subject(self.instrument, context)
        price = _now(context, subject)
        if price is None:
            return unavailable(f"{subject} has no price")

        anchor = self._anchor(context, subject)
        if anchor is None:
            return unavailable(f"{subject} has no {self.reference.value} to measure from")
        if anchor.amount == 0:
            return unavailable(
                f"{subject}'s {self.reference.value} is zero, so a percentage of it is not a move"
            )

        moved = (price.amount - anchor.amount) / anchor.amount * HUNDRED
        reached = moved <= self.percent if self.percent < 0 else moved >= self.percent
        detail = {"price": price.amount, "reference": anchor.amount, "moved_percent": moved}
        if reached:
            return passed(
                f"{subject} at {price.amount} is {moved:.2f}% from its "
                f"{self.reference.value} of {anchor.amount}",
                **detail,
            )
        return failed(
            f"{subject} has moved {moved:.2f}% from its {self.reference.value}, "
            f"not {self.percent}%",
            **detail,
        )

    def _anchor(self, context: RuleContext, subject: InstrumentId) -> Money | None:
        """The value being measured from.

        Taken off the tick when the feed carries it, because the exchange's own
        running open, high and low are authoritative. A synthetic's feed
        carries none of them, so the day's bars answer instead — which is the
        path that matters for a rolling straddle.
        """
        quote = context.quote(subject)
        if quote is not None:
            carried = {
                Reference.DAY_OPEN: quote.open,
                Reference.PREVIOUS_CLOSE: quote.previous_close,
                Reference.DAY_HIGH: quote.high,
                Reference.DAY_LOW: quote.low,
            }[self.reference]
            if carried is not None:
                return carried

        if self.reference is Reference.PREVIOUS_CLOSE:
            # Yesterday, which today's bars cannot supply.
            return None

        bars = _today(context, subject)
        if not bars:
            return None
        if self.reference is Reference.DAY_OPEN:
            return bars[0].open
        if self.reference is Reference.DAY_HIGH:
            return max(bar.high for bar in bars)
        return min(bar.low for bar in bars)


def _today(context: RuleContext, subject: InstrumentId) -> list[Bar]:
    bars = context.candles(subject, BarInterval.ONE_MINUTE, DAY_LOOKBACK_BARS)
    return [
        bar for bar in bars if bar.start.astimezone(context.timezone).date() == context.trading_day
    ]
