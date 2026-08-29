"""Kite's vocabulary, and the engine's.

Translation lives here and nowhere else: the engine never sees a Kite status
string, and Kite never sees an engine enum.

Two rules in this file are not translation but hard-won behaviour, ported from
the reference engine:

**An unrecognised status becomes UNKNOWN and is alerted, never passed through.**
The reference engine had exactly one adapter that upper-cased whatever the
broker sent and stamped it onto the order, which meant a status Kite had only
just introduced would flow into the order book as though the engine understood
it. Everything is mapped explicitly so a new one is loud.

**A silent broker is not a status.** Kite sometimes returns an order with no
status at all. That maps to None, and the caller must leave the status it
already has alone -- overwriting a known state with an empty one loses a fill.
"""

from __future__ import annotations

from garuda.domain.enums import OrderStatus, OrderType, ProductType
from garuda.domain.order import Side

# -- what the engine sends -------------------------------------------------

_ORDER_TYPES: dict[OrderType, str] = {
    OrderType.MARKET: "MARKET",
    OrderType.LIMIT: "LIMIT",
    OrderType.SL_LIMIT: "SL",
    OrderType.SL_MARKET: "SL-M",
}

#: Cover and bracket orders are placed under the MIS product and distinguished
#: by their *variety*, not by a product of their own.
_PRODUCTS: dict[ProductType, str] = {
    ProductType.MIS: "MIS",
    ProductType.CO: "MIS",
    ProductType.BO: "MIS",
    ProductType.NRML: "NRML",
    ProductType.CNC: "CNC",
    ProductType.MTF: "MTF",
}

#: The endpoint an order is placed under. Regular unless it is a cover or
#: bracket order, which Kite routes separately.
_VARIETIES: dict[ProductType, str] = {
    ProductType.CO: "co",
    ProductType.BO: "bo",
}
VARIETY_REGULAR = "regular"

#: Day orders only. The engine has no concept of an order that outlives the
#: session, and immediate-or-cancel would silently change what a strategy asked
#: for.
VALIDITY_DAY = "DAY"


def order_type_to_kite(order_type: OrderType) -> str:
    return _ORDER_TYPES[order_type]


def product_to_kite(product: ProductType) -> str:
    return _PRODUCTS[product]


def variety_for(product: ProductType) -> str:
    return _VARIETIES.get(product, VARIETY_REGULAR)


def side_to_kite(side: Side) -> str:
    return "BUY" if side is Side.BUY else "SELL"


# -- what the engine receives ----------------------------------------------

_ORDER_TYPES_FROM_KITE: dict[str, OrderType] = {
    "MARKET": OrderType.MARKET,
    "LIMIT": OrderType.LIMIT,
    "SL": OrderType.SL_LIMIT,
    "SL-M": OrderType.SL_MARKET,
}

_PRODUCTS_FROM_KITE: dict[str, ProductType] = {
    "MIS": ProductType.MIS,
    "NRML": ProductType.NRML,
    "CNC": ProductType.CNC,
    "MTF": ProductType.MTF,
    "CO": ProductType.CO,
    "BO": ProductType.BO,
}

#: Kite's own status strings. Anything absent is a defect to be alerted, not a
#: value to be guessed at.
_STATUSES_FROM_KITE: dict[str, OrderStatus] = {
    "COMPLETE": OrderStatus.FILLED,
    "OPEN": OrderStatus.NEW,
    "CANCELLED": OrderStatus.CANCELLED,
    "CANCELLED AMO": OrderStatus.CANCELLED,
    "REJECTED": OrderStatus.REJECTED,
    # Resting until its trigger is hit. Live, not pending acknowledgement.
    "TRIGGER PENDING": OrderStatus.NEW,
    # Accepted by Kite, not yet acknowledged by the exchange.
    "PUT ORDER REQ RECEIVED": OrderStatus.PENDING_NEW,
    "VALIDATION PENDING": OrderStatus.PENDING_NEW,
    "OPEN PENDING": OrderStatus.PENDING_NEW,
    "MODIFY VALIDATION PENDING": OrderStatus.PENDING_REPLACE,
    "MODIFY PENDING": OrderStatus.PENDING_REPLACE,
    "CANCEL PENDING": OrderStatus.PENDING_CANCEL,
}


def order_type_from_kite(value: str | None) -> OrderType | None:
    return _ORDER_TYPES_FROM_KITE.get((value or "").upper().strip())


def product_from_kite(value: str | None) -> ProductType | None:
    return _PRODUCTS_FROM_KITE.get((value or "").upper().strip())


def side_from_kite(value: str | None) -> Side:
    return Side.BUY if (value or "").upper().strip() == "BUY" else Side.SELL


def status_from_kite(value: str | None, filled_quantity: int = 0) -> OrderStatus | None:
    """Kite's status, as the engine's.

    Returns None when the broker sent nothing, which means "no news" and not
    "no status": the caller keeps whatever it already knew.

    Two adjustments beyond the table:

    * **Cancelled with a fill is filled.** Kite reports an order that was
      partly executed and then cancelled as CANCELLED, and treating that as
      cancelled loses a real position. What executed, executed.
    * **A partial fill on a live order is PARTIALLY_FILLED**, which Kite does
      not distinguish from OPEN at all.
    """
    if value is None or not value.strip():
        return None

    status = _STATUSES_FROM_KITE.get(value.upper().strip())
    if status is None:
        return OrderStatus.UNKNOWN

    if status is OrderStatus.CANCELLED and filled_quantity > 0:
        return OrderStatus.FILLED
    if status is OrderStatus.NEW and filled_quantity > 0:
        return OrderStatus.PARTIALLY_FILLED
    return status
