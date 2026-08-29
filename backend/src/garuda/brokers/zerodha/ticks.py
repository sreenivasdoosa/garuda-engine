"""The Kite streaming quote protocol, decoded from the wire.

The reference engine used Zerodha's SDK for this. We do not: an SDK owns its
own URLs, so its traffic cannot be routed through the proxy an IP-whitelisted
account needs, and it decides for itself what a malformed packet means.

Kite sends a binary frame holding several packets, one per instrument, and the
packet's *length* is what says which fields it carries -- there is no type tag:

===========  ==========================================================
Bytes        Packet
===========  ==========================================================
8            LTP only
28           index quote: no depth, no volume, no timestamp
32           index full: the above plus an exchange timestamp
44           quote: OHLC, volume, buy/sell quantity, no depth
184          full: the above plus open interest and five levels each side
===========  ==========================================================

Anything else is recorded and dropped rather than decoded on a guess. Reading
a price at the wrong offset does not fail -- it produces a plausible number,
which is how a decoder error becomes a trade.

Every integer is big-endian and signed. Prices are in paise and divided by a
factor that depends on the segment, which is the low byte of the instrument
token.
"""

from __future__ import annotations

import struct
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from garuda.domain.instrument import Instrument
from garuda.domain.market import DepthLevel, Tick
from garuda.domain.money import Money

#: The low byte of an instrument token. Zerodha's own numbering.
NSE, NFO, CDS, BSE, BFO, BCD, MCX, MCXSX, INDICES = range(1, 10)

#: Currency derivatives quote to four decimal places, everything else to two.
_DIVISORS = {CDS: Decimal(10_000_000), BCD: Decimal(10_000)}
_DEFAULT_DIVISOR = Decimal(100)

#: Bytes per depth rung: quantity, price, order count, two bytes of padding.
DEPTH_ENTRY_SIZE = 12
DEPTH_LEVELS = 5

_LTP_PACKET = 8
_INDEX_QUOTE_PACKET = 28
_INDEX_FULL_PACKET = 32
_QUOTE_PACKET = 44
_FULL_PACKET = 184

#: Resolves a broker token to the instrument it stands for. A token the engine
#: cannot resolve is reported rather than dropped silently: it means the
#: subscription and the instrument master disagree, which is a real fault.
type TokenResolver = Callable[[int], Instrument | None]


@dataclass(frozen=True, slots=True)
class TickBatch:
    """One decoded frame."""

    ticks: tuple[Tick, ...] = ()
    #: Tokens that ticked but are not in today's master.
    unresolved: tuple[int, ...] = ()
    #: Packets that could not be decoded, with why.
    malformed: tuple[str, ...] = ()

    @property
    def is_empty(self) -> bool:
        return not (self.ticks or self.unresolved or self.malformed)


def segment_of(token: int) -> int:
    return token & 0xFF


def price_divisor(token: int) -> Decimal:
    return _DIVISORS.get(segment_of(token), _DEFAULT_DIVISOR)


def is_index(token: int) -> bool:
    """Indices are quoted but not traded: no volume, no depth, no book."""
    return segment_of(token) == INDICES


def parse_frame(payload: bytes, resolve: TokenResolver, now: datetime) -> TickBatch:
    """Decode one binary frame into ticks.

    ``now`` is the fallback timestamp for the packet types that carry none.
    It is a parameter rather than a clock read so this stays a pure function
    and a recorded frame replays to the same ticks.
    """
    if len(payload) < 4:
        # A one-byte frame is Kite's heartbeat; anything shorter than an
        # envelope carries no packets either way.
        return TickBatch()

    (count,) = struct.unpack_from(">h", payload, 0)
    if count <= 0:
        return TickBatch()

    ticks: list[Tick] = []
    unresolved: list[int] = []
    malformed: list[str] = []
    offset = 2

    for index in range(count):
        if offset + 2 > len(payload):
            malformed.append(f"frame ended after {index} of {count} packets")
            break
        (length,) = struct.unpack_from(">h", payload, offset)
        offset += 2
        if length <= 0 or offset + length > len(payload):
            malformed.append(f"packet {index} claims {length} bytes, frame has {len(payload)}")
            break

        packet = payload[offset : offset + length]
        offset += length
        _decode_into(packet, resolve, now, ticks, unresolved, malformed)

    return TickBatch(tuple(ticks), tuple(unresolved), tuple(malformed))


def _decode_into(
    packet: bytes,
    resolve: TokenResolver,
    now: datetime,
    ticks: list[Tick],
    unresolved: list[int],
    malformed: list[str],
) -> None:
    if len(packet) < 4:
        malformed.append(f"a {len(packet)}-byte packet cannot hold a token")
        return
    if len(packet) not in (
        _LTP_PACKET,
        _INDEX_QUOTE_PACKET,
        _INDEX_FULL_PACKET,
        _QUOTE_PACKET,
        _FULL_PACKET,
    ):
        (token,) = struct.unpack_from(">i", packet, 0)
        malformed.append(f"token {token}: unknown packet length {len(packet)}")
        return

    (token,) = struct.unpack_from(">i", packet, 0)
    instrument = resolve(token)
    if instrument is None:
        unresolved.append(token)
        return

    ticks.append(_decode(packet, instrument, price_divisor(token), now))


def _decode(packet: bytes, instrument: Instrument, divisor: Decimal, now: datetime) -> Tick:
    currency = instrument.exchange.currency

    def price(raw: int) -> Money:
        return Money(Decimal(raw) / divisor, currency)

    last_price = price(_int32(packet, 4))

    if len(packet) == _LTP_PACKET:
        return Tick(instrument.id, last_price, now)

    if len(packet) in (_INDEX_QUOTE_PACKET, _INDEX_FULL_PACKET):
        timestamp = now
        if len(packet) == _INDEX_FULL_PACKET:
            timestamp = _exchange_time(_int32(packet, 28), now)
        return Tick(
            instrument.id,
            last_price,
            timestamp,
            high=price(_int32(packet, 8)),
            low=price(_int32(packet, 12)),
            open=price(_int32(packet, 16)),
            previous_close=price(_int32(packet, 20)),
        )

    # Named rather than splatted from a dict: a mistyped key in a dict of
    # kwargs is a silently dropped field, and a dropped previous close is a
    # strategy filter that never fires.
    quote_fields = _QuoteFields(
        last_quantity=_quantity(packet, 8),
        average_price=price(_int32(packet, 12)),
        volume=_quantity(packet, 16),
        total_buy_quantity=_quantity(packet, 20),
        total_sell_quantity=_quantity(packet, 24),
        open=price(_int32(packet, 28)),
        high=price(_int32(packet, 32)),
        low=price(_int32(packet, 36)),
        previous_close=price(_int32(packet, 40)),
    )

    if len(packet) == _QUOTE_PACKET:
        return quote_fields.tick(instrument, last_price, now)

    bids, asks = _depth(packet, price)
    return quote_fields.tick(
        instrument,
        last_price,
        _exchange_time(_int32(packet, 60), now),
        open_interest=_quantity(packet, 48),
        open_interest_day_high=_quantity(packet, 52),
        open_interest_day_low=_quantity(packet, 56),
        bids=bids,
        asks=asks,
    )


@dataclass(frozen=True, slots=True)
class _QuoteFields:
    """The nine fields a quote packet and a full packet share."""

    last_quantity: int | None
    average_price: Money
    volume: int | None
    total_buy_quantity: int | None
    total_sell_quantity: int | None
    open: Money
    high: Money
    low: Money
    previous_close: Money

    def tick(
        self,
        instrument: Instrument,
        last_price: Money,
        timestamp: datetime,
        *,
        open_interest: int | None = None,
        open_interest_day_high: int | None = None,
        open_interest_day_low: int | None = None,
        bids: tuple[DepthLevel, ...] = (),
        asks: tuple[DepthLevel, ...] = (),
    ) -> Tick:
        return Tick(
            instrument.id,
            last_price,
            timestamp,
            last_quantity=self.last_quantity,
            average_price=self.average_price,
            volume=self.volume,
            total_buy_quantity=self.total_buy_quantity,
            total_sell_quantity=self.total_sell_quantity,
            open=self.open,
            high=self.high,
            low=self.low,
            previous_close=self.previous_close,
            open_interest=open_interest,
            open_interest_day_high=open_interest_day_high,
            open_interest_day_low=open_interest_day_low,
            bids=bids,
            asks=asks,
        )


def _depth(
    packet: bytes, price: Callable[[int], Money]
) -> tuple[tuple[DepthLevel, ...], tuple[DepthLevel, ...]]:
    """The five bid rungs then the five ask rungs, best price first.

    Empty rungs are dropped rather than carried as a price of zero. A thin
    book pads the ladder with zeros, and a zero that reaches a spread check
    reads as a market offering to buy at nothing -- fail closed by having no
    depth instead of impossible depth.

    Sorted explicitly rather than trusted in wire order: the cost is nothing
    and a book delivered the other way round inverts every spread that reads
    it.
    """
    sides: list[list[DepthLevel]] = [[], []]
    for rung in range(2 * DEPTH_LEVELS):
        base = 64 + rung * DEPTH_ENTRY_SIZE
        quantity = _int32(packet, base)
        raw_price = _int32(packet, base + 4)
        (orders,) = struct.unpack_from(">h", packet, base + 8)
        if raw_price <= 0 or quantity <= 0:
            continue
        sides[0 if rung < DEPTH_LEVELS else 1].append(
            DepthLevel(price(raw_price), quantity, max(orders, 0))
        )

    bids = sorted(sides[0], key=lambda level: level.price, reverse=True)
    asks = sorted(sides[1], key=lambda level: level.price)
    return tuple(bids), tuple(asks)


def _int32(packet: bytes, offset: int) -> int:
    (value,) = struct.unpack_from(">i", packet, offset)
    return int(value)


def _quantity(packet: bytes, offset: int) -> int | None:
    """A count from the wire, or None when it came back negative.

    These are unsigned quantities sent in a signed field. A negative one means
    the value overflowed thirty-two bits on the way out, and reporting no
    volume is honest where reporting minus two billion is not.
    """
    value = _int32(packet, offset)
    return value if value >= 0 else None


def _exchange_time(epoch_seconds: int, fallback: datetime) -> datetime:
    """The exchange's own timestamp, or the fallback when it sent none.

    Zero is not midnight in 1970 here, it is an absent value, and a tick
    stamped 1970 sorts before every other tick the engine holds.
    """
    if epoch_seconds <= 0:
        return fallback
    return datetime.fromtimestamp(epoch_seconds, tz=UTC)
