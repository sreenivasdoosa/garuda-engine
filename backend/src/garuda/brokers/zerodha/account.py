"""Zerodha's order update stream.

Kite pushes order updates over the same endpoint the ticks come on, as JSON
text frames. This is a **second connection on the same URL**, with that
trading client's own token and subscribed to no instruments at all: the tick
feed uses one designated account's session, order updates need each account's
own, and giving them one connection would tie the two lifetimes together for
no reason.

Kite does not push position updates. There is no equivalent frame, so a
position move is only visible to a poll -- which is why the reconciler polls
rather than treating the stream as complete.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable
from decimal import Decimal, InvalidOperation
from typing import Any

from garuda.brokers.websocket import Connector, WebSocketConnection
from garuda.brokers.zerodha.mapping import product_from_kite, side_from_kite, status_from_kite
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.money import Currency, Money
from garuda.domain.order import BrokerOrderId, ClientOrderId
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.account import (
    AccountConnected,
    AccountDisconnected,
    AccountEvent,
    AccountProblem,
    OrderUpdate,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

KITE_FEED_URL = "wss://ws.kite.trade"


class ZerodhaAccountStream:
    """Order updates for one trading client."""

    def __init__(
        self,
        trading_client: TradingClientId,
        api_key: str,
        access_token: str,
        registry: Callable[[], InstrumentRegistry],
        clock: Clock,
        connector: Connector,
        *,
        url: str = KITE_FEED_URL,
    ) -> None:
        if not api_key or not access_token:
            raise DomainError(f"{trading_client}: an account stream needs a key and a token")
        self._trading_client = trading_client
        self._api_key = api_key
        self._access_token = access_token
        self._registry = registry
        self._clock = clock
        self._connector = connector
        self._url = url
        self._connection: WebSocketConnection | None = None

    @property
    def trading_client(self) -> TradingClientId:
        return self._trading_client

    @property
    def is_connected(self) -> bool:
        return self._connection is not None

    @property
    def endpoint(self) -> str:
        """The URL, with credentials. Never log this."""
        return f"{self._url}?api_key={self._api_key}&access_token={self._access_token}"

    async def connect(self) -> None:
        if self._connection is None:
            self._connection = await self._connector(self.endpoint)

    async def close(self) -> None:
        connection, self._connection = self._connection, None
        if connection is not None:
            await connection.close()

    async def events(self) -> AsyncIterator[AccountEvent]:
        if self._connection is None:
            raise DomainError(f"{self._trading_client}: the account stream is not connected")
        connection = self._connection

        yield AccountConnected(self._trading_client, self._clock.now())
        reason = "the connection ended"
        try:
            async for message in connection:
                if isinstance(message, bytes):
                    # Tick frames. This connection subscribes to nothing, so
                    # anything binary is a heartbeat or a stray.
                    continue
                event = self._decode(message)
                if event is not None:
                    yield event
        except Exception as error:
            reason = f"{type(error).__name__}: {error}"
        finally:
            self._connection = None

        yield AccountDisconnected(self._trading_client, reason, self._clock.now())

    def _decode(self, message: str) -> AccountEvent | None:
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            return self._problem(f"unreadable text frame: {message[:200]}")
        if not isinstance(payload, dict):
            return self._problem(f"unexpected frame shape: {message[:200]}")

        kind = payload.get("type")
        if kind == "error":
            return self._problem(f"kite reported: {payload.get('data')}")
        if kind != "order":
            logger.debug("%s: ignoring kite frame type=%s", self._trading_client, kind)
            return None

        data = payload.get("data")
        if not isinstance(data, dict):
            return self._problem("an order frame with no data")
        return self._to_update(data)

    def _to_update(self, data: dict[str, Any]) -> AccountEvent:
        order_id = str(data.get("order_id") or "")
        if not order_id:
            return self._problem("an order update with no order id")

        filled = _int(data.get("filled_quantity"))
        tag = str(data.get("tag") or "")
        symbol = str(data.get("tradingsymbol") or "")
        exchange = str(data.get("exchange") or "")
        instrument = self._registry().by_trading_symbol(exchange, symbol)
        if instrument is None:
            for venue in ("NSE", "BSE", "MCX"):
                instrument = self._registry().by_trading_symbol(venue, symbol)
                if instrument is not None:
                    break

        average = data.get("average_price")
        return OrderUpdate(
            broker_order_id=BrokerOrderId(order_id),
            # Kite names the account on every frame. Under a dealer session
            # that is not this stream's owner, and routing by the owner would
            # apply one account's fills to another.
            broker_client_id=str(data.get("user_id") or ""),
            client_order_id=ClientOrderId(tag) if tag else None,
            instrument=instrument.id if instrument is not None else None,
            side=side_from_kite(data.get("transaction_type")),
            quantity=_int(data.get("quantity")),
            filled_quantity=filled,
            status=status_from_kite(data.get("status"), filled),
            product=product_from_kite(data.get("product")),
            average_price=(Money(_decimal(average), Currency.INR) if average is not None else None),
            message=str(data.get("status_message") or "") or None,
            at=self._clock.now(),
        )

    def _problem(self, detail: str) -> AccountProblem:
        return AccountProblem(self._trading_client, detail, self._clock.now())


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (TypeError, ValueError, InvalidOperation):
        return Decimal(0)
