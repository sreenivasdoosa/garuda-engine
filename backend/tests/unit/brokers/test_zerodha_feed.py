"""The Kite WebSocket feed.

Driven through a fake connection, so the claims are about what the feed sends
on the wire and what it produces from what arrives -- not about a socket.
"""

from __future__ import annotations

import json
import struct
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from datetime import UTC, datetime

import pytest

from garuda.brokers.websocket import WebSocketConnection
from garuda.brokers.zerodha.feed import MAX_SUBSCRIPTIONS, ZerodhaFeed
from garuda.brokers.zerodha.ticks import NFO, NSE
from garuda.core.clock import ReplayClock
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.feed import FeedConnected, FeedDisconnected, FeedProblem, TicksReceived

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CALL_TOKEN = (12345 << 8) | NFO
EQUITY_TOKEN = (2885 << 8) | NSE


class FakeConnection:
    """Records what was sent; replays what it was given."""

    def __init__(self, incoming: Sequence[str | bytes] = (), fail_with: Exception | None = None):
        self.sent: list[dict[str, object]] = []
        self.closed = False
        self._incoming = list(incoming)
        self._fail_with = fail_with

    async def send(self, message: str) -> None:
        self.sent.append(json.loads(message))

    async def close(self) -> None:
        self.closed = True

    def __aiter__(self) -> AsyncIterator[str | bytes]:
        async def stream() -> AsyncIterator[str | bytes]:
            for message in self._incoming:
                yield message
            if self._fail_with is not None:
                raise self._fail_with

        return stream()


def ltp_frame(token: int, paise: int) -> bytes:
    packet = struct.pack(">ii", token, paise)
    return struct.pack(">h", 1) + struct.pack(">h", len(packet)) + packet


@pytest.fixture
def registry(nifty_call: Instrument, reliance: Instrument) -> InstrumentRegistry:
    return InstrumentRegistry.build(
        [nifty_call, reliance],
        {nifty_call.id: CALL_TOKEN, reliance.id: EQUITY_TOKEN},
    )


def feed(
    registry: InstrumentRegistry, connection: FakeConnection, mode: str = "full"
) -> ZerodhaFeed:
    async def connector(url: str) -> WebSocketConnection:
        return connection

    return ZerodhaFeed(
        api_key="key",
        access_token="token",
        registry=lambda: registry,
        clock=ReplayClock(T0),
        connector=connector,
        mode=mode,
    )


class TestConnecting:
    async def test_credentials_go_in_the_url(self, registry: InstrumentRegistry) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        assert "api_key=key" in subject.endpoint
        assert "access_token=token" in subject.endpoint
        assert subject.is_connected

    async def test_connecting_twice_reuses_the_one_connection(
        self, registry: InstrumentRegistry
    ) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.connect()
        assert subject.is_connected

    async def test_closing_ends_the_connection_and_forgets_the_subscriptions(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([nifty_call.id])
        await subject.close()
        assert connection.closed
        assert not subject.is_connected

    async def test_sending_before_connecting_is_refused(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        with pytest.raises(DomainError, match="not connected"):
            await feed(registry, FakeConnection()).subscribe([nifty_call.id])

    async def test_a_feed_without_credentials_is_refused(
        self, registry: InstrumentRegistry
    ) -> None:
        async def connector(url: str) -> WebSocketConnection:
            return FakeConnection()

        with pytest.raises(DomainError, match="API key and an access token"):
            ZerodhaFeed("", "token", lambda: registry, ReplayClock(T0), connector)


class TestSubscribing:
    async def test_an_instrument_goes_out_as_its_broker_token(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([nifty_call.id])
        assert connection.sent[0] == {"a": "subscribe", "v": [CALL_TOKEN]}

    async def test_the_mode_is_set_after_subscribing(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        """Subscribing alone gives last price only, which has no depth."""
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([nifty_call.id])
        assert connection.sent[1] == {"a": "mode", "v": ["full", [CALL_TOKEN]]}

    async def test_an_instrument_the_master_does_not_know_is_skipped_not_fatal(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        """One unlisted strike must not cost the others in the same call."""
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([InstrumentId("NSE:NOTLISTED"), nifty_call.id])
        assert connection.sent[0] == {"a": "subscribe", "v": [CALL_TOKEN]}

    async def test_subscribing_to_nothing_sends_nothing(self, registry: InstrumentRegistry) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([InstrumentId("NSE:NOTLISTED")])
        assert connection.sent == []

    async def test_going_over_the_connection_limit_is_refused_loudly(
        self, nifty_call: Instrument, nse: Exchange
    ) -> None:
        """Over the cap Kite accepts the subscription and never delivers it."""
        many = [
            replace(nifty_call, id=InstrumentId(f"NSE:SYM{i}"), trading_symbol=f"SYM{i}")
            for i in range(MAX_SUBSCRIPTIONS + 1)
        ]
        registry = InstrumentRegistry.build(
            many, {instrument.id: i + 1 for i, instrument in enumerate(many)}
        )
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        with pytest.raises(DomainError, match="never delivered"):
            await subject.subscribe([instrument.id for instrument in many])

    async def test_unsubscribing_uses_the_token_it_subscribed_with(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.subscribe([nifty_call.id])
        await subject.unsubscribe([nifty_call.id])
        assert connection.sent[-1] == {"a": "unsubscribe", "v": [CALL_TOKEN]}

    async def test_unsubscribing_from_something_never_subscribed_sends_nothing(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        connection = FakeConnection()
        subject = feed(registry, connection)
        await subject.connect()
        await subject.unsubscribe([nifty_call.id])
        assert connection.sent == []


class TestReading:
    async def collect(self, subject: ZerodhaFeed) -> list[object]:
        return [event async for event in subject.events()]

    async def test_a_binary_frame_becomes_ticks(
        self, registry: InstrumentRegistry, nifty_call: Instrument
    ) -> None:
        subject = feed(registry, FakeConnection([ltp_frame(CALL_TOKEN, 12_055)]))
        await subject.connect()
        events = await self.collect(subject)

        assert isinstance(events[0], FeedConnected)
        assert isinstance(events[1], TicksReceived)
        assert events[1].ticks[0].instrument == nifty_call.id
        assert str(events[1].ticks[0].last_price.amount) == "120.55"

    async def test_the_stream_ends_with_a_disconnection_rather_than_an_error(
        self, registry: InstrumentRegistry
    ) -> None:
        """A dropped feed is expected in a six-hour session, not exceptional."""
        subject = feed(registry, FakeConnection([], fail_with=ConnectionResetError("peer gone")))
        await subject.connect()
        events = await self.collect(subject)

        last = events[-1]
        assert isinstance(last, FeedDisconnected)
        assert "ConnectionResetError" in last.reason
        assert not subject.is_connected

    async def test_a_clean_end_is_still_a_disconnection(self, registry: InstrumentRegistry) -> None:
        subject = feed(registry, FakeConnection([]))
        await subject.connect()
        events = await self.collect(subject)
        assert isinstance(events[-1], FeedDisconnected)

    async def test_a_heartbeat_produces_no_event(self, registry: InstrumentRegistry) -> None:
        subject = feed(registry, FakeConnection([b"\x00"]))
        await subject.connect()
        events = await self.collect(subject)
        assert [type(event) for event in events] == [FeedConnected, FeedDisconnected]

    async def test_a_token_missing_from_the_master_is_a_problem_not_a_silence(
        self, registry: InstrumentRegistry
    ) -> None:
        """Those instruments are ticking and nothing is listening."""
        subject = feed(registry, FakeConnection([ltp_frame((999 << 8) | NFO, 100)]))
        await subject.connect()
        events = await self.collect(subject)

        problem = events[1]
        assert isinstance(problem, FeedProblem)
        assert "not in today's master" in problem.detail

    async def test_an_error_from_kite_is_surfaced(self, registry: InstrumentRegistry) -> None:
        subject = feed(
            registry,
            FakeConnection([json.dumps({"type": "error", "data": "TokenException"})]),
        )
        await subject.connect()
        events = await self.collect(subject)

        problem = events[1]
        assert isinstance(problem, FeedProblem)
        assert "TokenException" in problem.detail

    async def test_an_order_update_is_ignored_rather_than_reported(
        self, registry: InstrumentRegistry
    ) -> None:
        """The order book is fed from the order stream; this would be noise."""
        subject = feed(
            registry, FakeConnection([json.dumps({"type": "order", "data": {"status": "OPEN"}})])
        )
        await subject.connect()
        events = await self.collect(subject)
        assert [type(event) for event in events] == [FeedConnected, FeedDisconnected]

    async def test_reading_before_connecting_is_refused(self, registry: InstrumentRegistry) -> None:
        with pytest.raises(DomainError, match="not connected"):
            await self.collect(feed(registry, FakeConnection()))
