"""The domain model: pure data and invariants, no I/O.

This package imports nothing else from ``garuda`` -- a rule enforced by
import-linter, not by discipline. Everything above it depends on these types,
so a dependency here would become a dependency everywhere.
"""

from garuda.domain.calendar import (
    MAX_LOOKAHEAD_DAYS,
    Session,
    SessionWindow,
    TradingCalendar,
    require_aware,
)
from garuda.domain.client import BrokerCode, TradingClient, TradingClientId
from garuda.domain.enums import (
    AssetClass,
    Direction,
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    OrderStatus,
    OrderType,
    ProductType,
    Segment,
    SettlementCycle,
    SettlementType,
    TradeState,
    TradingMode,
)
from garuda.domain.errors import (
    CurrencyMismatchError,
    DomainError,
    FloatInMoneyPathError,
    InvalidInstrumentError,
    NaiveDatetimeError,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import DERIVATIVE_KINDS, Instrument, InstrumentId
from garuda.domain.market import Bar, BarInterval, DepthLevel, Tick
from garuda.domain.money import MONEY_ROUNDING, Currency, Money, Numeric, to_decimal
from garuda.domain.order import (
    ORDER_TRANSITIONS,
    BrokerOrderId,
    ClientOrderId,
    Fill,
    IllegalOrderTransitionError,
    Order,
    OrderRequest,
    Side,
)
from garuda.domain.position import Position, opening_side

__all__ = [
    "DERIVATIVE_KINDS",
    "MAX_LOOKAHEAD_DAYS",
    "MONEY_ROUNDING",
    "ORDER_TRANSITIONS",
    "AssetClass",
    "Bar",
    "BarInterval",
    "BrokerCode",
    "BrokerOrderId",
    "ClientOrderId",
    "Currency",
    "CurrencyMismatchError",
    "DepthLevel",
    "Direction",
    "DomainError",
    "Exchange",
    "ExerciseStyle",
    "Fill",
    "FloatInMoneyPathError",
    "IllegalOrderTransitionError",
    "Instrument",
    "InstrumentId",
    "InstrumentKind",
    "InvalidInstrumentError",
    "Money",
    "NaiveDatetimeError",
    "Numeric",
    "OptionType",
    "Order",
    "OrderRequest",
    "OrderStatus",
    "OrderType",
    "Position",
    "ProductType",
    "Segment",
    "Session",
    "SessionWindow",
    "SettlementCycle",
    "SettlementType",
    "Side",
    "Tick",
    "TradeState",
    "TradingCalendar",
    "TradingClient",
    "TradingClientId",
    "TradingMode",
    "opening_side",
    "require_aware",
    "to_decimal",
]
