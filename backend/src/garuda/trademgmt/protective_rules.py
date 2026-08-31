"""Pricing a stop and a target so the exchange will accept them.

A protective order that is rejected is worse than one that is late: the engine
records that it tried, the position is uncovered, and nothing says so until the
market moves. Most of what follows exists to stop that happening, and each rule
comes from a case where it did.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from enum import StrEnum

from garuda.domain.enums import Direction, OrderType
from garuda.domain.instrument import Instrument
from garuda.domain.market import PriceBand
from garuda.domain.money import Money
from garuda.domain.order import Side
from garuda.domain.trade import Trade


class DeferReason(StrEnum):
    """Why a protective order is not being sent yet. All are temporary."""

    NO_QUOTE = "NO_QUOTE"
    ABOVE_UPPER_CIRCUIT = "ABOVE_UPPER_CIRCUIT"
    BELOW_LOWER_CIRCUIT = "BELOW_LOWER_CIRCUIT"


def exit_side(direction: Direction) -> Side:
    """Closing a long sells; closing a short buys."""
    return Side.SELL if direction is Direction.LONG else Side.BUY


def closing_direction(side: Side) -> Direction:
    """The other way round: which position a side would be closing.

    An exit arrives as a side and the book is keyed by direction, so the two
    have to meet somewhere. Written as the inverse of `exit_side` rather than
    beside it, so the pair cannot drift.
    """
    return Direction.LONG if side is Side.SELL else Direction.SHORT


def protectable_quantity(trade: Trade) -> int:
    """How much there is to protect: what filled, never what was ordered.

    A stop for the full order size while only part has filled would, if hit,
    close the position and open an opposite one for the remainder.
    """
    return trade.filled_quantity


def has_no_stop_configured(trade: Trade) -> bool:
    """Whether this trade was never meant to have a stop order of its own.

    Distinct from one whose stop has not been computed yet. A leg governed by
    a combined stop across a group has no level of its own and never will; the
    reference engine warned about it once a second, all day, until it learned
    to tell the two apart.
    """
    protection = trade.protection
    return (
        protection.no_stop_loss
        or protection.dont_place_stop_loss_order
        or protection.stop_loss is None
    )


def stop_already_breached(direction: Direction, stop: Money, last: Money) -> bool:
    """Whether the market has already gone past where the stop would fire."""
    return last < stop if direction is Direction.LONG else last > stop


def stop_at_market(direction: Direction, last: Money, instrument: Instrument) -> Money:
    """A stop placed just beyond the current price, so it triggers at once.

    Used when the market has already passed the configured level. Sending the
    original level would be rejected as un-triggerable, leaving the position
    with nothing; placing at the market gets out now, which is what the stop
    was for.
    """
    step = instrument.tick_size
    if direction is Direction.LONG:
        return instrument.quantize_price(
            Money(last.amount - step, last.currency), rounding=ROUND_DOWN
        )
    return instrument.quantize_price(Money(last.amount + step, last.currency), rounding=ROUND_UP)


def trigger_to_limit_gap(configured: Decimal | None, segment_limit: Decimal) -> Decimal:
    """The gap to use, never wider than the venue permits.

    A strategy may ask for a wider gap than the broker's per-segment default,
    and up to a point that is its business. Beyond what the exchange accepts it
    is not: an equity stop must stay inside the permissible execution range,
    and one sized like an option's is rejected every time it is sent.
    """
    if configured is None or configured <= 0:
        return segment_limit
    return min(configured, segment_limit)


@dataclass(frozen=True, slots=True)
class StopOrderShape:
    order_type: OrderType
    trigger_price: Money
    price: Money | None = None


def stop_order_shape(
    direction: Direction,
    stop: Money,
    instrument: Instrument,
    gap_percent: Decimal | None,
) -> StopOrderShape:
    """The order that carries a stop.

    With no gap configured it is a stop-market: triggered at the level and
    filled at whatever is there. With a gap it is a stop-limit, whose limit
    sits on the far side of the trigger -- below it when selling out of a long,
    above it when buying back a short -- because the limit has to be reachable
    once the trigger fires.
    """
    if gap_percent is None or gap_percent <= 0:
        return StopOrderShape(OrderType.SL_MARKET, trigger_price=stop)

    buffer = stop.amount * gap_percent / 100
    closing_a_long = direction is Direction.LONG
    limit = Money(stop.amount - buffer if closing_a_long else stop.amount + buffer, stop.currency)
    return StopOrderShape(
        OrderType.SL_LIMIT,
        trigger_price=stop,
        # Toward the trigger, so snapping to the tick cannot push the limit
        # outside the band the gap was sized to respect.
        price=instrument.quantize_price(limit, rounding=ROUND_UP if closing_a_long else ROUND_DOWN),
    )


def stop_within_circuit(
    stop: Money,
    band: PriceBand,
    instrument: Instrument,
    direction: Direction,
    gap_percent: Decimal,
) -> Money:
    """Pull a stop in so its limit price stays inside the day's band.

    Buying back a short places the limit *above* the trigger, and on a fast
    option that limit can land above the upper circuit -- where the exchange
    refuses it outright. Lowering the trigger until the limit fits keeps the
    protection in place; leaving it means no protection at all.
    """
    if direction is not Direction.SHORT or band.upper is None or gap_percent <= 0:
        return stop

    limit = stop.amount + stop.amount * gap_percent / 100
    if limit <= band.upper.amount:
        return stop

    # The highest trigger whose limit still fits under the circuit.
    fitted = band.upper.amount / (1 + gap_percent / 100)
    return instrument.quantize_price(Money(fitted, stop.currency), rounding=ROUND_DOWN)


def target_defer_reason(
    target: Money, band: PriceBand | None, *, is_market: bool
) -> DeferReason | None:
    """Why a target cannot be sent yet, or None when it can.

    A market exit is never deferred -- getting out is the point, and there is
    no price to be out of band. A limit target outside the band would be
    rejected, so it waits: the band moves during the day, and a target that is
    unreachable at ten may be perfectly placeable at two.
    """
    if is_market:
        return None
    if band is None or not band.is_known:
        return DeferReason.NO_QUOTE
    if band.upper is not None and target > band.upper:
        return DeferReason.ABOVE_UPPER_CIRCUIT
    if band.lower is not None and target < band.lower:
        return DeferReason.BELOW_LOWER_CIRCUIT
    return None
