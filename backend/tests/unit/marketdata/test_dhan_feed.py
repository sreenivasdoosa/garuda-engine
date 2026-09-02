"""Dhan's binary feed, driven through a fake socket.

The claims are about what goes on the wire and what comes back out of it. Two
of them are the ones that actually cost a trading day when wrong: an index
must go out in QUOTE mode, and a packet header must find its way back to an
instrument through the segment/security-id pair.
"""

from __future__ import annotations

import json
import struct
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.brokers.websocket import WebSocketConnection
from garuda.core.clock import ReplayClock
from garuda.domain.enums import InstrumentKind, Segment
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_feed import (
    MAX_PER_MESSAGE,
    MAX_SUBSCRIPTIONS,
    RC_DISCONNECT,
    DhanFeed,
)
from garuda.marketdata.providers.dhan_master import DhanInstrument
from garuda.marketdata.providers.dhan_packets import (
    RC_SUBSCRIBE_FULL,
    RC_SUBSCRIBE_QUOTE,
    RC_UNSUBSCRIBE_FULL,
)
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.feed import FeedConnected, FeedDisconnected, FeedProblem, TicksReceived

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)

CALL = InstrumentId("NSE:NIFTY26AUG25000CE")
NIFTY = InstrumentId("NSE:NIFTY")

CALL_SEGMENT, CALL_SECURITY = 2, 44234
INDEX_SEGMENT_NUMBER, INDEX_SECURITY = 0, 13


class FakeConnection:
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


def a_row(**overrides: object) -> DhanInstrument:
    fields: dict[str, object] = {
        "security_id": str(CALL_SECURITY),
        "segment": "NSE_FNO",
        "exchange": "NSE",
        "trading_symbol": "NIFTY26AUG25000CE",
        "underlying": "NIFTY",
        "lot_size": 75,
        "option_type": "CE",
    }
    fields.update(overrides)
    return DhanInstrument(**fields)  # type: ignore[arg-type]


def an_index_row() -> DhanInstrument:
    return a_row(
        security_id=str(INDEX_SECURITY),
        segment="IDX_I",
        trading_symbol="NIFTY",
        is_index=True,
        option_type="",
    )


def index_instrument(nse: Exchange) -> Instrument:
    return Instrument(
        id=NIFTY,
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.INDEX,
        trading_symbol="NIFTY",
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


Parts = tuple[DhanCatalogue, InstrumentRegistry]


@pytest.fixture
def parts(nifty_call: Instrument, nse: Exchange) -> tuple[DhanCatalogue, InstrumentRegistry]:
    catalogue = DhanCatalogue([a_row(), an_index_row()])
    registry = InstrumentRegistry.build([nifty_call, index_instrument(nse)])
    return catalogue, registry


def a_feed(parts: Parts, connection: FakeConnection) -> DhanFeed:
    catalogue, registry = parts

    async def connector(url: str) -> WebSocketConnection:
        return connection

    return DhanFeed(
        access_token="token",
        client_id="client",
        catalogue=lambda: catalogue,
        registry=lambda: registry,
        clock=ReplayClock(T0),
        connector=connector,
    )


# -- packet builders --------------------------------------------------------


def header(code: int, segment: int, security_id: int, length: int) -> bytes:
    return struct.pack("<BHBi", code, length, segment, security_id)


def ticker_packet(price: float, when: int) -> bytes:
    return header(2, CALL_SEGMENT, CALL_SECURITY, 16) + struct.pack("<fi", price, when)


def index_packet(value: float, when: int) -> bytes:
    return header(1, INDEX_SEGMENT_NUMBER, INDEX_SECURITY, 16) + struct.pack("<fi", value, when)


def disconnect_packet(reason: int) -> bytes:
    return header(50, 0, 0, 10) + struct.pack("<H", reason)


EPOCH = int(T0.timestamp())


# -- the wire ---------------------------------------------------------------


class TestSubscribing:
    async def test_a_tradable_goes_out_in_full_mode(self, parts: Parts) -> None:
        """Full carries the five-level depth and open interest."""
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.subscribe([CALL])

        assert connection.sent[0]["RequestCode"] == RC_SUBSCRIBE_FULL
        assert connection.sent[0]["InstrumentList"] == [
            {"ExchangeSegment": "NSE_FNO", "SecurityId": str(CALL_SECURITY)}
        ]

    async def test_an_index_goes_out_in_quote_mode(self, parts: Parts) -> None:
        """Dhan ignores a depth request for an index, and an index subscribed
        in FULL mode simply never ticks -- which reads as a dead symbol."""
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.subscribe([NIFTY])

        assert connection.sent[0]["RequestCode"] == RC_SUBSCRIBE_QUOTE

    async def test_a_mixed_batch_is_split_into_two_messages(self, parts: Parts) -> None:
        """One message cannot carry two modes, so mixing them would put the
        index in whichever mode the message happened to take."""
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.subscribe([CALL, NIFTY])

        codes = [message["RequestCode"] for message in connection.sent]
        assert codes == [RC_SUBSCRIBE_FULL, RC_SUBSCRIBE_QUOTE]

    async def test_an_instrument_dhan_does_not_list_is_skipped(self, parts: Parts) -> None:
        """One unlisted strike must not cost the others in the same call."""
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.subscribe([CALL, InstrumentId("NSE:NOTLISTED")])

        assert len(connection.sent) == 1
        assert connection.sent[0]["InstrumentCount"] == 1

    async def test_nothing_is_sent_for_an_empty_subscribe(self, parts: Parts) -> None:
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.subscribe([])

        assert connection.sent == []

    async def test_unsubscribing_uses_the_matching_code(self, parts: Parts) -> None:
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()
        await feed.subscribe([CALL])

        await feed.unsubscribe([CALL])

        assert connection.sent[-1]["RequestCode"] == RC_UNSUBSCRIBE_FULL

    async def test_a_batch_over_the_message_cap_is_split(self, parts: Parts) -> None:
        """A message over a hundred instruments is not refused -- it is
        accepted and the surplus never delivered."""
        rows = [
            a_row(security_id=str(1000 + n), trading_symbol=f"SYM{n}", option_type="")
            for n in range(MAX_PER_MESSAGE + 5)
        ]
        catalogue = DhanCatalogue(rows)
        registry = InstrumentRegistry.build([])
        connection = FakeConnection()

        async def connector(url: str) -> WebSocketConnection:
            return connection

        feed = DhanFeed(
            access_token="t",
            client_id="c",
            catalogue=lambda: catalogue,
            registry=lambda: registry,
            clock=ReplayClock(T0),
            connector=connector,
        )
        await feed.connect()

        await feed.subscribe([InstrumentId(f"NSE:SYM{n}") for n in range(MAX_PER_MESSAGE + 5)])

        counts = [message["InstrumentCount"] for message in connection.sent]
        assert counts == [MAX_PER_MESSAGE, 5]

    async def test_going_over_the_connection_cap_is_refused_before_anything_is_sent(
        self, parts: Parts
    ) -> None:
        """Refusing halfway would leave the connection holding a subscription
        set nobody asked for."""
        rows = [
            a_row(security_id=str(100000 + n), trading_symbol=f"S{n}", option_type="")
            for n in range(MAX_SUBSCRIPTIONS + 1)
        ]
        catalogue = DhanCatalogue(rows)
        connection = FakeConnection()

        async def connector(url: str) -> WebSocketConnection:
            return connection

        feed = DhanFeed(
            access_token="t",
            client_id="c",
            catalogue=lambda: catalogue,
            registry=lambda: InstrumentRegistry.build([]),
            clock=ReplayClock(T0),
            connector=connector,
        )
        await feed.connect()

        with pytest.raises(DomainError, match="exceeds"):
            await feed.subscribe([InstrumentId(f"NSE:S{n}") for n in range(MAX_SUBSCRIPTIONS + 1)])

        assert connection.sent == []


class TestTheConnection:
    async def test_the_endpoint_keeps_the_slash_before_the_query(self, parts: Parts) -> None:
        """A WS URI of the form wss://host?query yields a malformed request
        line that the handshake rejects."""
        feed = a_feed(parts, FakeConnection())

        assert "/?version=2" in feed.endpoint

    async def test_it_will_not_build_without_both_credentials(self, parts: Parts) -> None:
        with pytest.raises(DomainError, match="access token and a client id"):
            DhanFeed(
                access_token="",
                client_id="c",
                catalogue=lambda: DhanCatalogue([]),
                registry=lambda: InstrumentRegistry.build([]),
                clock=ReplayClock(T0),
                connector=None,  # type: ignore[arg-type]
            )

    async def test_closing_says_goodbye_before_dropping_the_socket(self, parts: Parts) -> None:
        """Dhan holds the account's one feed slot otherwise, and the next
        connect is refused with 805 -- which looks like someone else logged in."""
        connection = FakeConnection()
        feed = a_feed(parts, connection)
        await feed.connect()

        await feed.close()

        assert connection.sent[-1] == {"RequestCode": RC_DISCONNECT}
        assert connection.closed is True

    async def test_sending_before_connecting_is_refused(self, parts: Parts) -> None:
        feed = a_feed(parts, FakeConnection())

        with pytest.raises(DomainError, match="not connected"):
            await feed.subscribe([CALL])


class TestReading:
    async def test_a_ticker_packet_becomes_a_tick(self, parts: Parts) -> None:
        connection = FakeConnection([ticker_packet(101.5, EPOCH)])
        feed = a_feed(parts, connection)
        await feed.connect()
        await feed.subscribe([CALL])

        events = [event async for event in feed.events()]

        ticks = [e for e in events if isinstance(e, TicksReceived)]
        assert len(ticks) == 1
        assert ticks[0].ticks[0].instrument == CALL
        assert ticks[0].ticks[0].last_price.amount == Decimal("101.5")

    async def test_an_index_packet_becomes_a_tick(self, parts: Parts) -> None:
        """Without this, NIFTY and BANKNIFTY never tick and every strategy
        that references an index by its spot silently stops."""
        connection = FakeConnection([index_packet(25100.0, EPOCH)])
        feed = a_feed(parts, connection)
        await feed.connect()
        await feed.subscribe([NIFTY])

        events = [event async for event in feed.events()]

        ticks = [e for e in events if isinstance(e, TicksReceived)]
        assert ticks[0].ticks[0].instrument == NIFTY
        assert ticks[0].ticks[0].last_price.amount == Decimal("25100")

    async def test_several_packets_in_one_frame_all_decode(self, parts: Parts) -> None:
        """Dhan batches; reading only the first would drop most of the feed."""
        frame = ticker_packet(101.5, EPOCH) + index_packet(25100.0, EPOCH)
        connection = FakeConnection([frame])
        feed = a_feed(parts, connection)
        await feed.connect()
        await feed.subscribe([CALL, NIFTY])

        events = [event async for event in feed.events()]

        ticks = next(e for e in events if isinstance(e, TicksReceived)).ticks
        assert {tick.instrument for tick in ticks} == {CALL, NIFTY}

    async def test_a_packet_for_something_not_subscribed_is_not_a_problem(
        self, parts: Parts
    ) -> None:
        """An unsubscribe racing packets already in flight is the ordinary
        state for a second afterwards, not something to wake anyone for."""
        connection = FakeConnection([ticker_packet(101.5, EPOCH)])
        feed = a_feed(parts, connection)
        await feed.connect()

        events = [event async for event in feed.events()]

        assert not [e for e in events if isinstance(e, FeedProblem)]
        assert not [e for e in events if isinstance(e, TicksReceived)]

    async def test_a_disconnect_packet_is_reported_with_its_reason(self, parts: Parts) -> None:
        connection = FakeConnection([disconnect_packet(805)])
        feed = a_feed(parts, connection)
        await feed.connect()

        events = [event async for event in feed.events()]

        problems = [e for e in events if isinstance(e, FeedProblem)]
        assert "805" in problems[0].detail
        assert "feed slot" in problems[0].detail

    async def test_a_text_frame_is_reported_rather_than_decoded(self, parts: Parts) -> None:
        connection = FakeConnection(['{"error":"bad token"}'])
        feed = a_feed(parts, connection)
        await feed.connect()

        events = [event async for event in feed.events()]

        problems = [e for e in events if isinstance(e, FeedProblem)]
        assert "bad token" in problems[0].detail

    async def test_the_stream_opens_and_closes_with_its_own_events(self, parts: Parts) -> None:
        connection = FakeConnection([ticker_packet(101.5, EPOCH)])
        feed = a_feed(parts, connection)
        await feed.connect()
        await feed.subscribe([CALL])

        events = [event async for event in feed.events()]

        assert isinstance(events[0], FeedConnected)
        assert isinstance(events[-1], FeedDisconnected)

    async def test_a_dropped_connection_is_yielded_not_raised(self, parts: Parts) -> None:
        """A dropped feed is expected in a six-hour session; the supervisor
        above needs to be told, not unwound through."""
        connection = FakeConnection(fail_with=ConnectionResetError("gone"))
        feed = a_feed(parts, connection)
        await feed.connect()

        events = [event async for event in feed.events()]

        last = events[-1]
        assert isinstance(last, FeedDisconnected)
        assert "gone" in last.reason
        assert feed.is_connected is False


class TestWhenTheMasterDisagrees:
    async def test_subscribed_and_ticking_but_unlisted_is_a_problem(self, parts: Parts) -> None:
        """Distinct from an unsubscribe race: this one is subscribed here and
        ticking, and today's master has no instrument to route it to."""
        catalogue, _ = parts
        empty = InstrumentRegistry.build([])
        connection = FakeConnection([ticker_packet(101.5, EPOCH)])

        async def connector(url: str) -> WebSocketConnection:
            return connection

        feed = DhanFeed(
            access_token="t",
            client_id="c",
            catalogue=lambda: catalogue,
            registry=lambda: empty,
            clock=ReplayClock(T0),
            connector=connector,
        )
        await feed.connect()
        await feed.subscribe([CALL])

        events = [event async for event in feed.events()]

        problems = [e for e in events if isinstance(e, FeedProblem)]
        assert "not in today's master" in problems[0].detail
        assert str(CALL) in problems[0].detail
