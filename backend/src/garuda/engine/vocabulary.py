"""The strategy vocabulary: every value a definition or a configuration row
may hold, as the reference engine spells it (`STRATEGY_ENGINE.md` §1).

Each enum parses stored text and refuses anything else by name. A value the
engine does not know is refused at save time and again at load, never
guessed at: a strategy that silently trades a different strike than
configured is worse than one that does not trade.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Self

from garuda.domain.errors import DomainError


class _Vocabulary(StrEnum):
    """A closed set of stored codes."""

    @classmethod
    def parse(cls, text: str | None, *, field: str | None = None) -> Self:
        """A stored code, or a refusal naming the field and the choices."""
        code = (text or "").strip()
        for member in cls:
            if member.value.upper() == code.upper():
                return member
        name = field or cls.__name__
        raise DomainError(
            f"{name} {text!r} is not one of {', '.join(member.value for member in cls)}"
        )

    @classmethod
    def choices(cls) -> tuple[str, ...]:
        return tuple(member.value for member in cls)


class TradeMode(_Vocabulary):
    """What a strategy trades, and which way for options."""

    OPTION_SELLING = "OPTION_SELLING"
    OPTION_BUYING = "OPTION_BUYING"
    FUTURES = "FUTURES"
    FUTURES_OPTIONS = "FUTURES_OPTIONS"
    EQUITY = "EQUITY"

    @property
    def trades_options(self) -> bool:
        return self in (
            TradeMode.OPTION_SELLING,
            TradeMode.OPTION_BUYING,
            TradeMode.FUTURES_OPTIONS,
        )


class StrategyProduct(_Vocabulary):
    """How long a position is meant to live. Not the broker's product code,
    which is a consequence of this plus the venue."""

    INTRADAY = "INTRADAY"
    POSITIONAL = "POSITIONAL"
    CASHBUY = "CASHBUY"
    MTF = "MTF"


class UnderlyingType(_Vocabulary):
    INDEX = "INDEX"
    FUTURE = "FUTURE"
    SYNTHETIC_FUTURE = "SYNTHETIC_FUTURE"


class ExpiryType(_Vocabulary):
    WEEKLY = "WEEKLY"
    MONTHLY = "MONTHLY"


class StrategyStatus(_Vocabulary):
    """ACTIVE enters and exits; WIND_DOWN only exits and hedges; INACTIVE
    does nothing."""

    ACTIVE = "ACTIVE"
    WIND_DOWN = "WIND_DOWN"
    INACTIVE = "INACTIVE"


class StrikeType(_Vocabulary):
    """How an option leg's strike is chosen. Spelled as the reference stores
    them, mixed case and all, because the rows are shared with its Console."""

    MONEYNESS = "MoneyNess"
    FIXED_PREMIUM = "FixedPremium"
    PREMIUM_RANGE = "PremiumRange"
    PREMIUM_RANGE_OI_RANKED = "PremiumRange_OIRanked"
    CANDLE_LOW_NEAR_PREMIUM = "CandleLow_NearPremium"
    FIXED_DELTA = "FixedDelta"


class RiskCalculationMode(_Vocabulary):
    STOP_LOSS = "STOP_LOSS"
    WING_WIDTH_MAX_LOSS = "WING_WIDTH_MAX_LOSS"


class TrailType(_Vocabulary):
    RISK_MULTIPLE = "RISK_MULTIPLE"
    PERCENTAGE = "PERCENTAGE"
    ATR = "ATR"
    EMA = "EMA"
    SUPERTREND = "SUPERTREND"
    HEIKIN_ASHI = "HEIKIN_ASHI"


class ExitMode(_Vocabulary):
    SAME_DAY = "SAME_DAY"
    MINUTES_FROM_ENTRY = "MINUTES_FROM_ENTRY"
    DAYS_FROM_ENTRY = "DAYS_FROM_ENTRY"
    DTE = "DTE"
    EXPIRY = "EXPIRY"


class OrderFillEscalationMode(_Vocabulary):
    """Garuda's spelling, which trade management already reads."""

    NONE = "NONE"
    STEPPED = "STEPPED"
    MARKET = "MARKET"


class BreakoutWatchType(_Vocabulary):
    OPTION_SYMBOL = "OPTION_SYMBOL"
    UNDERLYING = "UNDERLYING"


class BreakoutTriggerMode(_Vocabulary):
    PERCENTAGE = "PERCENTAGE"
    ABSOLUTE = "ABSOLUTE"
    CANDLE_LOW = "CANDLE_LOW"
    RANGE = "RANGE"


class BreakoutDirection(_Vocabulary):
    ABOVE = "ABOVE"
    BELOW = "BELOW"
    EITHER = "EITHER"


class BreakoutRangeType(_Vocabulary):
    INTRADAY_WINDOW = "INTRADAY_WINDOW"
    PREVIOUS_DAYS = "PREVIOUS_DAYS"


class BreakoutSide(_Vocabulary):
    """Which way to trade when a range breaks on one side."""

    LONG = "LONG"
    SHORT = "SHORT"


class BreakoutReversalMode(_Vocabulary):
    NONE = "NONE"
    AFTER_CLOSE = "AFTER_CLOSE"
    PARALLEL = "PARALLEL"


class EquitySizingModel(_Vocabulary):
    FIXED_AMOUNT_PER_STOCK = "FIXED_AMOUNT_PER_STOCK"
    MAX_POSITIONS_EQUAL_SPLIT = "MAX_POSITIONS_EQUAL_SPLIT"
    MAX_RISK_PER_TRADE = "MAX_RISK_PER_TRADE"


class OnIndexRemoval(_Vocabulary):
    HOLD_UNTIL_EXIT = "HOLD_UNTIL_EXIT"
    EXIT_IMMEDIATELY = "EXIT_IMMEDIATELY"


#: The choices a configuration row's text columns accept, by column. The
#: Console offers these and the API refuses anything else.
CONFIG_CHOICES: dict[str, tuple[str, ...]] = {
    "strike_type": StrikeType.choices(),
    "risk_calculation_mode": RiskCalculationMode.choices(),
    "trail_sl_type": TrailType.choices(),
    "exit_mode": ExitMode.choices(),
    "order_fill_escalation_mode": OrderFillEscalationMode.choices(),
    "breakout_watch_type": BreakoutWatchType.choices(),
    "breakout_trigger_mode": BreakoutTriggerMode.choices(),
    "breakout_direction": BreakoutDirection.choices(),
    "breakout_range_type": BreakoutRangeType.choices(),
    "breakout_on_high_break": BreakoutSide.choices(),
    "breakout_on_low_break": BreakoutSide.choices(),
    "breakout_reversal_mode": BreakoutReversalMode.choices(),
}

#: The same for a definition's text columns.
DEFINITION_CHOICES: dict[str, tuple[str, ...]] = {
    "trade_mode": TradeMode.choices(),
    "product": StrategyProduct.choices(),
    "underlying_type": UnderlyingType.choices(),
    "expiry_type": ExpiryType.choices(),
    "status": StrategyStatus.choices(),
    "equity_sizing_model": EquitySizingModel.choices(),
    "on_index_removal": OnIndexRemoval.choices(),
}
