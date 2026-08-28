"""The strategy engine: specs, selectors, the evaluator, and the pipeline."""

from garuda.engine.context import (
    EvaluationContext,
    EvaluationResult,
    Subscription,
)
from garuda.engine.evaluator import LegBasedEvaluator, StrategyEvaluator
from garuda.engine.pipeline import IntentOutcome, TradingPipeline
from garuda.engine.selectors import FixedInstrumentSelector, UnderlyingSelector
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
    "DirectionProvider",
    "EvaluationContext",
    "EvaluationResult",
    "FixedDirection",
    "FixedInstrumentSelector",
    "InstrumentSelector",
    "IntentOutcome",
    "LegBasedEvaluator",
    "LegSpec",
    "SideRule",
    "StrategyEvaluator",
    "StrategySpec",
    "Subscription",
    "TradingPipeline",
    "UnderlyingSelector",
]
