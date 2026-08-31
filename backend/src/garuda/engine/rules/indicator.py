"""Comparing an indicator.

One rule, not one per indicator. `RSI > 60`, `EMA(9) above EMA(21)`,
`ATR(20) below ATR(100)`, `close above VWAP` and everything else of that shape
are this rule with different parameters — so adding an indicator to the engine
adds no rule at all.

**Values come from closed bars.** An indicator recomputed inside a forming bar
moves as the bar fills and can cross a threshold and uncross it before the
period is out. That is repainting, and it turns a backtest into fiction. The
context guarantees closed bars; this relies on it.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed, unavailable
from garuda.engine.rules.registry import Cost, rule


class Comparator(StrEnum):
    ABOVE = "gt"
    AT_OR_ABOVE = "gte"
    BELOW = "lt"
    AT_OR_BELOW = "lte"

    def holds(self, left: Decimal, right: Decimal) -> bool:
        if self is Comparator.ABOVE:
            return left > right
        if self is Comparator.AT_OR_ABOVE:
            return left >= right
        if self is Comparator.BELOW:
            return left < right
        return left <= right

    @property
    def phrase(self) -> str:
        return {
            Comparator.ABOVE: "above",
            Comparator.AT_OR_ABOVE: "at or above",
            Comparator.BELOW: "below",
            Comparator.AT_OR_BELOW: "at or below",
        }[self]


@rule("indicator", cost=Cost.EXPENSIVE)
@dataclass(frozen=True)
class IndicatorCompare:
    """An indicator against a number, or against another indicator."""

    indicator: str
    comparator: Comparator = Comparator.ABOVE
    #: The number to compare against. Omitted when comparing to another
    #: indicator.
    value: Decimal | None = None
    #: The other indicator, when comparing one to another.
    reference: str | None = None
    reference_params: Mapping[str, object] = field(default_factory=dict)
    reference_interval: BarInterval | None = None
    interval: BarInterval = BarInterval.FIVE_MINUTES
    params: Mapping[str, object] = field(default_factory=dict)
    instrument: InstrumentId | None = None

    def __post_init__(self) -> None:
        if (self.value is None) == (self.reference is None):
            raise DomainError(
                f"{self.indicator}: compare against a value or another indicator, not "
                "both and not neither"
            )

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = self.instrument or context.underlying

        left = context.indicator(self.indicator, subject, self.interval, **dict(self.params))
        if left is None:
            return unavailable(
                f"{self.indicator} on {subject} {self.interval.value} could not be computed"
            )

        right, described = self._right(context, subject)
        if right is None:
            return unavailable(f"{described} could not be computed")

        detail = {"left": left, "right": right}
        phrase = self.comparator.phrase
        if self.comparator.holds(left, right):
            return passed(f"{self._name()} at {left} is {phrase} {described} at {right}", **detail)
        return failed(f"{self._name()} at {left} is not {phrase} {described} at {right}", **detail)

    def _right(self, context: RuleContext, subject: InstrumentId) -> tuple[Decimal | None, str]:
        if self.reference is None:
            return self.value, str(self.value)
        interval = self.reference_interval or self.interval
        value = context.indicator(self.reference, subject, interval, **dict(self.reference_params))
        return value, f"{self.reference}{_shape(self.reference_params)} {interval.value}"

    def _name(self) -> str:
        return f"{self.indicator}{_shape(self.params)} {self.interval.value}"


def _shape(params: Mapping[str, object]) -> str:
    if not params:
        return ""
    return "(" + ", ".join(f"{k}={v}" for k, v in sorted(params.items())) + ")"
