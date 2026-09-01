"""Decoding Dhan's binary market-data feed.

A line-for-line port of the reference market-data service's `DhanTicker`,
because everything here is a fact about someone else's wire format and none of
it can be inferred. Offsets, packet sizes and the little-endian order are as
that code has them.

**Indices are a separate packet type and must be decoded separately.** Dhan
streams an index (segment `IDX_I`) as response code 1, carrying only the index
value and a last-update time — no traded quantity, no depth, no open interest.
Decoding it with the tradable layout reads the wrong bytes.

The other half of the same fact is on the way out: an index is subscribed in
**QUOTE** mode, not FULL. Dhan ignores a depth request for an index because an
index has no depth, so an index subscribed in FULL mode never ticks at all —
and the symptom is that NIFTY, BANKNIFTY and SENSEX go silent while every
tradable is fine.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass, field
from datetime import UTC, datetime

# -- feed response codes ----------------------------------------------------

PKT_INDEX = 1
PKT_TICKER = 2
PKT_QUOTE = 4
PKT_OI = 5
PKT_PREV_CLOSE = 6
PKT_FULL = 8
PKT_DISCONNECT = 50

#: Bytes per packet, by response code. -1 for a code we do not decode, which
#: makes the reader fall back to the header's own message length.
PACKET_SIZES: dict[int, int] = {
    PKT_INDEX: 16,  # header8 + LTP4 + lastUpdateTime4
    PKT_TICKER: 16,  # header8 + LTP4 + LTT4
    PKT_OI: 12,  # header8 + OI4
    PKT_PREV_CLOSE: 16,  # header8 + prevClose4 + prevOI4
    PKT_DISCONNECT: 10,  # header8 + code2
    PKT_QUOTE: 50,  # header8 + 42
    PKT_FULL: 162,  # header8 + 54 + depth100
}

#: Dhan's segment numbers. Zero is the index segment, which is why an index
#: needs different handling on both the subscribe and the decode.
SEGMENTS: dict[int, str] = {
    0: "IDX_I",
    1: "NSE_EQ",
    2: "NSE_FNO",
    3: "NSE_CURRENCY",
    4: "BSE_EQ",
}
INDEX_SEGMENT = 0

#: Request codes. An index goes in as QUOTE; everything else as FULL.
RC_SUBSCRIBE_FULL = 21
RC_UNSUBSCRIBE_FULL = 22
RC_SUBSCRIBE_QUOTE = 17
RC_UNSUBSCRIBE_QUOTE = 18

#: India is UTC+5:30 and does not observe DST.
IST_OFFSET_SECONDS = 5 * 3600 + 30 * 60
#: A timestamp further ahead than this is an IST-encoded one, not a real time.
FUTURE_TOLERANCE_SECONDS = 3600


@dataclass(slots=True)
class DepthLevel:
    quantity: int
    price: float


@dataclass(slots=True)
class DhanPacket:
    """One decoded packet, in Dhan's own terms.

    Deliberately not a `Tick`: this is the wire, and turning it into the
    engine's shape needs the instrument, which the decoder does not have.
    """

    code: int
    segment: int
    security_id: int
    last_traded_price: float
    timestamp: datetime
    last_traded_quantity: int | None = None
    average_price: float | None = None
    volume: int | None = None
    total_sell_quantity: int | None = None
    total_buy_quantity: int | None = None
    open: float | None = None
    close: float | None = None
    high: float | None = None
    low: float | None = None
    open_interest: int | None = None
    bids: list[DepthLevel] = field(default_factory=list)
    asks: list[DepthLevel] = field(default_factory=list)

    @property
    def is_index(self) -> bool:
        return self.code == PKT_INDEX


@dataclass(slots=True)
class Disconnect:
    """Dhan telling us to go away, with its reason."""

    code: int

    @property
    def is_too_many_connections(self) -> bool:
        """805 means another session took this account's slot."""
        return self.code == 805


def _f32(buf: bytes, at: int) -> float:
    return float(struct.unpack_from("<f", buf, at)[0])


def _i32(buf: bytes, at: int) -> int:
    return int(struct.unpack_from("<i", buf, at)[0])


def _u32(buf: bytes, at: int) -> int:
    return int(struct.unpack_from("<I", buf, at)[0])


def _u16(buf: bytes, at: int) -> int:
    return int(struct.unpack_from("<H", buf, at)[0])


def to_instant(raw: int, now: datetime) -> datetime:
    """Dhan's last-traded time, normalised.

    Some packets carry the time already shifted into IST. A value more than an
    hour ahead of now cannot be a real trade time, so it is one of those and
    the offset comes back off.
    """
    if raw <= 0:
        return now
    epoch = raw & 0xFFFFFFFF
    if epoch - int(now.timestamp()) > FUTURE_TOLERANCE_SECONDS:
        epoch -= IST_OFFSET_SECONDS
    return datetime.fromtimestamp(epoch, UTC)


def decode(frame: bytes, now: datetime) -> tuple[list[DhanPacket], list[Disconnect]]:
    """Every packet in one frame. Dhan batches several into a single message."""
    packets: list[DhanPacket] = []
    disconnects: list[Disconnect] = []
    pos = 0
    limit = len(frame)

    while limit - pos >= 8:
        code = frame[pos]
        segment = frame[pos + 3]
        security_id = _i32(frame, pos + 4)
        size = PACKET_SIZES.get(code, -1)

        if size <= 0 or pos + size > limit:
            # Unknown or truncated: the header's own length is the only way
            # forward, and if that does not fit either the frame is finished.
            message_length = _u16(frame, pos + 1)
            if message_length <= 0 or pos + message_length > limit:
                break
            pos += message_length
            continue

        if code == PKT_DISCONNECT:
            disconnects.append(Disconnect(code=_u16(frame, pos + 8)))
            pos += size
            continue

        if code == PKT_INDEX:
            packets.append(_index_packet(frame, pos, segment, security_id, now))
        elif code in (PKT_TICKER, PKT_QUOTE, PKT_FULL):
            packets.append(_packet(frame, pos, code, segment, security_id, now))
        pos += size

    return packets, disconnects


def _index_packet(
    frame: bytes, pos: int, segment: int, security_id: int, now: datetime
) -> DhanPacket:
    """Response code 1: header(8) + index value(4) + lastUpdateTime(4).

    No quantity, no depth, no open interest — an index has none of them.
    """
    return DhanPacket(
        code=PKT_INDEX,
        segment=segment,
        security_id=security_id,
        last_traded_price=_f32(frame, pos + 8),
        timestamp=to_instant(_i32(frame, pos + 12), now),
    )


def _packet(
    frame: bytes, pos: int, code: int, segment: int, security_id: int, now: datetime
) -> DhanPacket:
    packet = DhanPacket(
        code=code,
        segment=segment,
        security_id=security_id,
        last_traded_price=_f32(frame, pos + 8),
        timestamp=now,
    )

    if code == PKT_TICKER:
        packet.timestamp = to_instant(_i32(frame, pos + 12), now)
        return packet

    # QUOTE and FULL share the same prefix as far as the day's OHLC.
    packet.last_traded_quantity = _u16(frame, pos + 12)
    packet.timestamp = to_instant(_i32(frame, pos + 14), now)
    packet.average_price = _f32(frame, pos + 18)
    packet.volume = _u32(frame, pos + 22)
    packet.total_sell_quantity = _u32(frame, pos + 26)
    packet.total_buy_quantity = _u32(frame, pos + 30)

    if code == PKT_QUOTE:
        packet.open = _f32(frame, pos + 34)
        packet.close = _f32(frame, pos + 38)
        packet.high = _f32(frame, pos + 42)
        packet.low = _f32(frame, pos + 46)
        return packet

    # PKT_FULL: open interest sits where QUOTE's open is, and the day's OHLC
    # moves down by twelve bytes.
    packet.open_interest = _u32(frame, pos + 34)
    packet.open = _f32(frame, pos + 46)
    packet.close = _f32(frame, pos + 50)
    packet.high = _f32(frame, pos + 54)
    packet.low = _f32(frame, pos + 58)
    _depth(frame, pos + 62, packet)
    return packet


def _depth(frame: bytes, start: int, packet: DhanPacket) -> None:
    """Five levels, twenty bytes each.

    Both quantities come before both prices, which is not the order the levels
    are displayed in and is easy to get backwards.
    """
    for level in range(5):
        at = start + level * 20
        packet.bids.append(DepthLevel(quantity=_u32(frame, at), price=_f32(frame, at + 12)))
        packet.asks.append(DepthLevel(quantity=_u32(frame, at + 4), price=_f32(frame, at + 16)))


def subscribe_code(segment: int, *, subscribe: bool) -> int:
    """QUOTE for an index, FULL for anything else.

    Dhan ignores a depth request for an index, and an index subscribed in FULL
    mode simply never ticks.
    """
    if segment == INDEX_SEGMENT:
        return RC_SUBSCRIBE_QUOTE if subscribe else RC_UNSUBSCRIBE_QUOTE
    return RC_SUBSCRIBE_FULL if subscribe else RC_UNSUBSCRIBE_FULL
