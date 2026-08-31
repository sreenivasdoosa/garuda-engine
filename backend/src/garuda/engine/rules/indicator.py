"""Comparing an indicator.

One rule, not one per indicator. `RSI > 60`, `EMA(9) above EMA(21)`,
`ATR(20) below ATR(100)`, `close above VWAP` and everything else of that shape
are this rule with different parameters — so adding an indicator to the engine
adds no rule at all.

**Values come from closed bars.** An indicator recomputed inside a forming bar
moves as the bar fills and can cross a threshold and uncross it before the
period is out. That is repainting, and it turns a backtest into fiction. The
context guarantees closed bars; this relies on it.

**A crossing is an event, and a comparison is a state.** `EMA(9) above
EMA(21)` is true on every bar it stays above; `EMA(9) crossing above EMA(21)`
is true on the one bar it becomes so. For an entry rule that only fires once
the two are the same, and for a re-entering strategy or an exit rule they are
different strategies. The event is answered by asking the same question of the
previous closed bar, which is why nothing here holds state between
evaluations: a rule may not, and a restart would lose it anyway.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.engine.indicators import build as build_indicator
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed, unavailable
from garuda.engine.rules.registry import Cost, rule


class Comparator(StrEnum):
    ABOVE = "gt"
    AT_OR_ABOVE = "gte"
    BELOW = "lt"
    AT_OR_BELOW = "lte"
    EQUAL = "eq"
    NOT_EQUAL = "ne"
    #: Above now and not above at the previous closed bar. A crossing is an
    #: event, and an ``ABOVE`` rule fires on every bar it stays above -- which
    #: for a re-entering strategy is a different strategy.
    CROSSES_ABOVE = "cross_above"
    CROSSES_BELOW = "cross_below"

    def holds(self, left: Decimal, right: Decimal) -> bool:
        """Whether the comparison is true right now, ignoring history.

        A crossing reduces to its standing half here -- above for a cross up,
        below for a cross down -- and the rule adds the "and was not before"
        half, because only the rule can ask for the earlier value.
        """
        if self is Comparator.ABOVE or self is Comparator.CROSSES_ABOVE:
            return left > right
        if self is Comparator.AT_OR_ABOVE:
            return left >= right
        if self is Comparator.BELOW or self is Comparator.CROSSES_BELOW:
            return left < right
        if self is Comparator.EQUAL:
            return left == right
        if self is Comparator.NOT_EQUAL:
            return left != right
        return left <= right

    @property
    def is_crossing(self) -> bool:
        """Whether this needs the previous bar as well as this one."""
        return self in (Comparator.CROSSES_ABOVE, Comparator.CROSSES_BELOW)

    @property
    def standing(self) -> Comparator:
        """The plain comparison a crossing is the event of."""
        if self is Comparator.CROSSES_ABOVE:
            return Comparator.ABOVE
        if self is Comparator.CROSSES_BELOW:
            return Comparator.BELOW
        return self

    @property
    def phrase(self) -> str:
        return {
            Comparator.ABOVE: "above",
            Comparator.AT_OR_ABOVE: "at or above",
            Comparator.BELOW: "below",
            Comparator.AT_OR_BELOW: "at or below",
            Comparator.EQUAL: "equal to",
            Comparator.NOT_EQUAL: "not equal to",
            Comparator.CROSSES_ABOVE: "crossing above",
            Comparator.CROSSES_BELOW: "crossing below",
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
        # Built and thrown away, for the refusal. An indicator name or a
        # parameter the catalogue does not know is a configuration error, and
        # left to evaluation time it is one that throws on every tick of every
        # day instead of once when the strategy is read.
        build_indicator(self.indicator, **dict(self.params))
        if self.reference is not None:
            build_indicator(self.reference, **dict(self.reference_params))

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = self.instrument or context.underlying

        left = self._left(context, subject)
        if left is None:
            return unavailable(
                f"{self.indicator} on {subject} {self.interval.value} could not be computed"
            )

        right, described = self._right(context, subject)
        if right is None:
            return unavailable(f"{described} could not be computed")

        detail: dict[str, object] = {"left": left, "right": right}
        phrase = self.comparator.phrase
        if not self.comparator.holds(left, right):
            return failed(
                f"{self._name()} at {left} is not {phrase} {described} at {right}", **detail
            )

        if self.comparator.is_crossing:
            crossed = self._crossed(context, subject, detail)
            if crossed is not None:
                return crossed

        return passed(f"{self._name()} at {left} is {phrase} {described} at {right}", **detail)

    def _crossed(
        self, context: RuleContext, subject: InstrumentId, detail: dict[str, object]
    ) -> RuleOutcome | None:
        """The other half of a crossing: it was not true at the last bar.

        None when it *was* a crossing, so the caller passes. A crossing that
        cannot be checked is UNAVAILABLE rather than a pass: on the first bar
        of a series everything looks like it just crossed, and a strategy that
        re-enters on crossings would enter every morning.
        """
        before = self._left(context, subject, back=1)
        against, described = self._right(context, subject, back=1)
        if before is None or against is None:
            return unavailable(
                f"{self._name()} has no value at the previous bar, so {self.comparator.phrase} "
                f"{described} cannot be told from already being there"
            )

        detail["previous_left"] = before
        detail["previous_right"] = against
        if not self.comparator.standing.holds(before, against):
            return None

        return failed(
            f"{self._name()} was already {self.comparator.standing.phrase} {described} "
            f"at the previous bar ({before} against {against}), so this is not a crossing",
            **detail,
        )

    def _left(
        self, context: RuleContext, subject: InstrumentId, *, back: int = 0
    ) -> Decimal | None:
        return context.indicator(
            self.indicator, subject, self.interval, back=back, params=self.params
        )

    def _right(
        self, context: RuleContext, subject: InstrumentId, *, back: int = 0
    ) -> tuple[Decimal | None, str]:
        if self.reference is None:
            # A fixed number does not move, so a crossing against one only
            # needs the indicator's own earlier value.
            return self.value, str(self.value)
        interval = self.reference_interval or self.interval
        value = context.indicator(
            self.reference, subject, interval, back=back, params=self.reference_params
        )
        return value, f"{self.reference}{_shape(self.reference_params)} {interval.value}"

    def _name(self) -> str:
        return f"{self.indicator}{_shape(self.params)} {self.interval.value}"


def _shape(params: Mapping[str, object]) -> str:
    if not params:
        return ""
    return "(" + ", ".join(f"{k}={v}" for k, v in sorted(params.items())) + ")"
