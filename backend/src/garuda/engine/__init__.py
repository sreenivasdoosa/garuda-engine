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
from garuda.engine.selectors import (
    FixedInstrumentSelector,
    HedgeStrikeSelector,
    InstrumentSelector,
    NearMonthFutureSelector,
    OptionStrikeSelector,
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
from garuda.engine.strikes import AT_THE_MONEY, Moneyness, atm_strike, strike_for
from garuda.engine.tranches import (
    Tranche,
    TrancheId,
    TrancheLedger,
    TrancheState,
    cutoff_at,
)

__all__ = [
    "AT_THE_MONEY",
    "DEFAULT_MAX_LEGS",
    "MAX_LEGS_CEILING",
    "ConfigLayer",
    "DayCondition",
    "DirectionProvider",
    "EvaluationContext",
    "EvaluationResult",
    "FixedDirection",
    "FixedInstrumentSelector",
    "HedgeStrikeSelector",
    "InstrumentSelector",
    "IntentOutcome",
    "LegBasedEvaluator",
    "LegSpec",
    "Moneyness",
    "NearMonthFutureSelector",
    "OptionStrikeSelector",
    "ResolvedConfig",
    "SelectionContext",
    "SideRule",
    "SignalBatch",
    "SignalFactory",
    "StrategyEvaluator",
    "StrategySpec",
    "Subscription",
    "TradingPipeline",
    "Tranche",
    "TrancheId",
    "TrancheLedger",
    "TrancheState",
    "UnderlyingSelector",
    "atm_strike",
    "conditions_on",
    "configured_protection",
    "cutoff_at",
    "protection_from",
    "resolve",
    "strike_for",
]
