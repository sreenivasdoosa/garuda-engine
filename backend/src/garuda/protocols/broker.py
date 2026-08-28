"""The broker adapter contract.

Every venue-specific concern lives behind this. The engine never sees a broker
symbol, a broker status string or a broker error code -- adapters translate in
both directions at their own boundary.

The obligations are as binding as the signatures, and the contract test suite
checks them:

* **Idempotency.** Orders carry an engine-generated ``ClientOrderId``. A retry
  after a timeout sends the same id, so a broker that already accepted the
  first attempt rejects the duplicate rather than placing a second order.
* **A closed error taxonomy.** Broker errors normalise to the exceptions below.
  A caller decides what to do from the type, never by matching a message.
* **Reconnect and rate limiting are the adapter's own business**, and it emits
  ``Disconnected`` whenever it is unsure.
* **Never invent state.** If the adapter does not know, it says ``UNKNOWN``.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Protocol, runtime_checkable

from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.money import Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, Fill, OrderRequest, Side


class LoginStyle(StrEnum):
    """Where a broker's login actually happens.

    This decides whether login traffic is routed through the account's
    whitelisted address, and it is a property of the broker rather than a
    policy the engine can choose.
    """

    #: The operator's browser completes the login and the broker redirects back
    #: with a token this process exchanges. The exchange is not gated on source
    #: address, and the browser step could not be routed anyway.
    BROWSER_OAUTH = "BROWSER_OAUTH"

    #: This process posts an API key and secret and gets a session back. It is
    #: a server-side call like any other, so it is whitelisted like any other
    #: and must originate from the same address the trading APIs do.
    SERVER_CREDENTIALS = "SERVER_CREDENTIALS"

    @property
    def is_proxied(self) -> bool:
        return self is LoginStyle.SERVER_CREDENTIALS


# ---------------------------------------------------------------------------
# Errors — the closed taxonomy every adapter normalises into
# ---------------------------------------------------------------------------


class BrokerError(DomainError):
    """Base for anything a broker refused or could not do."""


class RetryableBrokerError(BrokerError):
    """A transient failure. The same request may be sent again, same id."""


class OrderRejectedError(BrokerError):
    """The broker refused the order outright. Retrying will not help."""


class AuthExpiredError(BrokerError):
    """The session is no longer valid.

    Trading halts for that client and stays halted. Nothing re-authenticates
    on its own -- login is operator-initiated, always.
    """


class RateLimitedError(RetryableBrokerError):
    """Too many requests. The adapter owns its own backoff."""


class FatalBrokerError(BrokerError):
    """Something the engine cannot reason about. Halt and alert."""


# ---------------------------------------------------------------------------
# Events — a closed union
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OrderAccepted:
    client_order_id: ClientOrderId
    broker_order_id: BrokerOrderId
    at: datetime


@dataclass(frozen=True, slots=True)
class OrderRejected:
    client_order_id: ClientOrderId
    reason: str
    at: datetime


@dataclass(frozen=True, slots=True)
class OrderCancelled:
    client_order_id: ClientOrderId
    at: datetime


@dataclass(frozen=True, slots=True)
class OrderFilled:
    fill: Fill


@dataclass(frozen=True, slots=True)
class Assignment:
    """An inbound position change the engine did not initiate.

    Present from day one although every NSE option is European and this will
    never fire for a v1 adapter. American-style exercise makes it routine, and
    bolting it on later means reworking the position book.
    """

    trading_client: TradingClientId
    instrument: InstrumentId
    quantity: int
    at: datetime


@dataclass(frozen=True, slots=True)
class MarginCall:
    trading_client: TradingClientId
    shortfall: Money
    at: datetime


@dataclass(frozen=True, slots=True)
class Disconnected:
    """Emitted whenever the adapter is unsure of the truth."""

    reason: str
    at: datetime


@dataclass(frozen=True, slots=True)
class Resynced:
    """The adapter has re-established a state it trusts."""

    at: datetime


type BrokerEvent = (
    OrderAccepted
    | OrderRejected
    | OrderCancelled
    | OrderFilled
    | Assignment
    | MarginCall
    | Disconnected
    | Resynced
)


# ---------------------------------------------------------------------------
# Broker-reported state
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class BrokerOrder:
    """An order as the broker describes it, already normalised."""

    broker_order_id: BrokerOrderId
    client_order_id: ClientOrderId | None
    instrument: InstrumentId
    side: Side
    quantity: int
    filled_quantity: int
    status: OrderStatus
    product: ProductType
    average_price: Money | None = None


@dataclass(frozen=True, slots=True)
class BrokerPosition:
    """A position as the broker reports it. The source of truth."""

    instrument: InstrumentId
    quantity: int
    average_price: Money
    product: ProductType
    multiplier: Decimal = Decimal(1)


@dataclass(frozen=True, slots=True)
class Funds:
    available: Money
    used: Money
    total: Money


@dataclass(frozen=True, slots=True)
class OrderChanges:
    """A modification. Anything left None is unchanged."""

    quantity: int | None = None
    price: Money | None = None
    trigger_price: Money | None = None


# ---------------------------------------------------------------------------
# The contract
# ---------------------------------------------------------------------------


@runtime_checkable
class BrokerAdapter(Protocol):
    """What every broker, and the paper broker, must implement."""

    @property
    def trading_client(self) -> TradingClientId: ...

    @property
    def login_style(self) -> LoginStyle:
        """Whether this broker's login is a server-side call. See LoginStyle."""
        ...

    async def place(self, request: OrderRequest) -> BrokerOrderId: ...

    async def modify(self, broker_order_id: BrokerOrderId, changes: OrderChanges) -> None: ...

    async def cancel(self, broker_order_id: BrokerOrderId) -> None: ...

    async def fetch_orders(self) -> Sequence[BrokerOrder]: ...

    async def fetch_positions(self) -> Sequence[BrokerPosition]: ...

    async def fetch_funds(self) -> Funds: ...

    async def fetch_instruments(self) -> Sequence[Instrument]: ...

    def events(self) -> AsyncIterator[BrokerEvent]: ...
