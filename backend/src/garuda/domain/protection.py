"""Market protection: what replaces a MARKET order when one may not be sent.

Ported from the reference engine's single protection module, which is the one
place that decides whether a MARKET or SL-M order may reach a broker as-is and
what marketable LIMIT or SL price stands in when it may not.

**Whether raw market orders are allowed is configuration, per broker and
exchange, and nothing else.** It is not a fact about a broker that can be
written into an adapter: a missing configuration row means not allowed, so
"protected" is the safe posture and sending raw MARKET is the explicit opt-in.
Brokers have moved to limit-only entry -- Kite refuses every raw MARKET and
SL-M with "Market orders without market protection are not allowed via API" --
and a venue that starts refusing them is then a configuration change rather
than a release.

The buffers differ by segment for a reason that cost the reference engine real
rejections: NSE enforces a permissible execution range of roughly three per
cent on stop-loss orders, so equity and futures stay tight at one per cent,
while options need fifteen because their spreads are nothing like as narrow.
Sizing the equity gap like an option's put an INFY stop-loss limit outside the
band and the exchange rejected it fifteen times in a row.

Everything here is pure: prices in, prices out, no configuration lookup and no
live price fetch. That is what makes the arithmetic testable in isolation, and
the arithmetic is the part that moves money.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from enum import StrEnum

from garuda.domain.enums import InstrumentKind
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.money import Money
from garuda.domain.order import Side


class ProtectionSegment(StrEnum):
    """Finer than a venue segment: futures and options price very differently."""

    EQUITY = "EQUITY"
    FUTURES = "FUTURES"
    OPTIONS = "OPTIONS"

    @classmethod
    def of(cls, instrument: Instrument) -> ProtectionSegment:
        if instrument.kind is InstrumentKind.OPTION:
            return cls.OPTIONS
        if instrument.kind is InstrumentKind.FUTURE:
            return cls.FUTURES
        return cls.EQUITY


@dataclass(frozen=True, slots=True)
class SegmentBuffers:
    """How far from the live price a protected order is placed."""

    #: Added to the price when buying, subtracted when selling, to make a
    #: LIMIT order marketable.
    limit_buffer_percent: Decimal
    #: How far the limit of a stop-loss order sits from its trigger.
    sl_gap_percent: Decimal

    def __post_init__(self) -> None:
        for name, value in (
            ("limit buffer", self.limit_buffer_percent),
            ("stop-loss gap", self.sl_gap_percent),
        ):
            if value <= 0:
                raise DomainError(f"a {name} of {value}% would not protect anything")


#: The reference engine's defaults, used wherever configuration leaves a value
#: unset. Equity and futures are tight because the exchange's stop-loss band is
#: tight; options are wide because their spreads are.
DEFAULT_BUFFERS: dict[ProtectionSegment, SegmentBuffers] = {
    ProtectionSegment.EQUITY: SegmentBuffers(Decimal(1), Decimal(1)),
    ProtectionSegment.FUTURES: SegmentBuffers(Decimal(1), Decimal(1)),
    ProtectionSegment.OPTIONS: SegmentBuffers(Decimal(15), Decimal(18)),
}

#: A premium at or under which an option needs a much wider buffer to fill at
#: all. A one-rupee option moves fifteen per cent in a tick.
LOW_PREMIUM_THRESHOLD = Decimal(5)
LOW_PREMIUM_BUY_PERCENT = Decimal(40)
LOW_PREMIUM_SELL_PERCENT = Decimal(20)

#: Options are never priced at or below zero, however wide the buffer.
MINIMUM_OPTION_PRICE = Decimal("0.1")

_HUNDRED = Decimal(100)


def limit_buffer_for(
    segment: ProtectionSegment, buffers: SegmentBuffers, last_price: Money, side: Side
) -> Decimal:
    """The buffer to use, after the low-premium escalation."""
    if segment is ProtectionSegment.OPTIONS and last_price.amount <= LOW_PREMIUM_THRESHOLD:
        return LOW_PREMIUM_BUY_PERCENT if side is Side.BUY else LOW_PREMIUM_SELL_PERCENT
    return buffers.limit_buffer_percent


def marketable_limit_price(
    last_price: Money,
    instrument: Instrument,
    segment: ProtectionSegment,
    buffers: SegmentBuffers,
    side: Side,
) -> Money:
    """The LIMIT price that stands in for a MARKET order.

    Above the live price when buying and below it when selling, so it is
    marketable on arrival rather than resting.

    Rounded away from the live price -- up for a buy, down for a sell -- so
    snapping to the tick can only ever make it more marketable. Rounding to
    nearest can shave the buffer by most of a tick, which on a thin strike is
    the difference between a fill and an order sitting there.
    """
    if last_price.amount <= 0:
        raise DomainError(f"{instrument.id}: cannot protect an order against a price of nothing")

    buffer = limit_buffer_for(segment, buffers, last_price, side)
    factor = (_HUNDRED + buffer) / _HUNDRED if side is Side.BUY else (_HUNDRED - buffer) / _HUNDRED
    rounding = ROUND_UP if side is Side.BUY else ROUND_DOWN
    price = instrument.quantize_price(last_price * factor, rounding=rounding)
    return _floored(price, segment)


def sl_limit_from_trigger(
    trigger_price: Money,
    instrument: Instrument,
    segment: ProtectionSegment,
    buffers: SegmentBuffers,
    side: Side,
) -> Money:
    """The limit price that turns an SL-M order into an SL.

    Above the trigger for a buy stop and below it for a sell stop: the trigger
    is where the market has gone against the position, and the limit has to be
    on the far side of it or the order can never execute.

    Rounded *toward* the trigger, the opposite of a marketable limit, because
    the exchange caps how far a stop-loss limit may sit from its trigger and
    rounding outward can push it past that cap by a fraction of a tick.
    """
    gap = buffers.sl_gap_percent
    factor = (_HUNDRED + gap) / _HUNDRED if side is Side.BUY else (_HUNDRED - gap) / _HUNDRED
    rounding = ROUND_DOWN if side is Side.BUY else ROUND_UP
    price = instrument.quantize_price(trigger_price * factor, rounding=rounding)
    return _floored(price, segment)


def clamp_sl_limit(
    limit_price: Money,
    trigger_price: Money,
    instrument: Instrument,
    segment: ProtectionSegment,
    buffers: SegmentBuffers,
) -> Money:
    """Pull a stop-loss limit back inside the band the exchange permits.

    A limit already within the band is returned untouched -- this widens
    nothing and narrows only what is out of range. Which side it is pulled to
    is taken from where it already sits relative to the trigger, so a caller
    does not have to tell us the side twice.
    """
    if limit_price.amount <= 0 or trigger_price.amount <= 0:
        return limit_price

    maximum_gap = trigger_price.amount * buffers.sl_gap_percent / _HUNDRED
    if abs(limit_price.amount - trigger_price.amount) <= maximum_gap:
        return limit_price

    above = limit_price > trigger_price
    edge = Money(
        trigger_price.amount + maximum_gap if above else trigger_price.amount - maximum_gap,
        trigger_price.currency,
    )
    # Toward the trigger again: rounding outward is how a clamp lands back
    # outside the very band it was applied to enforce.
    price = instrument.quantize_price(edge, rounding=ROUND_DOWN if above else ROUND_UP)
    return _floored(price, segment)


def _floored(price: Money, segment: ProtectionSegment) -> Money:
    """Options never go out at zero, however wide the buffer got."""
    if segment is ProtectionSegment.OPTIONS and price.amount < MINIMUM_OPTION_PRICE:
        return Money(MINIMUM_OPTION_PRICE, price.currency)
    return price
