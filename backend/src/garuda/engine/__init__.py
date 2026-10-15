"""The strategy engine: specs, selectors, the evaluator, and the pipeline."""

from garuda.domain.strikes import AT_THE_MONEY, Moneyness, atm_strike, strike_for
from garuda.engine.base_strategy import BaseStrategy, Evaluation, Outcome, StandDown
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.context import (
    EvaluationContext,
    EvaluationResult,
    Subscription,
)
from garuda.engine.custom_strategies import strategy
from garuda.engine.daycondition import DayCondition, conditions_on
from garuda.engine.evaluator import LegBasedEvaluator, StrategyEvaluator
from garuda.engine.indicators import Indicator
from garuda.engine.indicators import build as build_indicator
from garuda.engine.indicators import compute as compute_indicator
from garuda.engine.pipeline import IntentOutcome, TradingPipeline
from garuda.engine.protection import configured_protection, protection_from
from garuda.engine.selectors import (
    MAX_STRIKES_SEARCHED,
    FixedInstrumentSelector,
    HedgeStrikeSelector,
    InstrumentSelector,
    NearMonthFutureSelector,
    OptionStrikeSelector,
    PremiumSelector,
    SelectionContext,
    UnderlyingSelector,
)
from garuda.engine.signals import (
    SignalBatch,
    SignalFactory,
)
from garuda.engine.spec import (
    DEFAULT_MAX_LEGS,
    MAX_LEGS_CEILING,
    DirectionProvider,
    FixedDirection,
    LegSpec,
    SideRule,
    StrategySpec,
)

__all__ = [
    "AT_THE_MONEY",
    "DEFAULT_MAX_LEGS",
    "MAX_LEGS_CEILING",
    "MAX_STRIKES_SEARCHED",
    "BaseStrategy",
    "ConfigLayer",
    "DayCondition",
    "DirectionProvider",
    "Evaluation",
    "EvaluationContext",
    "EvaluationResult",
    "FixedDirection",
    "FixedInstrumentSelector",
    "HedgeStrikeSelector",
    "Indicator",
    "InstrumentSelector",
    "IntentOutcome",
    "LegBasedEvaluator",
    "LegSpec",
    "Moneyness",
    "NearMonthFutureSelector",
    "OptionStrikeSelector",
    "Outcome",
    "PremiumSelector",
    "ResolvedConfig",
    "SelectionContext",
    "SideRule",
    "SignalBatch",
    "SignalFactory",
    "StandDown",
    "StrategyEvaluator",
    "StrategySpec",
    "Subscription",
    "TradingPipeline",
    "UnderlyingSelector",
    "atm_strike",
    "build_indicator",
    "compute_indicator",
    "conditions_on",
    "configured_protection",
    "protection_from",
    "resolve",
    "strategy",
    "strike_for",
]
