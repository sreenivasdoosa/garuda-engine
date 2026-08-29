"""The account stream contract: order and position updates, pushed.

One stream per trading client, on that client's own session, because an order
update is only visible to the account that placed the order. This is separate
from the market data feed even where a broker delivers both over one endpoint
-- they have different lifetimes, different credentials and different failure
consequences, and a tick that stops arriving is not an order that stops
arriving.

**An update belongs to the client id it names, not to the stream it arrived
on.** A dealer terminal issues one session covering several client ids, so one
stream carries updates for accounts that are not its owner. Routing by the
owner silently applies one account's fills to another.

The stream is never the only source of truth. Frames are dropped, sockets
stall, and a broker that pushes updates still has an order book to poll; the
reconciler's poll is the backstop and this is the low-latency path.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Protocol, runtime_checkable

from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus, ProductType
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, Side


@dataclass(frozen=True, slots=True)
class OrderUpdate:
    """An order as the broker now sees it.

    ``filled_quantity`` is **cumulative**, which is how brokers report it and
    not how the engine's order book accumulates. Converting one to the other is
    where a stale frame gets caught: a cumulative quantity lower than what the
    engine already recorded is an out-of-order frame, never an un-fill.

    ``status`` is None when the broker sent none. That means no news, and the
    order keeps the state it had.
    """

    broker_order_id: BrokerOrderId
    #: Who this belongs to, as the broker names it -- the account id on the
    #: payload, which under a dealer session is not the stream's owner.
    broker_client_id: str
    client_order_id: ClientOrderId | None
    instrument: InstrumentId | None
    side: Side
    quantity: int
    filled_quantity: int
    status: OrderStatus | None
    product: ProductType | None = None
    average_price: Money | None = None
    message: str | None = None
    at: datetime | None = None


@dataclass(frozen=True, slots=True)
class PositionUpdate:
    """A position as the broker now sees it.

    Not every broker pushes these. Zerodha does not, and a poll is the only
    way to see a position move there.
    """

    broker_client_id: str
    instrument: InstrumentId
    quantity: int
    average_price: Money
    product: ProductType
    multiplier: Decimal = Decimal(1)


@dataclass(frozen=True, slots=True)
class AccountConnected:
    trading_client: TradingClientId
    at: datetime


@dataclass(frozen=True, slots=True)
class AccountDisconnected:
    trading_client: TradingClientId
    reason: str
    at: datetime


@dataclass(frozen=True, slots=True)
class AccountProblem:
    """Something arrived that could not be understood.

    Not a disconnection. Reported rather than swallowed, because a stream
    quietly dropping one account's updates looks exactly like an account that
    is not trading.
    """

    trading_client: TradingClientId
    detail: str
    at: datetime


type AccountEvent = (
    OrderUpdate | PositionUpdate | AccountConnected | AccountDisconnected | AccountProblem
)


@runtime_checkable
class AccountStream(Protocol):
    """One trading client's push channel for order and position updates."""

    @property
    def trading_client(self) -> TradingClientId: ...

    @property
    def is_connected(self) -> bool: ...

    async def connect(self) -> None: ...

    async def close(self) -> None: ...

    def events(self) -> AsyncIterator[AccountEvent]: ...
