"""Rules.

A strategy decides whether to enter, which way, and when to get out. All three
are lists of small pluggable rules, and the engine owns no knowledge of what
any particular rule means. See `docs/STRATEGY_RULES.md`.
"""

from garuda.engine.rules.breakout import Breakout, Confirm, Way
from garuda.engine.rules.compose import AllOf, AnyOf, AtLeast, Not
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.evaluate import (
    FAILURES_BEFORE_DISABLED,
    Evaluation,
    RuleRunner,
    blocking_reason,
)
from garuda.engine.rules.indicator import Comparator, IndicatorCompare
from garuda.engine.rules.outcome import (
    RuleOutcome,
    Verdict,
    failed,
    passed,
    unavailable,
)
from garuda.engine.rules.price import (
    PercentFromReference,
    PriceAbove,
    PriceBelow,
    Reference,
)
from garuda.engine.rules.registry import (
    Cost,
    Registration,
    Rule,
    build,
    build_all,
    registered,
    rule,
)
from garuda.engine.rules.timing import AtOrAfter, Before, WithinWindow

__all__ = [
    "FAILURES_BEFORE_DISABLED",
    "AllOf",
    "AnyOf",
    "AtLeast",
    "AtOrAfter",
    "Before",
    "Breakout",
    "Comparator",
    "Confirm",
    "Cost",
    "Evaluation",
    "IndicatorCompare",
    "Not",
    "PercentFromReference",
    "PriceAbove",
    "PriceBelow",
    "Reference",
    "Registration",
    "Rule",
    "RuleContext",
    "RuleOutcome",
    "RuleRunner",
    "Verdict",
    "Way",
    "WithinWindow",
    "blocking_reason",
    "build",
    "build_all",
    "failed",
    "passed",
    "registered",
    "rule",
    "unavailable",
]
