"""Timing every call to a broker, for the Broker API Stats page.

Ported from the reference engine's API statistics: each order placement,
modification, cancellation and each fetch of the order book, positions or
funds is timed and written as one row -- the broker, the operation, the
order it concerned, when it started and ended, and how long it took. The
reference measured inside each broker's order manager; here one wrapper
measures any adapter, so a second broker is measured the day it exists.

A call that fails is timed too and the failure re-raised: the slow call
that ended in a timeout is exactly the one the page is for. The sink is
told and never allowed to interfere -- it is given a protocol rather than
a store, so this module knows nothing about where the rows go.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import datetime
from typing import Protocol

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.order import BrokerOrderId, OrderRequest
from garuda.protocols.broker import (
    BrokerAdapter,
    BrokerEvent,
    BrokerOrder,
    BrokerPosition,
    Funds,
    LoginStyle,
    OrderChanges,
)
from garuda.protocols.clock import Clock


class ApiStatsSink(Protocol):
    """Where one timed call is written. Never raises."""

    async def record(
        self,
        *,
        broker: str,
        operation: str,
        order_id: str | None,
        started_at: datetime,
        ended_at: datetime,
    ) -> None: ...


class MeteredBroker:
    """A broker adapter that times every call it forwards."""

    def __init__(
        self, inner: BrokerAdapter, sink: ApiStatsSink, clock: Clock, *, broker: str
    ) -> None:
        self._inner = inner
        self._sink = sink
        self._clock = clock
        self._broker = broker

    @property
    def inner(self) -> BrokerAdapter:
        return self._inner

    @property
    def trading_client(self) -> TradingClientId:
        return self._inner.trading_client

    @property
    def login_style(self) -> LoginStyle:
        return self._inner.login_style

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        started = self._clock.now()
        try:
            placed = await self._inner.place(request)
        except BaseException:
            await self._timed("place", None, started)
            raise
        await self._timed("place", placed.value, started)
        return placed

    async def modify(self, broker_order_id: BrokerOrderId, changes: OrderChanges) -> None:
        started = self._clock.now()
        try:
            await self._inner.modify(broker_order_id, changes)
        finally:
            await self._timed("modify", broker_order_id.value, started)

    async def cancel(self, broker_order_id: BrokerOrderId) -> None:
        started = self._clock.now()
        try:
            await self._inner.cancel(broker_order_id)
        finally:
            await self._timed("cancel", broker_order_id.value, started)

    async def fetch_orders(self) -> Sequence[BrokerOrder]:
        started = self._clock.now()
        try:
            return await self._inner.fetch_orders()
        finally:
            await self._timed("fetch_orders", None, started)

    async def fetch_positions(self) -> Sequence[BrokerPosition]:
        started = self._clock.now()
        try:
            return await self._inner.fetch_positions()
        finally:
            await self._timed("fetch_positions", None, started)

    async def fetch_funds(self) -> Funds:
        started = self._clock.now()
        try:
            return await self._inner.fetch_funds()
        finally:
            await self._timed("fetch_funds", None, started)

    async def fetch_instruments(self) -> Sequence[Instrument]:
        started = self._clock.now()
        try:
            return await self._inner.fetch_instruments()
        finally:
            await self._timed("fetch_instruments", None, started)

    def events(self) -> AsyncIterator[BrokerEvent]:
        # A stream, not a call: nothing to time.
        return self._inner.events()

    async def _timed(self, operation: str, order_id: str | None, started: datetime) -> None:
        await self._sink.record(
            broker=self._broker,
            operation=operation,
            order_id=order_id,
            started_at=started,
            ended_at=self._clock.now(),
        )
