"""Timing every call to a broker.

Behavioural: a broker that takes a known time is called through the meter,
and the claims are about what the sink is told -- the operation, the order
it concerned, how long it took -- and that a failing call is timed and
still fails.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from garuda.brokers.metered import MeteredBroker
from garuda.core.clock import ReplayClock
from garuda.domain import OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.protocols.broker import (
    BrokerEvent,
    BrokerOrder,
    BrokerPosition,
    Funds,
    LoginStyle,
    OrderChanges,
    OrderRejectedError,
)

NOW = datetime(2026, 10, 12, 4, 0, tzinfo=UTC)
APPA = TradingClientId("appa")


class SlowBroker:
    """Takes a stated time for every call, by advancing the clock."""

    def __init__(self, clock: ReplayClock, takes: timedelta, *, refuse: bool = False) -> None:
        self._clock = clock
        self._takes = takes
        self._refuse = refuse

    @property
    def trading_client(self) -> TradingClientId:
        return APPA

    @property
    def login_style(self) -> LoginStyle:
        return LoginStyle.BROWSER_OAUTH

    async def _work(self) -> None:
        await self._clock.advance_by(self._takes)
        if self._refuse:
            raise OrderRejectedError("the broker said no")

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        await self._work()
        return BrokerOrderId("251012000001")

    async def modify(self, broker_order_id: BrokerOrderId, changes: OrderChanges) -> None:
        await self._work()

    async def cancel(self, broker_order_id: BrokerOrderId) -> None:
        await self._work()

    async def fetch_orders(self) -> Sequence[BrokerOrder]:
        await self._work()
        return []

    async def fetch_positions(self) -> Sequence[BrokerPosition]:
        await self._work()
        return []

    async def fetch_funds(self) -> Funds:
        await self._work()
        return Funds()  # type: ignore[call-arg]

    async def fetch_instruments(self) -> Sequence[Instrument]:
        await self._work()
        return []

    async def events(self) -> AsyncIterator[BrokerEvent]:
        return
        yield  # pragma: no cover


class Sink:
    def __init__(self) -> None:
        self.rows: list[dict[str, Any]] = []

    async def record(self, **row: Any) -> None:
        self.rows.append(row)


def an_order() -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId("gar-1"),
        trading_client=APPA,
        instrument=InstrumentId("NSE:RELIANCE"),
        side=Side.BUY,
        quantity=1,
        order_type=OrderType.MARKET,
        product=ProductType.MIS,
    )


def meter(takes: timedelta, *, refuse: bool = False) -> tuple[MeteredBroker, Sink, ReplayClock]:
    clock = ReplayClock(NOW, auto_advance=False)
    sink = Sink()
    return (
        MeteredBroker(SlowBroker(clock, takes, refuse=refuse), sink, clock, broker="zerodha"),
        sink,
        clock,
    )


async def test_a_placement_is_timed_with_the_order_it_made() -> None:
    broker, sink, _ = meter(timedelta(milliseconds=320))

    placed = await broker.place(an_order())

    assert placed == BrokerOrderId("251012000001")
    assert sink.rows == [
        {
            "broker": "zerodha",
            "operation": "place",
            "order_id": "251012000001",
            "started_at": NOW,
            "ended_at": NOW + timedelta(milliseconds=320),
        }
    ]


async def test_every_other_call_is_timed_by_name() -> None:
    broker, sink, _ = meter(timedelta(milliseconds=10))
    order = BrokerOrderId("251012000001")

    await broker.modify(order, OrderChanges())
    await broker.cancel(order)
    await broker.fetch_orders()
    await broker.fetch_positions()
    await broker.fetch_instruments()

    assert [(r["operation"], r["order_id"]) for r in sink.rows] == [
        ("modify", "251012000001"),
        ("cancel", "251012000001"),
        ("fetch_orders", None),
        ("fetch_positions", None),
        ("fetch_instruments", None),
    ]


async def test_a_call_that_fails_is_timed_and_still_fails() -> None:
    """The slow call that ended in a refusal is the one the page is for."""
    broker, sink, _ = meter(timedelta(seconds=2), refuse=True)

    with pytest.raises(OrderRejectedError):
        await broker.place(an_order())

    [row] = sink.rows
    assert row["operation"] == "place"
    assert row["order_id"] is None
    assert row["ended_at"] - row["started_at"] == timedelta(seconds=2)
