"""What happened to a trade, one event at a time.

`TRADE_LOG` in the reference engine. An alert says something needs a person;
this says what happened, in order, so a finished trade can be read back --
signalled, placed, filled, protected, trailed, exited, and why -- and the
Console can draw it as the trade's timeline.

The vocabulary is the reference's, verbatim. The operator reads these names
on the timeline and will go on reading them in every report, and a renamed
event is one they have to learn twice.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Final

from garuda.domain.client import TradingClientId


class TradeLogEventCategory(StrEnum):
    """The bucket an event falls in. Drives the page's filter and colour."""

    ENTRY = "ENTRY"
    SL = "SL"
    TARGET = "TARGET"
    HEDGE = "HEDGE"
    EXIT = "EXIT"
    ERROR = "ERROR"
    MODIFY = "MODIFY"


class TradeLogEventType(StrEnum):
    """Every event the reference engine names. Each belongs to one category."""

    # ENTRY
    SIGNAL_GENERATED = "SIGNAL_GENERATED"
    ENTRY_ORDER_PLACED = "ENTRY_ORDER_PLACED"
    ENTRY_ORDER_MODIFIED = "ENTRY_ORDER_MODIFIED"
    ENTRY_PARTIAL_FILL = "ENTRY_PARTIAL_FILL"
    ENTRY_FILLED = "ENTRY_FILLED"
    ENTRY_REJECTED = "ENTRY_REJECTED"
    ENTRY_FAILED = "ENTRY_FAILED"
    ESCALATION_TRIGGERED = "ESCALATION_TRIGGERED"
    # SL
    SL_ORDER_PLACED = "SL_ORDER_PLACED"
    SL_ORDER_MODIFIED = "SL_ORDER_MODIFIED"
    SL_TRAIL_UPDATED = "SL_TRAIL_UPDATED"
    SL_ORDER_CANCELLED = "SL_ORDER_CANCELLED"
    SL_HIT = "SL_HIT"
    SL_REJECTED = "SL_REJECTED"
    # TARGET
    TARGET_ORDER_PLACED = "TARGET_ORDER_PLACED"
    TARGET_ORDER_MODIFIED = "TARGET_ORDER_MODIFIED"
    TARGET_ORDER_REJECTED = "TARGET_ORDER_REJECTED"
    TARGET_HIT = "TARGET_HIT"
    # HEDGE
    HEDGE_ENTRY_PLACED = "HEDGE_ENTRY_PLACED"
    HEDGE_ENTRY_FILLED = "HEDGE_ENTRY_FILLED"
    HEDGE_REPLACE_STARTED = "HEDGE_REPLACE_STARTED"
    HEDGE_REPLACE_NEW_FILLED = "HEDGE_REPLACE_NEW_FILLED"
    HEDGE_REPLACE_OLD_EXITED = "HEDGE_REPLACE_OLD_EXITED"
    HEDGE_REPLACE_COMPLETE = "HEDGE_REPLACE_COMPLETE"
    HEDGE_REPLACE_FAILED = "HEDGE_REPLACE_FAILED"
    # EXIT
    EXIT_TRIGGERED = "EXIT_TRIGGERED"
    SQUARE_OFF_REQUESTED = "SQUARE_OFF_REQUESTED"
    EXIT_ORDER_PLACED = "EXIT_ORDER_PLACED"
    EXIT_ORDER_MODIFIED = "EXIT_ORDER_MODIFIED"
    EXIT_ORDER_FILLED = "EXIT_ORDER_FILLED"
    EXIT_FAILED = "EXIT_FAILED"
    TRADE_COMPLETED = "TRADE_COMPLETED"
    TRADE_CANCELLED = "TRADE_CANCELLED"
    # ERROR
    BROKER_FAILURE = "BROKER_FAILURE"
    TIMEOUT = "TIMEOUT"
    GENERIC_ERROR = "GENERIC_ERROR"
    # MODIFY
    PARAMETERS_CHANGED = "PARAMETERS_CHANGED"

    @property
    def category(self) -> TradeLogEventCategory:
        return _CATEGORY_OF[self]


_CATEGORY_OF: Final[dict[TradeLogEventType, TradeLogEventCategory]] = {
    **dict.fromkeys(
        (
            TradeLogEventType.SIGNAL_GENERATED,
            TradeLogEventType.ENTRY_ORDER_PLACED,
            TradeLogEventType.ENTRY_ORDER_MODIFIED,
            TradeLogEventType.ENTRY_PARTIAL_FILL,
            TradeLogEventType.ENTRY_FILLED,
            TradeLogEventType.ENTRY_REJECTED,
            TradeLogEventType.ENTRY_FAILED,
            TradeLogEventType.ESCALATION_TRIGGERED,
        ),
        TradeLogEventCategory.ENTRY,
    ),
    **dict.fromkeys(
        (
            TradeLogEventType.SL_ORDER_PLACED,
            TradeLogEventType.SL_ORDER_MODIFIED,
            TradeLogEventType.SL_TRAIL_UPDATED,
            TradeLogEventType.SL_ORDER_CANCELLED,
            TradeLogEventType.SL_HIT,
            TradeLogEventType.SL_REJECTED,
        ),
        TradeLogEventCategory.SL,
    ),
    **dict.fromkeys(
        (
            TradeLogEventType.TARGET_ORDER_PLACED,
            TradeLogEventType.TARGET_ORDER_MODIFIED,
            TradeLogEventType.TARGET_ORDER_REJECTED,
            TradeLogEventType.TARGET_HIT,
        ),
        TradeLogEventCategory.TARGET,
    ),
    **dict.fromkeys(
        (
            TradeLogEventType.HEDGE_ENTRY_PLACED,
            TradeLogEventType.HEDGE_ENTRY_FILLED,
            TradeLogEventType.HEDGE_REPLACE_STARTED,
            TradeLogEventType.HEDGE_REPLACE_NEW_FILLED,
            TradeLogEventType.HEDGE_REPLACE_OLD_EXITED,
            TradeLogEventType.HEDGE_REPLACE_COMPLETE,
            TradeLogEventType.HEDGE_REPLACE_FAILED,
        ),
        TradeLogEventCategory.HEDGE,
    ),
    **dict.fromkeys(
        (
            TradeLogEventType.EXIT_TRIGGERED,
            TradeLogEventType.SQUARE_OFF_REQUESTED,
            TradeLogEventType.EXIT_ORDER_PLACED,
            TradeLogEventType.EXIT_ORDER_MODIFIED,
            TradeLogEventType.EXIT_ORDER_FILLED,
            TradeLogEventType.EXIT_FAILED,
            TradeLogEventType.TRADE_COMPLETED,
            TradeLogEventType.TRADE_CANCELLED,
        ),
        TradeLogEventCategory.EXIT,
    ),
    **dict.fromkeys(
        (
            TradeLogEventType.BROKER_FAILURE,
            TradeLogEventType.TIMEOUT,
            TradeLogEventType.GENERIC_ERROR,
        ),
        TradeLogEventCategory.ERROR,
    ),
    TradeLogEventType.PARAMETERS_CHANGED: TradeLogEventCategory.MODIFY,
}

#: The events after which a trade's timeline is complete. The reference
#: purges only timelines that reached one of these: a live trade keeps its
#: whole history however old its first event is.
TERMINAL_EVENTS: Final[frozenset[TradeLogEventType]] = frozenset(
    {
        TradeLogEventType.TRADE_COMPLETED,
        TradeLogEventType.TRADE_CANCELLED,
        TradeLogEventType.ENTRY_FAILED,
        TradeLogEventType.ENTRY_REJECTED,
        TradeLogEventType.EXIT_FAILED,
    }
)


@dataclass(frozen=True, slots=True)
class TradeLogEntry:
    """One line of a trade's story.

    The snapshot columns -- price, quantities, the stop and target -- are what
    the trade and its order looked like at that moment, carried on the row so
    the timeline reads without a join back to a trade that has since moved on.
    """

    trade_id: str
    trading_client: TradingClientId
    event_type: TradeLogEventType
    at: datetime
    #: One line, for a person.
    message: str
    strategy: str | None = None
    trading_symbol: str | None = None
    hedge_correlation_id: str | None = None
    order_id: str | None = None
    order_status: str | None = None
    order_type: str | None = None
    price: Decimal | None = None
    quantity: int | None = None
    filled_quantity: int | None = None
    sl_price: Decimal | None = None
    target_price: Decimal | None = None
    #: Event-specific structure, for whatever wants more than the line.
    details: Mapping[str, object] | None = None
    #: Set for the ERROR category, and for a refusal with a reason.
    error_message: str | None = None

    @property
    def category(self) -> TradeLogEventCategory:
        return self.event_type.category
