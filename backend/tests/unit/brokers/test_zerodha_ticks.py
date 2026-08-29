"""Decoding Kite's binary quote frames.

Every claim here is about bytes in and ticks out. The frames are assembled
field by field from the published layout rather than captured from a session,
so a wrong offset shows up as a wrong value in a named field instead of as a
plausible number nobody questions.
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.brokers.zerodha.ticks import (
    BCD,
    CDS,
    INDICES,
    NFO,
    NSE,
    TickBatch,
    TokenResolver,
    is_index,
    parse_frame,
    price_divisor,
)
from garuda.domain import Currency, Money
from garuda.domain.instrument import Instrument

NOW = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
#: 2026-08-31 09:20:00 UTC as Kite sends it: seconds since the epoch.
EXCHANGE_EPOCH = int(datetime(2026, 8, 31, 3, 50, tzinfo=UTC).timestamp())

#: Tokens carry their segment in the low byte, so these are not arbitrary.
CALL_TOKEN = (12345 << 8) | NFO
INDEX_TOKEN = (256 << 8) | INDICES
EQUITY_TOKEN = (2885 << 8) | NSE


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def frame(*packets: bytes) -> bytes:
    body = b"".join(struct.pack(">h", len(p)) + p for p in packets)
    return struct.pack(">h", len(packets)) + body


def ltp_packet(token: int, paise: int) -> bytes:
    return struct.pack(">ii", token, paise)


def index_packet(
    token: int,
    *,
    last: int,
    high: int,
    low: int,
    open_: int,
    close: int,
    change: int = 0,
    exchange_time: int | None = None,
) -> bytes:
    packet = struct.pack(">iiiiiii", token, last, high, low, open_, close, change)
    if exchange_time is not None:
        packet += struct.pack(">i", exchange_time)
    return packet


def quote_packet(
    token: int,
    *,
    last: int = 12_000,
    last_quantity: int = 75,
    average: int = 11_950,
    volume: int = 1_200_000,
    buy_quantity: int = 4_500,
    sell_quantity: int = 5_200,
    open_: int = 11_000,
    high: int = 12_500,
    low: int = 10_800,
    close: int = 11_200,
) -> bytes:
    return struct.pack(
        ">iiiiiiiiiii",
        token,
        last,
        last_quantity,
        average,
        volume,
        buy_quantity,
        sell_quantity,
        open_,
        high,
        low,
        close,
    )


def depth_entry(quantity: int, price: int, orders: int = 1) -> bytes:
    return struct.pack(">iih", quantity, price, orders) + b"\x00\x00"


def full_packet(
    token: int,
    *,
    open_interest: int = 9_000_000,
    oi_high: int = 9_500_000,
    oi_low: int = 8_700_000,
    exchange_time: int = EXCHANGE_EPOCH,
    last_trade_time: int = EXCHANGE_EPOCH,
    bids: list[bytes] | None = None,
    asks: list[bytes] | None = None,
    **quote: int,
) -> bytes:
    if bids is None:
        bids = [depth_entry(50 * (i + 1), 11_990 - i * 5) for i in range(5)]
    if asks is None:
        asks = [depth_entry(60 * (i + 1), 12_010 + i * 5) for i in range(5)]
    packet = quote_packet(token, **quote)
    packet += struct.pack(">iiiii", last_trade_time, open_interest, oi_high, oi_low, exchange_time)
    return packet + b"".join(bids) + b"".join(asks)


@pytest.fixture
def instruments(
    nifty_call: Instrument, nifty_index: Instrument, reliance: Instrument
) -> TokenResolver:
    by_token = {
        CALL_TOKEN: nifty_call,
        INDEX_TOKEN: nifty_index,
        EQUITY_TOKEN: reliance,
    }
    return by_token.get


class TestTheEnvelope:
    def test_a_heartbeat_carries_no_ticks(self, instruments: TokenResolver) -> None:
        """Kite sends a one-byte frame every couple of seconds."""
        assert parse_frame(b"\x00", instruments, NOW) == TickBatch()

    def test_several_packets_in_one_frame_all_decode(self, instruments: TokenResolver) -> None:
        batch = parse_frame(
            frame(ltp_packet(CALL_TOKEN, 12_000), ltp_packet(EQUITY_TOKEN, 288_500)),
            instruments,
            NOW,
        )
        assert [tick.last_price for tick in batch.ticks] == [rupees("120"), rupees("2885")]

    def test_a_truncated_frame_keeps_what_decoded_and_reports_the_rest(
        self, instruments: TokenResolver
    ) -> None:
        """A short read is a connection problem, not a reason to lose a tick."""
        whole = frame(ltp_packet(CALL_TOKEN, 12_000), ltp_packet(EQUITY_TOKEN, 288_500))
        batch = parse_frame(whole[:-4], instruments, NOW)
        assert [tick.last_price for tick in batch.ticks] == [rupees("120")]
        assert batch.malformed

    def test_a_packet_length_beyond_the_frame_is_refused_not_read(
        self, instruments: TokenResolver
    ) -> None:
        """Trusting the length would read past the buffer or into the next packet."""
        lying = struct.pack(">h", 1) + struct.pack(">h", 184) + ltp_packet(CALL_TOKEN, 12_000)
        batch = parse_frame(lying, instruments, NOW)
        assert batch.ticks == ()
        assert batch.malformed

    def test_an_unknown_packet_length_is_reported_rather_than_guessed(
        self, instruments: TokenResolver
    ) -> None:
        """Decoding on a guess produces a plausible price, which is worse."""
        batch = parse_frame(frame(ltp_packet(CALL_TOKEN, 12_000) + b"\x00" * 3), instruments, NOW)
        assert batch.ticks == ()
        assert "unknown packet length 11" in batch.malformed[0]

    def test_a_token_not_in_todays_master_is_reported(self, instruments: TokenResolver) -> None:
        """The subscription and the master disagree, which is a real fault."""
        batch = parse_frame(frame(ltp_packet((999 << 8) | NFO, 12_000)), instruments, NOW)
        assert batch.ticks == ()
        assert batch.unresolved == ((999 << 8) | NFO,)


class TestPrices:
    def test_paise_become_rupees(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(frame(ltp_packet(CALL_TOKEN, 12_055)), instruments, NOW).ticks
        assert tick.last_price == rupees("120.55")

    def test_a_price_is_exact_not_a_float(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(frame(ltp_packet(CALL_TOKEN, 10)), instruments, NOW).ticks
        assert tick.last_price.amount == Decimal("0.10")
        assert isinstance(tick.last_price.amount, Decimal)

    def test_currency_derivatives_quote_to_four_decimals(self) -> None:
        """A rupee-dollar rate divided by a hundred is wrong by five digits."""
        assert price_divisor((1 << 8) | CDS) == Decimal(10_000_000)
        assert price_divisor((1 << 8) | BCD) == Decimal(10_000)
        assert price_divisor(CALL_TOKEN) == Decimal(100)

    def test_the_segment_is_the_low_byte_of_the_token(self) -> None:
        assert is_index(INDEX_TOKEN)
        assert not is_index(CALL_TOKEN)


class TestIndexPackets:
    def test_an_index_carries_the_days_range_but_no_book(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(
            frame(
                index_packet(
                    INDEX_TOKEN,
                    last=2_500_000,
                    high=2_520_000,
                    low=2_480_000,
                    open_=2_490_000,
                    close=2_495_000,
                )
            ),
            instruments,
            NOW,
        ).ticks
        assert tick.last_price == rupees("25000")
        assert tick.high == rupees("25200")
        assert tick.low == rupees("24800")
        assert tick.open == rupees("24900")
        assert tick.previous_close == rupees("24950")
        assert tick.bids == ()
        assert tick.volume is None

    def test_an_index_without_a_timestamp_is_stamped_on_arrival(
        self, instruments: TokenResolver
    ) -> None:
        (tick,) = parse_frame(
            frame(index_packet(INDEX_TOKEN, last=1, high=1, low=1, open_=1, close=1)),
            instruments,
            NOW,
        ).ticks
        assert tick.timestamp == NOW

    def test_an_index_in_full_mode_carries_the_exchanges_timestamp(
        self, instruments: TokenResolver
    ) -> None:
        (tick,) = parse_frame(
            frame(
                index_packet(
                    INDEX_TOKEN,
                    last=1,
                    high=1,
                    low=1,
                    open_=1,
                    close=1,
                    exchange_time=EXCHANGE_EPOCH,
                )
            ),
            instruments,
            NOW,
        ).ticks
        assert tick.timestamp == datetime.fromtimestamp(EXCHANGE_EPOCH, tz=UTC)


class TestQuotePackets:
    def test_every_field_lands_where_it_belongs(self, instruments: TokenResolver) -> None:
        """Each value is distinct, so a swapped pair of offsets cannot pass."""
        (tick,) = parse_frame(
            frame(
                quote_packet(
                    CALL_TOKEN,
                    last=12_000,
                    last_quantity=75,
                    average=11_950,
                    volume=1_200_000,
                    buy_quantity=4_500,
                    sell_quantity=5_200,
                    open_=11_000,
                    high=12_500,
                    low=10_800,
                    close=11_200,
                )
            ),
            instruments,
            NOW,
        ).ticks
        assert tick.last_price == rupees("120")
        assert tick.last_quantity == 75
        assert tick.average_price == rupees("119.50")
        assert tick.volume == 1_200_000
        assert tick.total_buy_quantity == 4_500
        assert tick.total_sell_quantity == 5_200
        assert tick.open == rupees("110")
        assert tick.high == rupees("125")
        assert tick.low == rupees("108")
        assert tick.previous_close == rupees("112")

    def test_a_quote_packet_carries_no_depth(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(frame(quote_packet(CALL_TOKEN)), instruments, NOW).ticks
        assert not tick.has_depth

    def test_a_negative_quantity_reads_as_absent_not_as_minus_two_billion(
        self, instruments: TokenResolver
    ) -> None:
        """A count that overflowed its signed field is not a count."""
        (tick,) = parse_frame(
            frame(quote_packet(CALL_TOKEN, volume=-2_000_000_000)), instruments, NOW
        ).ticks
        assert tick.volume is None


class TestFullPackets:
    def test_open_interest_and_its_day_range_decode(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(frame(full_packet(CALL_TOKEN)), instruments, NOW).ticks
        assert tick.open_interest == 9_000_000
        assert tick.open_interest_day_high == 9_500_000
        assert tick.open_interest_day_low == 8_700_000

    def test_the_book_arrives_best_price_first(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(frame(full_packet(CALL_TOKEN)), instruments, NOW).ticks
        assert [level.price for level in tick.bids] == [
            rupees("119.90"),
            rupees("119.85"),
            rupees("119.80"),
            rupees("119.75"),
            rupees("119.70"),
        ]
        assert [level.price for level in tick.asks] == [
            rupees("120.10"),
            rupees("120.15"),
            rupees("120.20"),
            rupees("120.25"),
            rupees("120.30"),
        ]
        assert tick.bid == rupees("119.90")
        assert tick.ask == rupees("120.10")
        assert tick.spread == rupees("0.20")

    def test_quantities_and_order_counts_stay_with_their_rung(
        self, instruments: TokenResolver
    ) -> None:
        (tick,) = parse_frame(frame(full_packet(CALL_TOKEN)), instruments, NOW).ticks
        assert [level.quantity for level in tick.bids] == [50, 100, 150, 200, 250]
        assert tick.bid_quantity == 50
        assert tick.asks[0].quantity == 60

    def test_a_book_delivered_in_reverse_is_still_read_best_first(
        self, instruments: TokenResolver
    ) -> None:
        """Sorting costs nothing; an inverted book inverts every spread check."""
        (tick,) = parse_frame(
            frame(
                full_packet(
                    CALL_TOKEN,
                    bids=[depth_entry(10, 11_970 + i * 5) for i in range(5)],
                    asks=[depth_entry(10, 12_030 - i * 5) for i in range(5)],
                )
            ),
            instruments,
            NOW,
        ).ticks
        assert tick.bid == rupees("119.90")
        assert tick.ask == rupees("120.10")

    def test_empty_rungs_are_dropped_rather_than_priced_at_zero(
        self, instruments: TokenResolver
    ) -> None:
        """A thin book pads with zeros, and a zero bid reads as a free market."""
        (tick,) = parse_frame(
            frame(
                full_packet(
                    CALL_TOKEN,
                    bids=[depth_entry(50, 11_990), *[depth_entry(0, 0) for _ in range(4)]],
                    asks=[depth_entry(60, 12_010), *[depth_entry(0, 0) for _ in range(4)]],
                )
            ),
            instruments,
            NOW,
        ).ticks
        assert len(tick.bids) == 1
        assert tick.bid == rupees("119.90")

    def test_a_book_with_no_bids_at_all_has_no_depth(self, instruments: TokenResolver) -> None:
        (tick,) = parse_frame(
            frame(full_packet(CALL_TOKEN, bids=[depth_entry(0, 0) for _ in range(5)])),
            instruments,
            NOW,
        ).ticks
        assert tick.bids == ()
        assert not tick.has_depth
        assert tick.spread is None

    def test_the_exchange_timestamp_is_preferred_over_arrival(
        self, instruments: TokenResolver
    ) -> None:
        (tick,) = parse_frame(frame(full_packet(CALL_TOKEN)), instruments, NOW).ticks
        assert tick.timestamp == datetime.fromtimestamp(EXCHANGE_EPOCH, tz=UTC)

    def test_a_zero_exchange_timestamp_is_absent_not_nineteen_seventy(
        self, instruments: TokenResolver
    ) -> None:
        """A tick stamped 1970 sorts before every other tick the engine holds."""
        (tick,) = parse_frame(
            frame(full_packet(CALL_TOKEN, exchange_time=0)), instruments, NOW
        ).ticks
        assert tick.timestamp == NOW
