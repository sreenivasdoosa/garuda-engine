"""Dhan's binary feed, decoded.

Every offset here is checked against a frame built to the layout the reference
implementation reads, because none of it can be inferred from the bytes alone.
The case that matters most is the index one: an index is its own response code
with its own layout, and decoding it as a tradable reads the wrong fields.
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime

import pytest

from garuda.marketdata.providers.dhan_packets import (
    INDEX_SEGMENT,
    PKT_FULL,
    PKT_INDEX,
    PKT_QUOTE,
    PKT_TICKER,
    RC_SUBSCRIBE_FULL,
    RC_SUBSCRIBE_QUOTE,
    decode,
    subscribe_code,
    to_instant,
)

NOW = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)
LTT = int(datetime(2026, 9, 1, 5, 30, tzinfo=UTC).timestamp())


def header(code: int, length: int, segment: int, security_id: int) -> bytes:
    return struct.pack("<BHBi", code, length, segment, security_id)


def index_packet(value: float = 24500.5, security_id: int = 13) -> bytes:
    return header(PKT_INDEX, 16, INDEX_SEGMENT, security_id) + struct.pack("<fi", value, LTT)


def ticker_packet(price: float = 101.5, security_id: int = 500) -> bytes:
    return header(PKT_TICKER, 16, 2, security_id) + struct.pack("<fi", price, LTT)


def quote_packet(security_id: int = 500) -> bytes:
    body = struct.pack(
        "<fHifIIIffff",
        101.5,  # last traded price
        7,  # last traded quantity
        LTT,
        100.25,  # average price
        5000,  # volume
        900,  # total sell quantity
        1100,  # total buy quantity
        99.0,  # open
        98.0,  # close
        103.0,  # high
        97.0,  # low
    )
    return header(PKT_QUOTE, 50, 2, security_id) + body


class TestIndices:
    def test_an_index_packet_is_decoded_as_an_index(self) -> None:
        packets, _ = decode(index_packet(), NOW)

        assert len(packets) == 1
        assert packets[0].is_index is True
        assert packets[0].last_traded_price == pytest.approx(24500.5)
        assert packets[0].segment == INDEX_SEGMENT

    def test_an_index_carries_no_quantity_depth_or_open_interest(self) -> None:
        """It has none. Reading them from the tradable offsets would produce
        numbers out of the next packet's bytes."""
        packets, _ = decode(index_packet(), NOW)

        packet = packets[0]
        assert packet.last_traded_quantity is None
        assert packet.volume is None
        assert packet.open_interest is None
        assert packet.bids == []

    def test_an_index_subscribes_in_quote_mode(self) -> None:
        """Dhan ignores a depth request for an index, and an index subscribed
        in FULL mode never ticks at all."""
        assert subscribe_code(INDEX_SEGMENT, subscribe=True) == RC_SUBSCRIBE_QUOTE

    def test_a_tradable_subscribes_in_full_mode(self) -> None:
        assert subscribe_code(2, subscribe=True) == RC_SUBSCRIBE_FULL


class TestTradables:
    def test_a_ticker_packet_carries_only_a_price_and_a_time(self) -> None:
        packets, _ = decode(ticker_packet(), NOW)

        assert packets[0].last_traded_price == pytest.approx(101.5)
        assert packets[0].last_traded_quantity is None

    def test_a_quote_packet_carries_the_days_ohlc(self) -> None:
        packets, _ = decode(quote_packet(), NOW)

        packet = packets[0]
        assert packet.last_traded_quantity == 7
        assert packet.average_price == pytest.approx(100.25)
        assert packet.volume == 5000
        assert packet.total_sell_quantity == 900
        assert packet.total_buy_quantity == 1100
        assert packet.open == pytest.approx(99.0)
        assert packet.close == pytest.approx(98.0)
        assert packet.high == pytest.approx(103.0)
        assert packet.low == pytest.approx(97.0)

    def test_a_full_packet_carries_open_interest_and_five_levels_of_depth(self) -> None:
        body = bytearray(154)
        struct.pack_into("<fHif", body, 0, 101.5, 7, LTT, 100.25)
        struct.pack_into("<III", body, 14, 5000, 900, 1100)
        struct.pack_into("<I", body, 26, 4321)  # open interest, where QUOTE has open
        struct.pack_into("<ffff", body, 38, 99.0, 98.0, 103.0, 97.0)
        for level in range(5):
            at = 54 + level * 20
            # Both quantities, then both prices -- not the order they display.
            struct.pack_into("<II", body, at, 10 + level, 20 + level)
            struct.pack_into("<ff", body, at + 12, 100.0 - level, 101.0 + level)
        frame = header(PKT_FULL, 162, 2, 500) + bytes(body)

        packets, _ = decode(frame, NOW)

        packet = packets[0]
        assert packet.open_interest == 4321
        assert packet.open == pytest.approx(99.0)
        assert len(packet.bids) == 5
        assert packet.bids[0].quantity == 10
        assert packet.bids[0].price == pytest.approx(100.0)
        assert packet.asks[0].quantity == 20
        assert packet.asks[0].price == pytest.approx(101.0)


class TestFraming:
    def test_several_packets_arrive_in_one_frame(self) -> None:
        """Dhan batches. Reading only the first would drop the rest silently."""
        frame = (
            index_packet(security_id=13)
            + ticker_packet(security_id=500)
            + quote_packet(security_id=501)
        )

        packets, _ = decode(frame, NOW)

        assert [p.security_id for p in packets] == [13, 500, 501]

    def test_a_truncated_frame_stops_rather_than_reading_past_the_end(self) -> None:
        packets, _ = decode(index_packet()[:12], NOW)

        assert packets == []

    def test_a_disconnect_packet_is_reported_separately(self) -> None:
        frame = header(50, 10, 0, 0) + struct.pack("<H", 805)

        packets, disconnects = decode(frame, NOW)

        assert packets == []
        assert disconnects[0].is_too_many_connections is True

    def test_an_unknown_code_is_skipped_by_its_own_length(self) -> None:
        unknown = header(99, 12, 2, 7) + b"\x00" * 4
        frame = unknown + ticker_packet(security_id=500)

        packets, _ = decode(frame, NOW)

        assert [p.security_id for p in packets] == [500]


class TestTimestamps:
    def test_a_plausible_time_is_taken_as_it_is(self) -> None:
        assert to_instant(LTT, NOW) == datetime.fromtimestamp(LTT, UTC)

    def test_a_time_far_in_the_future_is_an_ist_encoded_one(self) -> None:
        """Some packets carry the time already shifted into IST. A trade cannot
        be an hour in the future, so that is what it is."""
        shifted = int(NOW.timestamp()) + 5 * 3600 + 30 * 60

        assert to_instant(shifted, NOW) == datetime.fromtimestamp(
            shifted - (5 * 3600 + 30 * 60), UTC
        )

    def test_a_missing_time_falls_back_to_now(self) -> None:
        assert to_instant(0, NOW) == NOW
