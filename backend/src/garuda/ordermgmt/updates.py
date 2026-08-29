"""Folding pushed order updates into the order book.

A broker's push channel is fast and unreliable in a specific way: frames
arrive out of order, are duplicated, and are occasionally dropped entirely.
Three rules, all ported from the reference engine, are what make it safe to
act on anyway.

**A terminal order is frozen.** Once an order is filled, cancelled or
rejected, a later frame saying otherwise is stale by definition -- there is no
transition out of terminal, so the only thing a "still open" frame can mean is
that it was overtaken in flight.

**A fill never regresses.** Brokers report the filled quantity cumulatively.
A frame reporting less than the engine already recorded is an old frame, not
an execution being undone; treating it as the truth would un-fill a real
position and leave the engine short of what it actually holds.

**An update belongs to the client id it names.** Under a dealer session one
stream carries several accounts, and routing by the stream's owner applies one
account's fills to another. An id that matches no configured client is
reported loudly rather than dropped: those orders are executing and nothing is
watching them.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime

from garuda.domain.client import TradingClientId
from garuda.domain.order import Fill, Order, OrderRequest
from garuda.protocols.account import OrderUpdate

logger = logging.getLogger(__name__)

#: Resolves the broker's own account id to a trading client. Returns None when
#: nothing matches, which is a misconfiguration and not a routine miss.
type ClientResolver = Callable[[str], TradingClientId | None]


@dataclass(frozen=True, slots=True)
class Applied:
    """What one update did to the book."""

    order: Order | None = None
    fill: Fill | None = None
    #: Why nothing happened, when nothing did.
    ignored: str | None = None
    #: Set when the update named an account the engine does not know.
    unmapped_client_id: str | None = None

    @property
    def changed(self) -> bool:
        return self.order is not None


class OrderUpdateRouter:
    """Applies pushed updates to the right client's order book."""

    def __init__(
        self,
        resolve_client: ClientResolver,
        books: Mapping[TradingClientId, Callable[[], Mapping[str, Order]]],
    ) -> None:
        self._resolve_client = resolve_client
        self._books = books

    def route(self, update: OrderUpdate, arrived_on: TradingClientId) -> TradingClientId | None:
        """Whose book this belongs to.

        The stream's owner is the fallback, not the answer: a broker that names
        the account on the frame is telling us something the connection cannot.
        """
        if not update.broker_client_id:
            return arrived_on
        resolved = self._resolve_client(update.broker_client_id)
        if resolved is None:
            logger.error(
                "order update for broker account %r arrived on %s but matches no trading "
                "client; orders for that account are executing unwatched",
                update.broker_client_id,
                arrived_on,
            )
            return None
        return resolved


def apply_update(order: Order, update: OrderUpdate, at: datetime) -> Applied:
    """Fold one update into one order, or explain why it was ignored."""
    if order.is_terminal:
        return Applied(ignored=f"{order.id} is already {order.status}")

    if update.filled_quantity < order.filled_quantity:
        return Applied(
            ignored=(
                f"{order.id}: a frame reporting {update.filled_quantity} filled arrived after "
                f"{order.filled_quantity}; an old frame, not an execution undone"
            )
        )

    updated = order
    fill: Fill | None = None
    delta = update.filled_quantity - order.filled_quantity
    if delta > 0:
        if update.average_price is None:
            return Applied(ignored=f"{order.id}: {delta} more filled but the broker sent no price")
        fill = _fill_for(order.request, update, delta, at)
        updated = updated.apply_fill(fill)

    status = update.status
    if status is not None and status is not updated.status:
        if updated.can_transition_to(status):
            updated = updated.transition_to(status, reason=update.message)
        else:
            # A fill already moved it further than this frame knows about.
            # The frame is behind, and the book is not rolled back to match it.
            logger.info(
                "%s: ignoring a %s frame; the order is already %s",
                order.id,
                status,
                updated.status,
            )

    if updated is order and fill is None:
        return Applied(ignored=f"{order.id}: nothing in the update changed anything")
    return Applied(order=updated, fill=fill)


def _fill_for(request: OrderRequest, update: OrderUpdate, delta: int, at: datetime) -> Fill:
    """The execution implied by a cumulative quantity going up.

    The price is the broker's running average rather than the price of this
    slice, which nobody reports. Over a sliced entry that is the same number:
    the engine's own weighted average of the slices converges on it.
    """
    assert update.average_price is not None
    return Fill(
        client_order_id=request.client_order_id,
        instrument=request.instrument,
        side=request.side,
        quantity=delta,
        price=update.average_price,
        timestamp=update.at or at,
        broker_fill_id=f"{update.broker_order_id}-{update.filled_quantity}",
    )
