"""The order manager.

Owns the order book and every transition in it. Nothing else places, cancels
or mutates an order.

Two rules shape the design:

* **Journal before sending.** The intent to place is recorded before the
  request leaves the process, so a crash between the two leaves evidence.
  Startup reconciliation then finds an order the engine journalled and the
  broker may or may not have, which is a question that can be answered -- an
  order sent with no record of it is not.
* **A retry reuses the client order id.** Retrying with a fresh id is how one
  intent becomes two positions.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime

from garuda.core.bus import InProcessEventBus
from garuda.domain.enums import OrderStatus
from garuda.domain.errors import DomainError
from garuda.domain.journal import (
    JournalEvent,
    order_accepted,
    order_filled,
    order_placed,
    order_rejected,
    order_terminal,
)
from garuda.domain.order import BrokerOrderId, ClientOrderId, Order, OrderRequest
from garuda.ordermgmt.protection import MarketProtection
from garuda.protocols.broker import (
    BrokerAdapter,
    BrokerEvent,
    OrderAccepted,
    OrderCancelled,
    OrderFilled,
    OrderRejected,
    OrderRejectedError,
    RetryableBrokerError,
)
from garuda.protocols.clock import Clock
from garuda.protocols.topics import Topic

#: Appends journal events inside the caller's transaction and returns them with
#: their sequence numbers. The order manager does not own transactions; it is
#: handed the means to write into one.
type JournalAppender = Callable[[Sequence[JournalEvent]], Awaitable[Sequence[JournalEvent]]]

logger = logging.getLogger(__name__)


class OrderManagerError(DomainError):
    """The order manager was asked for something it cannot do."""


@dataclass(frozen=True, slots=True)
class PlacementResult:
    order: Order
    attempts: int
    #: What the broker calls the order, when it said so on placement. Most
    #: brokers answer with it, and discarding that answer would mean waiting
    #: for an acknowledgement event to learn something already known -- which
    #: leaves a window where a fill cannot be matched to its trade.
    #: None when the placement failed or the broker answered with nothing.
    broker_order_id: BrokerOrderId | None = None


class OrderManager:
    """Places orders, tracks them, and folds broker events back into them."""

    def __init__(
        self,
        adapter: BrokerAdapter,
        clock: Clock,
        bus: InProcessEventBus,
        journal: JournalAppender,
        trading_day_for: Callable[[datetime], date],
        *,
        max_retries: int = 2,
        protection: MarketProtection | None = None,
    ) -> None:
        self._adapter = adapter
        self._clock = clock
        self._bus = bus
        self._journal = journal
        self._trading_day_for = trading_day_for
        self._max_retries = max_retries
        self._protection = protection
        self._orders: dict[ClientOrderId, Order] = {}
        self._by_broker_id: dict[str, ClientOrderId] = {}

    # -- recovery -----------------------------------------------------------

    def restore(self, orders: Mapping[ClientOrderId, Order]) -> None:
        """Rebuild the book from a folded journal, after a restart.

        The journal is written before anything is sent, so it holds every
        order the engine ever intended -- including ones whose fate is unknown
        because the process died between journalling and sending. Those come
        back as PENDING_NEW and are exactly what reconciliation must resolve
        against broker truth before trading resumes.

        Nothing is journalled here. Recovery reads history; it does not add to
        it.
        """
        if self._orders:
            raise OrderManagerError("the order book is not empty; restore runs once, at startup")
        self._orders = dict(orders)
        self._by_broker_id = {
            order.broker_order_id.value: order_id
            for order_id, order in orders.items()
            if order.broker_order_id is not None
        }

    @property
    def unconfirmed_orders(self) -> Mapping[ClientOrderId, Order]:
        """Orders journalled but never acknowledged.

        After a restart these are the dangerous ones: the engine recorded the
        intent, and whether the broker has it is unknown. Reconciliation
        answers that; until it does, trading does not resume.
        """
        return {
            order_id: order
            for order_id, order in self._orders.items()
            if order.status is OrderStatus.PENDING_NEW
        }

    # -- the book -----------------------------------------------------------

    @property
    def orders(self) -> Mapping[ClientOrderId, Order]:
        return dict(self._orders)

    def order(self, client_order_id: ClientOrderId) -> Order | None:
        return self._orders.get(client_order_id)

    @property
    def working_orders(self) -> Mapping[ClientOrderId, Order]:
        return {oid: order for oid, order in self._orders.items() if not order.is_terminal}

    # -- placing ------------------------------------------------------------

    async def place(self, request: OrderRequest) -> PlacementResult:
        """Journal the intent, then send it, retrying with the same id."""
        if request.client_order_id in self._orders:
            raise OrderManagerError(
                f"{request.client_order_id}: already placed; a retry must reuse the "
                "request, not create a new one"
            )

        if self._protection is not None:
            # Before the journal, so what is recorded is what was sent. A
            # journal holding the MARKET order the engine wanted rather than
            # the LIMIT it actually placed would replay to a different fill.
            protected = self._protection.apply(request)
            if protected.was_changed:
                logger.info("%s: %s", request.client_order_id, protected.change)
                request = protected.request

        now = self._clock.now()
        trading_day = self._trading_day_for(now)
        order = Order(request=request)
        self._orders[request.client_order_id] = order

        await self._append(order_placed(request, occurred_at=now, trading_day=trading_day))
        await self._bus.publish(Topic.ORDERS, order)

        attempts = 0
        broker_order_id: BrokerOrderId | None = None
        last_error: RetryableBrokerError | None = None
        while attempts <= self._max_retries:
            attempts += 1
            try:
                broker_order_id = await self._adapter.place(request)
            except RetryableBrokerError as error:
                # Retry with the same request, and therefore the same client
                # order id. A fresh id is how one intent becomes two positions.
                last_error = error
                continue
            except OrderRejectedError as error:
                await self._reject(request.client_order_id, str(error))
            return self._result(request.client_order_id, attempts, broker_order_id)

        await self._reject(
            request.client_order_id,
            f"gave up after {attempts} attempts: {last_error}",
        )
        return self._result(request.client_order_id, attempts)

    def _result(
        self,
        client_order_id: ClientOrderId,
        attempts: int,
        broker_order_id: BrokerOrderId | None = None,
    ) -> PlacementResult:
        return PlacementResult(
            order=self._orders[client_order_id],
            attempts=attempts,
            broker_order_id=broker_order_id,
        )

    async def cancel(self, client_order_id: ClientOrderId) -> None:
        order = self._require(client_order_id)
        if order.is_terminal:
            raise OrderManagerError(f"{client_order_id}: already {order.status}")
        if order.broker_order_id is None:
            raise OrderManagerError(
                f"{client_order_id}: not yet acknowledged, so there is nothing to cancel"
            )
        await self._adapter.cancel(order.broker_order_id)

    # -- broker events ------------------------------------------------------

    async def handle(self, event: BrokerEvent) -> None:
        """Fold one broker event into the book, journalling as it goes."""
        now = self._clock.now()
        trading_day = self._trading_day_for(now)

        if isinstance(event, OrderAccepted):
            order = self._require(event.client_order_id).accepted(event.broker_order_id)
            self._orders[event.client_order_id] = order
            self._by_broker_id[event.broker_order_id.value] = event.client_order_id
            await self._append(
                order_accepted(
                    event.client_order_id,
                    event.broker_order_id,
                    occurred_at=event.at,
                    trading_day=trading_day,
                )
            )
            await self._bus.publish(Topic.ORDERS, order)

        elif isinstance(event, OrderRejected):
            await self._reject(event.client_order_id, event.reason, at=event.at)

        elif isinstance(event, OrderCancelled):
            order = self._require(event.client_order_id).transition_to(OrderStatus.CANCELLED)
            self._orders[event.client_order_id] = order
            await self._append(
                order_terminal(
                    event.client_order_id,
                    OrderStatus.CANCELLED,
                    occurred_at=event.at,
                    trading_day=trading_day,
                )
            )
            await self._bus.publish(Topic.ORDERS, order)

        elif isinstance(event, OrderFilled):
            order = self._require(event.fill.client_order_id).apply_fill(event.fill)
            self._orders[event.fill.client_order_id] = order
            await self._append(order_filled(event.fill, trading_day=trading_day))
            await self._bus.publish(Topic.FILLS, event.fill)
            await self._bus.publish(Topic.ORDERS, order)

        # Assignment, MarginCall, Disconnected and Resynced are not the order
        # book's business. They are handled by reconciliation and the risk
        # gate, which is why this is not an exhaustive match.

    # -- internals ----------------------------------------------------------

    async def _reject(
        self, client_order_id: ClientOrderId, reason: str, at: datetime | None = None
    ) -> None:
        occurred_at = at or self._clock.now()
        order = self._require(client_order_id).transition_to(OrderStatus.REJECTED, reason=reason)
        self._orders[client_order_id] = order
        await self._append(
            order_rejected(
                client_order_id,
                reason,
                occurred_at=occurred_at,
                trading_day=self._trading_day_for(occurred_at),
            )
        )
        await self._bus.publish(Topic.ORDERS, order)

    async def _append(self, event: JournalEvent) -> None:
        await self._journal([event])

    def _require(self, client_order_id: ClientOrderId) -> Order:
        order = self._orders.get(client_order_id)
        if order is None:
            raise OrderManagerError(f"{client_order_id}: not in the order book")
        return order
