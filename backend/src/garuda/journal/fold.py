"""Folding a journal back into state.

This is what makes the journal worth keeping. Replaying a day's events through
:func:`fold` reproduces the orders and positions that produced them, which
gives three things from one mechanism: crash recovery, an audit trail, and a
regression harness that catches a refactor quietly changing an exit decision.

The relational tables stay authoritative for reads. On startup the engine folds
the journal, compares, and **halts on any mismatch** -- it never auto-corrects.
A divergence is either a bug or a missed fill, and both are worse if traded
through.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from decimal import Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.journal import (
    EventType,
    JournalEvent,
    decode_fill,
    decode_order_request,
)
from garuda.domain.money import Currency
from garuda.domain.order import BrokerOrderId, ClientOrderId, Order
from garuda.domain.position import Position


class JournalFoldError(DomainError):
    """The journal describes something that cannot have happened."""


@dataclass(frozen=True, slots=True)
class PositionKey:
    """Positions are per account, not per instrument.

    The same option held on two trading clients is two positions, and netting
    them would report a flat book while both accounts carry real risk.
    """

    trading_client: TradingClientId
    instrument: InstrumentId


@dataclass(frozen=True, slots=True)
class PositionBasis:
    """What the fold needs to know about an instrument to value a position."""

    currency: Currency
    multiplier: Decimal = Decimal(1)


@dataclass(frozen=True)
class FoldedState:
    """Everything a replay reconstructs."""

    orders: Mapping[ClientOrderId, Order] = field(default_factory=dict)
    positions: Mapping[PositionKey, Position] = field(default_factory=dict)
    halted: bool = False
    halt_reason: str | None = None
    last_sequence: int = 0

    def position(self, key: PositionKey) -> Position | None:
        return self.positions.get(key)

    @property
    def open_orders(self) -> Mapping[ClientOrderId, Order]:
        return {oid: o for oid, o in self.orders.items() if not o.is_terminal}


def fold(
    events: Iterable[JournalEvent],
    bases: Mapping[InstrumentId, PositionBasis],
) -> FoldedState:
    """Replay events into orders and positions.

    ``bases`` supplies each instrument's currency and contract multiplier. An
    event referring to an instrument that is not there is an error rather than
    a default: valuing a position with a guessed multiplier produces a P&L that
    looks plausible and is wrong.
    """
    orders: dict[ClientOrderId, Order] = {}
    positions: dict[PositionKey, Position] = {}
    #: Fills do not carry the account; the order they belong to does.
    order_clients: dict[ClientOrderId, TradingClientId] = {}
    halted = False
    halt_reason: str | None = None
    last_sequence = 0

    for event in events:
        if event.sequence is not None:
            if event.sequence <= last_sequence:
                raise JournalFoldError(
                    f"journal is out of order: sequence {event.sequence} followed {last_sequence}"
                )
            last_sequence = event.sequence

        if event.event_type is EventType.ORDER_PLACED:
            request = decode_order_request(event.payload)
            order_id = request.client_order_id
            if order_id in orders:
                raise JournalFoldError(f"{order_id}: placed twice in one journal")
            orders[order_id] = Order(request=request)
            order_clients[order_id] = request.trading_client

        elif event.event_type is EventType.ORDER_ACCEPTED:
            order_id = ClientOrderId(event.aggregate_id)
            broker_id = event.payload["broker_order_id"]
            if not isinstance(broker_id, str):
                raise JournalFoldError(f"{order_id}: malformed broker order id")
            orders[order_id] = _existing(orders, order_id).accepted(BrokerOrderId(broker_id))

        elif event.event_type is EventType.ORDER_REJECTED:
            order_id = ClientOrderId(event.aggregate_id)
            reason = event.payload.get("reason")
            orders[order_id] = _existing(orders, order_id).transition_to(
                OrderStatus.REJECTED, reason=reason if isinstance(reason, str) else None
            )

        elif event.event_type in _TERMINAL_EVENTS:
            order_id = ClientOrderId(event.aggregate_id)
            orders[order_id] = _existing(orders, order_id).transition_to(
                _TERMINAL_EVENTS[event.event_type]
            )

        elif event.event_type is EventType.ORDER_FILLED:
            fill = decode_fill(event.payload)
            order_id = fill.client_order_id
            orders[order_id] = _existing(orders, order_id).apply_fill(fill)

            client = order_clients.get(order_id)
            if client is None:
                raise JournalFoldError(f"{order_id}: filled without ever having been placed")
            key = PositionKey(client, fill.instrument)
            basis = bases.get(fill.instrument)
            if basis is None:
                raise JournalFoldError(
                    f"{fill.instrument}: no currency or multiplier available; "
                    "a guessed multiplier produces a plausible, wrong P&L"
                )
            current = positions.get(key) or Position.flat(
                fill.instrument, basis.currency, basis.multiplier
            )
            positions[key] = current.apply(fill)

        elif event.event_type is EventType.TRADING_HALTED:
            halted = True
            reason = event.payload.get("reason")
            halt_reason = reason if isinstance(reason, str) else None

        elif event.event_type is EventType.TRADING_RESUMED:
            halted = False
            halt_reason = None

        elif event.event_type is EventType.RECONCILIATION_MISMATCH:
            continue  # recorded for the audit trail; it changes no state

        else:  # pragma: no cover - the union above is closed
            raise JournalFoldError(f"{event.event_type} is not foldable")

    return FoldedState(
        orders=orders,
        positions=positions,
        halted=halted,
        halt_reason=halt_reason,
        last_sequence=last_sequence,
    )


_TERMINAL_EVENTS = {
    EventType.ORDER_CANCELLED: OrderStatus.CANCELLED,
    EventType.ORDER_EXPIRED: OrderStatus.EXPIRED,
    EventType.ORDER_STATE_UNKNOWN: OrderStatus.UNKNOWN,
}


def _existing(orders: Mapping[ClientOrderId, Order], order_id: ClientOrderId) -> Order:
    order = orders.get(order_id)
    if order is None:
        raise JournalFoldError(f"{order_id}: referenced before it was placed")
    return order


# ---------------------------------------------------------------------------
# Reconciliation
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PositionMismatch:
    key: PositionKey
    folded: Position | None
    stored: Position | None

    def __str__(self) -> str:
        return (
            f"{self.key.trading_client}/{self.key.instrument}: "
            f"journal says {self.folded}, tables say {self.stored}"
        )


def compare_positions(
    folded: Mapping[PositionKey, Position],
    stored: Mapping[PositionKey, Position],
) -> list[PositionMismatch]:
    """Diff a folded journal against the authoritative tables.

    A non-empty result means halt and alert. It never means correct one side
    from the other: a reconciliation break is almost always a bug or a missed
    fill, and both are worse if traded through.

    Flat positions on one side and absent on the other are the same thing, and
    are not a mismatch.
    """
    mismatches: list[PositionMismatch] = []
    for key in sorted(
        set(folded) | set(stored),
        key=lambda k: (k.trading_client.value, k.instrument.value),
    ):
        left = folded.get(key)
        right = stored.get(key)
        if _equivalent(left, right):
            continue
        mismatches.append(PositionMismatch(key=key, folded=left, stored=right))
    return mismatches


def _equivalent(left: Position | None, right: Position | None) -> bool:
    if left is None and right is None:
        return True
    if left is None:
        return right is not None and right.is_flat
    if right is None:
        return left.is_flat
    return (
        left.quantity == right.quantity
        and left.average_price == right.average_price
        and left.realized_pnl == right.realized_pnl
    )
