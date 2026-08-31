"""The strategy engine: specs, selectors, the evaluator, and the pipeline."""

from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.context import (
    EvaluationContext,
    EvaluationResult,
    Subscription,
)
from garuda.engine.daycondition import DayCondition, conditions_on
from garuda.engine.evaluator import LegBasedEvaluator, StrategyEvaluator
from garuda.engine.pipeline import IntentOutcome, TradingPipeline
from garuda.engine.protection import configured_protection, protection_from
from garuda.engine.selectors import FixedInstrumentSelector, UnderlyingSelector
from garuda.engine.signals import (
    SignalBatch,
    SignalFactory,
)
from garuda.engine.spec import (
    DEFAULT_MAX_LEGS,
    MAX_LEGS_CEILING,
    DirectionProvider,
    FixedDirection,
    InstrumentSelector,
    LegSpec,
    SideRule,
    StrategySpec,
)

__all__ = [
    "DEFAULT_MAX_LEGS",
    "MAX_LEGS_CEILING",
    "ConfigLayer",
    "DayCondition",
    "DirectionProvider",
    "EvaluationContext",
    "EvaluationResult",
    "FixedDirection",
    "FixedInstrumentSelector",
    "InstrumentSelector",
    "IntentOutcome",
    "LegBasedEvaluator",
    "LegSpec",
    "ResolvedConfig",
    "SideRule",
    "SignalBatch",
    "SignalFactory",
    "StrategyEvaluator",
    "StrategySpec",
    "Subscription",
    "TradingPipeline",
    "UnderlyingSelector",
    "conditions_on",
    "configured_protection",
    "protection_from",
    "resolve",
]
