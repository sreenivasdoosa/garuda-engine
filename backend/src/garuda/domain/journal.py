"""Journal events.

Pure values, built only from other domain types. The fold that turns a stream
of them back into orders and positions lives in :mod:`garuda.journal`; the
contract for storing them is :mod:`garuda.protocols.store`.

Every state change appends one of these **in the same transaction** as the row
it describes, so a crash cannot leave the journal and the tables disagreeing.

Payloads are JSON, and every amount inside one is a **string**, never a JSON
number. ``json.dumps(Decimal("0.1"))`` has no exact representation as a float,
so a numeric payload would silently round the moment it round-tripped -- and a
journal that does not reproduce its own values is not a journal.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from types import MappingProxyType

from garuda.domain.calendar import require_aware
from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus, OrderType, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, Fill, OrderRequest, Side

type JsonValue = str | int | bool | list[JsonValue] | dict[str, JsonValue] | None
type Payload = Mapping[str, JsonValue]


class Actor(StrEnum):
    """Who caused the event. Answers "why did this happen" months later."""

    ENGINE = "ENGINE"
    ADMIN = "ADMIN"
    BROKER = "BROKER"
    SCHEDULER = "SCHEDULER"


class AggregateType(StrEnum):
    ORDER = "ORDER"
    POSITION = "POSITION"
    TRADE = "TRADE"
    SUBSCRIPTION = "SUBSCRIPTION"
    SYSTEM = "SYSTEM"


class EventType(StrEnum):
    ORDER_PLACED = "ORDER_PLACED"
    ORDER_ACCEPTED = "ORDER_ACCEPTED"
    ORDER_REJECTED = "ORDER_REJECTED"
    ORDER_CANCELLED = "ORDER_CANCELLED"
    ORDER_EXPIRED = "ORDER_EXPIRED"
    ORDER_FILLED = "ORDER_FILLED"
    ORDER_STATE_UNKNOWN = "ORDER_STATE_UNKNOWN"
    #: A venue's day reached a phase and the work for it finished. Recorded so
    #: a restart does not repeat the phase; see garuda.core.runner.
    PHASE_COMPLETED = "PHASE_COMPLETED"
    PHASE_FAILED = "PHASE_FAILED"
    TRADING_HALTED = "TRADING_HALTED"
    TRADING_RESUMED = "TRADING_RESUMED"
    RECONCILIATION_MISMATCH = "RECONCILIATION_MISMATCH"


# ---------------------------------------------------------------------------
# Codecs
#
# Explicit, per type, and round-trip tested. Anything reflective would be
# quicker to write and would break silently the first time a field moved.
# ---------------------------------------------------------------------------


def encode_money(money: Money) -> dict[str, JsonValue]:
    return {"amount": str(money.amount), "currency": money.currency.value}


def decode_money(raw: Payload) -> Money:
    amount = raw["amount"]
    currency = raw["currency"]
    if not isinstance(amount, str) or not isinstance(currency, str):
        raise DomainError(f"malformed money payload {raw!r}")
    return Money(Decimal(amount), Currency(currency))


def encode_optional_money(money: Money | None) -> JsonValue:
    return None if money is None else encode_money(money)


def decode_optional_money(raw: JsonValue) -> Money | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise DomainError(f"malformed money payload {raw!r}")
    return decode_money(raw)


def encode_order_request(request: OrderRequest) -> dict[str, JsonValue]:
    return {
        "client_order_id": request.client_order_id.value,
        "trading_client": request.trading_client.value,
        "instrument": request.instrument.value,
        "side": request.side.value,
        "quantity": request.quantity,
        "order_type": request.order_type.value,
        "product": request.product.value,
        "price": encode_optional_money(request.price),
        "trigger_price": encode_optional_money(request.trigger_price),
        "tag": request.tag,
    }


def _text(raw: Payload, key: str) -> str:
    value = raw[key]
    if not isinstance(value, str):
        raise DomainError(f"expected a string at {key!r}, got {value!r}")
    return value


def _integer(raw: Payload, key: str) -> int:
    value = raw[key]
    if not isinstance(value, int) or isinstance(value, bool):
        raise DomainError(f"expected an integer at {key!r}, got {value!r}")
    return value


def decode_order_request(raw: Payload) -> OrderRequest:
    tag = raw.get("tag")
    return OrderRequest(
        client_order_id=ClientOrderId(_text(raw, "client_order_id")),
        trading_client=TradingClientId(_text(raw, "trading_client")),
        instrument=InstrumentId(_text(raw, "instrument")),
        side=Side(_text(raw, "side")),
        quantity=_integer(raw, "quantity"),
        order_type=OrderType(_text(raw, "order_type")),
        product=ProductType(_text(raw, "product")),
        price=decode_optional_money(raw["price"]),
        trigger_price=decode_optional_money(raw["trigger_price"]),
        tag=tag if isinstance(tag, str) else None,
    )


def encode_fill(fill: Fill) -> dict[str, JsonValue]:
    return {
        "client_order_id": fill.client_order_id.value,
        "instrument": fill.instrument.value,
        "side": fill.side.value,
        "quantity": fill.quantity,
        "price": encode_money(fill.price),
        "timestamp": fill.timestamp.isoformat(),
        "broker_fill_id": fill.broker_fill_id,
    }


def decode_fill(raw: Payload) -> Fill:
    broker_fill_id = raw.get("broker_fill_id")
    price = raw["price"]
    if not isinstance(price, dict):
        raise DomainError(f"malformed fill price {price!r}")
    return Fill(
        client_order_id=ClientOrderId(_text(raw, "client_order_id")),
        instrument=InstrumentId(_text(raw, "instrument")),
        side=Side(_text(raw, "side")),
        quantity=_integer(raw, "quantity"),
        price=decode_money(price),
        timestamp=datetime.fromisoformat(_text(raw, "timestamp")),
        broker_fill_id=broker_fill_id if isinstance(broker_fill_id, str) else None,
    )


# ---------------------------------------------------------------------------
# The event
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class JournalEvent:
    """One append-only record of something that happened."""

    event_type: EventType
    aggregate_type: AggregateType
    aggregate_id: str
    occurred_at: datetime
    trading_day: date
    actor: Actor
    payload: Payload = field(default_factory=dict)
    #: Ties an intent to its order, its fills and its exit, so a decision can
    #: be reconstructed end to end.
    correlation_id: str | None = None
    #: Assigned by the store on append. None before it has been written.
    sequence: int | None = None

    def __post_init__(self) -> None:
        require_aware(self.occurred_at)
        if not self.aggregate_id:
            raise DomainError(f"{self.event_type}: an event needs an aggregate id")
        object.__setattr__(self, "payload", MappingProxyType(dict(self.payload)))

    def with_sequence(self, sequence: int) -> JournalEvent:
        if sequence < 1:
            raise DomainError(f"journal sequence {sequence} must be positive")
        return JournalEvent(
            event_type=self.event_type,
            aggregate_type=self.aggregate_type,
            aggregate_id=self.aggregate_id,
            occurred_at=self.occurred_at,
            trading_day=self.trading_day,
            actor=self.actor,
            payload=self.payload,
            correlation_id=self.correlation_id,
            sequence=sequence,
        )


# ---------------------------------------------------------------------------
# Builders — the only supported way to create an event, so the payload shape
# and the event type can never disagree.
# ---------------------------------------------------------------------------


def order_placed(
    request: OrderRequest,
    *,
    occurred_at: datetime,
    trading_day: date,
    correlation_id: str | None = None,
) -> JournalEvent:
    return JournalEvent(
        event_type=EventType.ORDER_PLACED,
        aggregate_type=AggregateType.ORDER,
        aggregate_id=request.client_order_id.value,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=Actor.ENGINE,
        payload=encode_order_request(request),
        correlation_id=correlation_id,
    )


def order_accepted(
    client_order_id: ClientOrderId,
    broker_order_id: BrokerOrderId,
    *,
    occurred_at: datetime,
    trading_day: date,
    correlation_id: str | None = None,
) -> JournalEvent:
    return JournalEvent(
        event_type=EventType.ORDER_ACCEPTED,
        aggregate_type=AggregateType.ORDER,
        aggregate_id=client_order_id.value,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=Actor.BROKER,
        payload={"broker_order_id": broker_order_id.value},
        correlation_id=correlation_id,
    )


def order_rejected(
    client_order_id: ClientOrderId,
    reason: str,
    *,
    occurred_at: datetime,
    trading_day: date,
    correlation_id: str | None = None,
) -> JournalEvent:
    return JournalEvent(
        event_type=EventType.ORDER_REJECTED,
        aggregate_type=AggregateType.ORDER,
        aggregate_id=client_order_id.value,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=Actor.BROKER,
        payload={"reason": reason},
        correlation_id=correlation_id,
    )


def order_terminal(
    client_order_id: ClientOrderId,
    status: OrderStatus,
    *,
    occurred_at: datetime,
    trading_day: date,
    actor: Actor = Actor.BROKER,
    correlation_id: str | None = None,
) -> JournalEvent:
    """Cancelled or expired — a terminal state carrying no other detail."""
    mapping = {
        OrderStatus.CANCELLED: EventType.ORDER_CANCELLED,
        OrderStatus.EXPIRED: EventType.ORDER_EXPIRED,
        OrderStatus.UNKNOWN: EventType.ORDER_STATE_UNKNOWN,
    }
    if status not in mapping:
        raise DomainError(f"{status} is not a journalled terminal order state")
    return JournalEvent(
        event_type=mapping[status],
        aggregate_type=AggregateType.ORDER,
        aggregate_id=client_order_id.value,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=actor,
        payload={"status": status.value},
        correlation_id=correlation_id,
    )


def order_filled(
    fill: Fill,
    *,
    trading_day: date,
    correlation_id: str | None = None,
) -> JournalEvent:
    return JournalEvent(
        event_type=EventType.ORDER_FILLED,
        aggregate_type=AggregateType.ORDER,
        aggregate_id=fill.client_order_id.value,
        occurred_at=fill.timestamp,
        trading_day=trading_day,
        actor=Actor.BROKER,
        payload=encode_fill(fill),
        correlation_id=correlation_id,
    )


def phase_completed(
    exchange: str,
    phase: str,
    *,
    occurred_at: datetime,
    trading_day: date,
    duration_ms: int | None = None,
) -> JournalEvent:
    """One venue finished one phase of one day.

    The journal is the record of what has run, so a restart reads it rather
    than trusting memory. The reference engine keeps the equivalent flag in a
    field, and restarting after end-of-day therefore repeats end-of-day.
    """
    payload: dict[str, JsonValue] = {"phase": phase}
    if duration_ms is not None:
        payload["duration_ms"] = duration_ms
    return JournalEvent(
        event_type=EventType.PHASE_COMPLETED,
        aggregate_type=AggregateType.SYSTEM,
        aggregate_id=exchange,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=Actor.SCHEDULER,
        payload=payload,
    )


def phase_failed(
    exchange: str,
    phase: str,
    reason: str,
    *,
    occurred_at: datetime,
    trading_day: date,
) -> JournalEvent:
    """A phase raised. Recorded, and deliberately not marked complete, so the
    next reconciliation tries it again."""
    return JournalEvent(
        event_type=EventType.PHASE_FAILED,
        aggregate_type=AggregateType.SYSTEM,
        aggregate_id=exchange,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=Actor.SCHEDULER,
        payload={"phase": phase, "reason": reason},
    )


def trading_halted(
    reason: str,
    *,
    occurred_at: datetime,
    trading_day: date,
    actor: Actor = Actor.ENGINE,
    scope: str = "SYSTEM",
) -> JournalEvent:
    return JournalEvent(
        event_type=EventType.TRADING_HALTED,
        aggregate_type=AggregateType.SYSTEM,
        aggregate_id=scope,
        occurred_at=occurred_at,
        trading_day=trading_day,
        actor=actor,
        payload={"reason": reason},
    )
