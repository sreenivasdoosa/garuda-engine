"""The breach vocabulary.

Fixed now, in full, even though only some are checked in this phase. These
names reach the operator's Console, the breach log and the daily statistics, so
renaming one later means a migration and a retraining of whoever reads them.

Grouped by what they protect against, because that is how an operator reasons
about a breach at 09:20.
"""

from __future__ import annotations

from enum import StrEnum


class BreachFamily(StrEnum):
    PRICE_QUALITY = "PRICE_QUALITY"
    LIQUIDITY = "LIQUIDITY"
    ORDER_SHAPE = "ORDER_SHAPE"
    RATE = "RATE"
    POSITION = "POSITION"
    ACCOUNT = "ACCOUNT"
    SYSTEM = "SYSTEM"
    EXIT_SAFETY = "EXIT_SAFETY"


class BreachType(StrEnum):
    # Price quality — is the number we are about to trade on real?
    QUOTE_UNAVAILABLE = "QUOTE_UNAVAILABLE"
    PRICE_ZERO = "PRICE_ZERO"
    PRICE_STALE = "PRICE_STALE"
    PRICE_NOT_TRADED_TODAY = "PRICE_NOT_TRADED_TODAY"
    PRICE_FREAK = "PRICE_FREAK"
    PRICE_DEVIATION = "PRICE_DEVIATION"

    # Liquidity — can we get out again?
    VOLUME_LOW = "VOLUME_LOW"
    SPREAD_WIDE = "SPREAD_WIDE"
    DEPTH_INSUFFICIENT = "DEPTH_INSUFFICIENT"

    # Order shape — is this order the size we meant?
    ORDER_QTY_EXCEEDED = "ORDER_QTY_EXCEEDED"
    ORDER_VALUE_EXCEEDED = "ORDER_VALUE_EXCEEDED"
    FREEZE_QTY_EXCEEDED = "FREEZE_QTY_EXCEEDED"

    # Rate — is something looping?
    ORDER_RATE_EXCEEDED = "ORDER_RATE_EXCEEDED"
    ORDER_OPERATION_RATE_EXCEEDED = "ORDER_OPERATION_RATE_EXCEEDED"
    EXIT_RATE_EXCEEDED = "EXIT_RATE_EXCEEDED"

    # Position — how much are we carrying?
    POSITION_PER_SYMBOL_EXCEEDED = "POSITION_PER_SYMBOL_EXCEEDED"
    POSITION_PER_STRATEGY_EXCEEDED = "POSITION_PER_STRATEGY_EXCEEDED"
    POSITION_TOTAL_EXCEEDED = "POSITION_TOTAL_EXCEEDED"
    COMBO_TOTAL_EXCEEDED = "COMBO_TOTAL_EXCEEDED"

    # Account
    DAILY_LOSS_EXCEEDED = "DAILY_LOSS_EXCEEDED"
    MARGIN_INSUFFICIENT = "MARGIN_INSUFFICIENT"

    # System
    MARKET_CLOSED = "MARKET_CLOSED"
    BROKER_STOPPED = "BROKER_STOPPED"
    KILL_SWITCH_ACTIVE = "KILL_SWITCH_ACTIVE"
    VOLATILITY_CIRCUIT = "VOLATILITY_CIRCUIT"
    ERROR_RATE_CIRCUIT = "ERROR_RATE_CIRCUIT"
    #: A check itself failed. Treated as a breach rather than ignored: a gate
    #: that cannot answer must not wave the order through.
    CHECK_FAILED = "CHECK_FAILED"

    # Exit safety
    DUPLICATE_EXIT_ORDER = "DUPLICATE_EXIT_ORDER"
    EXIT_QTY_EXCEEDS_POSITION = "EXIT_QTY_EXCEEDS_POSITION"

    @property
    def family(self) -> BreachFamily:
        return _FAMILIES[self]

    @property
    def severity(self) -> int:
        """How bad this is, 1 to 5, as the reference engine grades it.

        Not derived from the family: severity is about what the operator has
        to do next and the family is about what went wrong, and they do not
        line up. A kill switch and a daily-loss breach are both a 5 while a
        market-closed breach is a 1, and all three are SYSTEM or ACCOUNT.
        """
        return _SEVERITIES.get(self, 1)


#: Ported from the reference, exactly. Everything unlisted is a 1.
_SEVERITIES: dict[BreachType, int] = {
    BreachType.KILL_SWITCH_ACTIVE: 5,
    BreachType.DAILY_LOSS_EXCEEDED: 5,
    BreachType.VOLATILITY_CIRCUIT: 5,
    BreachType.ERROR_RATE_CIRCUIT: 5,
    BreachType.BROKER_STOPPED: 4,
    BreachType.PRICE_FREAK: 3,
    BreachType.POSITION_TOTAL_EXCEEDED: 3,
    BreachType.COMBO_TOTAL_EXCEEDED: 3,
    BreachType.PRICE_STALE: 2,
    BreachType.VOLUME_LOW: 2,
    BreachType.SPREAD_WIDE: 2,
}


_FAMILIES: dict[BreachType, BreachFamily] = {
    BreachType.QUOTE_UNAVAILABLE: BreachFamily.PRICE_QUALITY,
    BreachType.PRICE_ZERO: BreachFamily.PRICE_QUALITY,
    BreachType.PRICE_STALE: BreachFamily.PRICE_QUALITY,
    BreachType.PRICE_NOT_TRADED_TODAY: BreachFamily.PRICE_QUALITY,
    BreachType.PRICE_FREAK: BreachFamily.PRICE_QUALITY,
    BreachType.PRICE_DEVIATION: BreachFamily.PRICE_QUALITY,
    BreachType.VOLUME_LOW: BreachFamily.LIQUIDITY,
    BreachType.SPREAD_WIDE: BreachFamily.LIQUIDITY,
    BreachType.DEPTH_INSUFFICIENT: BreachFamily.LIQUIDITY,
    BreachType.ORDER_QTY_EXCEEDED: BreachFamily.ORDER_SHAPE,
    BreachType.ORDER_VALUE_EXCEEDED: BreachFamily.ORDER_SHAPE,
    BreachType.FREEZE_QTY_EXCEEDED: BreachFamily.ORDER_SHAPE,
    BreachType.ORDER_RATE_EXCEEDED: BreachFamily.RATE,
    BreachType.ORDER_OPERATION_RATE_EXCEEDED: BreachFamily.RATE,
    BreachType.EXIT_RATE_EXCEEDED: BreachFamily.RATE,
    BreachType.POSITION_PER_SYMBOL_EXCEEDED: BreachFamily.POSITION,
    BreachType.POSITION_PER_STRATEGY_EXCEEDED: BreachFamily.POSITION,
    BreachType.POSITION_TOTAL_EXCEEDED: BreachFamily.POSITION,
    BreachType.COMBO_TOTAL_EXCEEDED: BreachFamily.POSITION,
    BreachType.DAILY_LOSS_EXCEEDED: BreachFamily.ACCOUNT,
    BreachType.MARGIN_INSUFFICIENT: BreachFamily.ACCOUNT,
    BreachType.MARKET_CLOSED: BreachFamily.SYSTEM,
    BreachType.BROKER_STOPPED: BreachFamily.SYSTEM,
    BreachType.KILL_SWITCH_ACTIVE: BreachFamily.SYSTEM,
    BreachType.VOLATILITY_CIRCUIT: BreachFamily.SYSTEM,
    BreachType.ERROR_RATE_CIRCUIT: BreachFamily.SYSTEM,
    BreachType.CHECK_FAILED: BreachFamily.SYSTEM,
    BreachType.DUPLICATE_EXIT_ORDER: BreachFamily.EXIT_SAFETY,
    BreachType.EXIT_QTY_EXCEEDS_POSITION: BreachFamily.EXIT_SAFETY,
}
