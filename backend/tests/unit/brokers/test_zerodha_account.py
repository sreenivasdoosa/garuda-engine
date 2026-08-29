"""Zerodha's order update stream."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime

import pytest

from garuda.brokers.websocket import WebSocketConnection
from garuda.brokers.zerodha.account import ZerodhaAccountStream
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, OrderStatus
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.order import ClientOrderId, Side
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.account import (
    AccountConnected,
    AccountDisconnected,
    AccountProblem,
    OrderUpdate,
)

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")


class FakeConnection:
    def __init__(self, incoming: Sequence[str | bytes] = ()) -> None:
        self._incoming = list(incoming)
        self.closed = False

    async def send(self, message: str) -> None: ...

    async def close(self) -> None:
        self.closed = True

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        async def stream() -> AsyncIterator[str | bytes]:
            for message in self._incoming:
                yield message

        return stream()


@pytest.fixture
def registry(reliance: Instrument) -> InstrumentRegistry:
    return InstrumentRegistry.build([reliance])


def stream(registry: InstrumentRegistry, connection: FakeConnection) -> ZerodhaAccountStream:
    async def connector(url: str) -> WebSocketConnection:
        return connection

    return ZerodhaAccountStream(
        CLIENT, "key", "token", lambda: registry, ReplayClock(T0), connector
    )


def order_frame(symbol: str, **overrides: object) -> str:
    data = {
        "order_id": "260831000001",
        "user_id": "AB1234",
        "tag": "gar-1",
        "tradingsymbol": symbol,
        "exchange": "NSE",
        "transaction_type": "BUY",
        "status": "COMPLETE",
        "quantity": 100,
        "filled_quantity": 100,
        "average_price": 2885.5,
        "product": "CNC",
    }
    data.update(overrides)
    return json.dumps({"type": "order", "data": data})


async def collect(subject: ZerodhaAccountStream) -> list[object]:
    return [event async for event in subject.events()]


class TestOrderUpdates:
    async def test_an_order_frame_becomes_an_update(
        self, registry: InstrumentRegistry, reliance: Instrument
    ) -> None:
        subject = stream(registry, FakeConnection([order_frame(reliance.trading_symbol)]))
        await subject.connect()
        events = await collect(subject)

        assert isinstance(events[0], AccountConnected)
        update = events[1]
        assert isinstance(update, OrderUpdate)
        assert update.client_order_id == ClientOrderId("gar-1")
        assert update.instrument == reliance.id
        assert update.side is Side.BUY
        assert update.status is OrderStatus.FILLED
        assert update.filled_quantity == 100
        assert update.average_price == Money.of("2885.5", Currency.INR)

    async def test_the_account_on_the_frame_is_carried(
        self, registry: InstrumentRegistry, reliance: Instrument
    ) -> None:
        """Under a dealer session it is not this stream's owner."""
        subject = stream(
            registry, FakeConnection([order_frame(reliance.trading_symbol, user_id="CD5678")])
        )
        await subject.connect()
        events = await collect(subject)
        update = events[1]
        assert isinstance(update, OrderUpdate)
        assert update.broker_client_id == "CD5678"

    async def test_a_partial_fill_is_reported_as_such(
        self, registry: InstrumentRegistry, reliance: Instrument
    ) -> None:
        subject = stream(
            registry,
            FakeConnection(
                [order_frame(reliance.trading_symbol, status="OPEN", filled_quantity=40)]
            ),
        )
        await subject.connect()
        events = await collect(subject)
        update = events[1]
        assert isinstance(update, OrderUpdate)
        assert update.status is OrderStatus.PARTIALLY_FILLED

    async def test_an_unknown_symbol_still_yields_the_update(
        self, registry: InstrumentRegistry
    ) -> None:
        """The order is real and its status matters even if the master lacks it."""
        subject = stream(registry, FakeConnection([order_frame("NOTLISTED")]))
        await subject.connect()
        events = await collect(subject)
        update = events[1]
        assert isinstance(update, OrderUpdate)
        assert update.instrument is None
        assert update.status is OrderStatus.FILLED

    async def test_binary_frames_are_ignored(
        self, registry: InstrumentRegistry, reliance: Instrument
    ) -> None:
        """This connection subscribes to nothing, so ticks are not its business."""
        subject = stream(
            registry, FakeConnection([b"\x00\x01", order_frame(reliance.trading_symbol)])
        )
        await subject.connect()
        events = await collect(subject)
        assert [type(e) for e in events] == [AccountConnected, OrderUpdate, AccountDisconnected]


class TestProblems:
    async def test_an_order_frame_with_no_id_is_a_problem(
        self, registry: InstrumentRegistry, reliance: Instrument
    ) -> None:
        subject = stream(
            registry, FakeConnection([order_frame(reliance.trading_symbol, order_id="")])
        )
        await subject.connect()
        events = await collect(subject)
        assert isinstance(events[1], AccountProblem)

    async def test_an_error_from_kite_is_surfaced(self, registry: InstrumentRegistry) -> None:
        subject = stream(
            registry,
            FakeConnection([json.dumps({"type": "error", "data": "TokenException"})]),
        )
        await subject.connect()
        events = await collect(subject)
        problem = events[1]
        assert isinstance(problem, AccountProblem)
        assert "TokenException" in problem.detail

    async def test_unreadable_text_is_a_problem_not_a_crash(
        self, registry: InstrumentRegistry
    ) -> None:
        subject = stream(registry, FakeConnection(["{not json"]))
        await subject.connect()
        events = await collect(subject)
        assert isinstance(events[1], AccountProblem)

    async def test_the_stream_ends_with_a_disconnection(self, registry: InstrumentRegistry) -> None:
        subject = stream(registry, FakeConnection([]))
        await subject.connect()
        events = await collect(subject)
        assert isinstance(events[-1], AccountDisconnected)
        assert not subject.is_connected

    async def test_a_stream_without_credentials_is_refused(
        self, registry: InstrumentRegistry
    ) -> None:
        async def connector(url: str) -> WebSocketConnection:
            return FakeConnection()

        with pytest.raises(DomainError, match="key and a token"):
            ZerodhaAccountStream(CLIENT, "key", "", lambda: registry, ReplayClock(T0), connector)

    async def test_reading_before_connecting_is_refused(self, registry: InstrumentRegistry) -> None:
        with pytest.raises(DomainError, match="not connected"):
            await collect(stream(registry, FakeConnection()))
