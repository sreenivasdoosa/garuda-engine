"""The vocabulary of the trading domain.

These names are the operator's language. They appear in reports, in the
Console and in the journal, so they change only with a migration.
"""

from __future__ import annotations

from enum import StrEnum


class AssetClass(StrEnum):
    EQUITY = "EQUITY"
    FNO = "FNO"


class Segment(StrEnum):
    EQUITY = "EQUITY"
    FNO = "FNO"
    CURRENCY = "CURRENCY"
    COMMODITY = "COMMODITY"


class InstrumentKind(StrEnum):
    EQUITY = "EQUITY"
    INDEX = "INDEX"
    FUTURE = "FUTURE"
    OPTION = "OPTION"
    #: IV, PCR, straddle price, synthetic future — priced by the engine, never
    #: traded directly. A strategy may subscribe to one exactly like a real
    #: instrument; no order is ever routed for it.
    SYNTHETIC = "SYNTHETIC"


class ExpiryKind(StrEnum):
    """Which series of a derivative a strategy trades.

    Not a property of a contract — a contract has one expiry date and that is
    that. This is how a strategy *chooses* one: the same date is the weekly
    expiry all month and also the monthly expiry in the week it falls last.
    """

    WEEKLY = "WEEKLY"
    MONTHLY = "MONTHLY"


class OptionType(StrEnum):
    CALL = "CALL"
    PUT = "PUT"


class ExerciseStyle(StrEnum):
    EUROPEAN = "EUROPEAN"
    AMERICAN = "AMERICAN"


class SettlementType(StrEnum):
    CASH = "CASH"
    PHYSICAL = "PHYSICAL"


class SettlementCycle(StrEnum):
    T0 = "T+0"
    T1 = "T+1"
    T2 = "T+2"
    T3 = "T+3"

    @property
    def days(self) -> int:
        return int(self.value[-1])


class Direction(StrEnum):
    LONG = "LONG"
    SHORT = "SHORT"

    @property
    def opposite(self) -> Direction:
        return Direction.SHORT if self is Direction.LONG else Direction.LONG

    @property
    def sign(self) -> int:
        """+1 for long, -1 for short. Multiply a quantity by this for signed size."""
        return 1 if self is Direction.LONG else -1


class ProductType(StrEnum):
    MIS = "MIS"  # intraday, squared off same day
    NRML = "NRML"  # carry-forward derivatives
    CNC = "CNC"  # delivery equity
    MTF = "MTF"  # margin trade funding — equity delivery on broker funding
    CO = "CO"  # cover order
    BO = "BO"  # bracket order


class OrderType(StrEnum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"
    SL_MARKET = "SL_MARKET"
    SL_LIMIT = "SL_LIMIT"


class OrderStatus(StrEnum):
    """Total and explicit. Every transition is journalled.

    An unmapped broker status becomes ``UNKNOWN``, which halts trading on that
    instrument. The engine never guesses a state in a money path.
    """

    PENDING_NEW = "PENDING_NEW"
    NEW = "NEW"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    PENDING_CANCEL = "PENDING_CANCEL"
    PENDING_REPLACE = "PENDING_REPLACE"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    UNKNOWN = "UNKNOWN"

    @property
    def is_terminal(self) -> bool:
        return self in _TERMINAL_ORDER_STATUSES

    @property
    def is_in_flight(self) -> bool:
        return self in _IN_FLIGHT_ORDER_STATUSES


_TERMINAL_ORDER_STATUSES = frozenset(
    {OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED}
)
_IN_FLIGHT_ORDER_STATUSES = frozenset(
    {OrderStatus.PENDING_NEW, OrderStatus.PENDING_CANCEL, OrderStatus.PENDING_REPLACE}
)


class TradeState(StrEnum):
    OPEN = "OPEN"  # entry placed, not yet filled
    ACTIVE = "ACTIVE"  # position live in the market
    COMPLETED = "COMPLETED"  # exited
    CANCELLED = "CANCELLED"  # never entered


class TradingMode(StrEnum):
    """A property of a subscription, never of the system or the client.

    The same strategy runs PAPER on one trading client and LIVE on another, in
    the same process, off the same signals.
    """

    PAPER = "PAPER"
    LIVE = "LIVE"
