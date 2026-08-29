"""Whether to place a signal now, and what order to place.

**No price comparison lives here.** Deciding that a level has been crossed is
the strategy engine's job -- in the reference engine a breakout watcher emits
the signal once the break has happened, and this side only places what it is
given. The signal's ``trigger`` is therefore the price the entry order is
placed *at*, not a level to wait for. Re-checking the price here would mean
two components deciding the same thing, and disagreeing at the edges.

What is left is a set of reasons *not* to place, and the shape of the order
when there is no such reason. Both are pure: a decision in, a decision out.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import ROUND_DOWN, ROUND_UP
from enum import StrEnum

from garuda.domain.enums import Direction, OrderType
from garuda.domain.instrument import Instrument
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.order import Side
from garuda.domain.trade_signal import TradeSignal


class Refusal(StrEnum):
    """Why a signal is not being placed. Every one is reported, never silent."""

    #: Already produced a trade.
    TRIGGERED = "TRIGGERED"
    DISABLED = "DISABLED"
    #: Past the moment after which the strategy said not to act on it.
    EXPIRED = "EXPIRED"
    #: Before the moment the strategy said not to act until. Used to keep an
    #: entry out of the opening auction.
    TOO_EARLY = "TOO_EARLY"
    #: The strategy is no longer subscribed on this account.
    NOT_SUBSCRIBED = "NOT_SUBSCRIBED"
    #: This instrument has been entered as often as the signal allows.
    ENTRY_CAP_REACHED = "ENTRY_CAP_REACHED"


@dataclass(frozen=True, slots=True)
class PlacementDecision:
    """Whether to place, and why not when the answer is no."""

    should_place: bool
    refusal: Refusal | None = None
    detail: str | None = None

    @classmethod
    def yes(cls) -> PlacementDecision:
        return cls(True)

    @classmethod
    def no(cls, refusal: Refusal, detail: str) -> PlacementDecision:
        return cls(False, refusal, detail)


def should_place_trade(
    signal: TradeSignal,
    now: datetime,
    *,
    is_subscribed: bool = True,
    entries_so_far: int = 0,
) -> PlacementDecision:
    """The one gate. Every reason not to place is checked here.

    ``entries_so_far`` counts both directions on this instrument, because the
    cap is on how often the strategy re-enters a name -- reversing after a stop
    is still another entry.
    """
    if signal.is_triggered:
        return PlacementDecision.no(Refusal.TRIGGERED, "this signal has already placed a trade")
    if signal.disabled:
        return PlacementDecision.no(
            Refusal.DISABLED, signal.disabled_reason or "the signal is disabled"
        )
    if signal.has_expired(now):
        return PlacementDecision.no(
            Refusal.EXPIRED,
            f"the signal was only valid until {signal.entry.valid_till}",
        )
    if signal.entry.not_before is not None and now < signal.entry.not_before:
        return PlacementDecision.no(
            Refusal.TOO_EARLY, f"not to be placed before {signal.entry.not_before}"
        )
    if not is_subscribed:
        return PlacementDecision.no(
            Refusal.NOT_SUBSCRIBED,
            f"{signal.strategy} is not subscribed on this account",
        )
    if entries_so_far >= signal.re_entry.max_entries:
        return PlacementDecision.no(
            Refusal.ENTRY_CAP_REACHED,
            f"{signal.instrument} has been entered {entries_so_far} times, "
            f"the cap is {signal.re_entry.max_entries}",
        )
    return PlacementDecision.yes()


# -- the shape of the entry order -------------------------------------------


def side_for(direction: Direction) -> Side:
    """Entering long buys; entering short sells."""
    return Side.BUY if direction is Direction.LONG else Side.SELL


@dataclass(frozen=True, slots=True)
class EntryOrderShape:
    """What kind of order to send, and at what prices."""

    order_type: OrderType
    price: Money | None = None
    trigger_price: Money | None = None


def entry_order_shape(
    signal: TradeSignal, instrument: Instrument, tick: Tick | None
) -> EntryOrderShape:
    """The order that enters this signal.

    A stop-limit entry waits for the market to come to the trigger. If the
    price is already past it, waiting is pointless -- the trigger will never
    be crossed from the right side again -- so a plain order goes instead.
    That check needs a live price; without one the stop-limit stands, because
    guessing the market has moved is worse than a resting order.
    """
    direction = signal.direction
    entry = signal.entry

    if entry.place_market_order:
        return EntryOrderShape(OrderType.MARKET)

    trigger = entry.trigger
    if trigger is None:
        # Nothing to price a limit at. A market order is the honest fallback,
        # and market protection turns it into a marketable limit downstream.
        return EntryOrderShape(OrderType.MARKET)

    wants_stop_limit = entry.entry_with_stop_limit_order and entry.trigger_limit is not None
    still_short_of_trigger = tick is None or not _already_past(direction, tick.last_price, trigger)
    if wants_stop_limit and still_short_of_trigger:
        return EntryOrderShape(OrderType.SL_LIMIT, price=entry.trigger_limit, trigger_price=trigger)

    return EntryOrderShape(OrderType.LIMIT, price=_limit_price(signal, instrument, trigger))


def _already_past(direction: Direction, last: Money, trigger: Money) -> bool:
    """Whether the market has gone beyond where the stop would have fired."""
    return last > trigger if direction is Direction.LONG else last < trigger


def _limit_price(signal: TradeSignal, instrument: Instrument, trigger: Money) -> Money:
    """The trigger, moved by whatever buffer the signal asked for.

    A buffer makes the limit more likely to fill: above the trigger to buy and
    below it to sell. Rounded away from the trigger for the same reason a
    marketable limit is, so snapping to the tick cannot eat the buffer.
    """
    buffer = signal.entry.limit_buffer_percent
    if buffer is None or buffer <= 0:
        return instrument.quantize_price(trigger)

    move = trigger.amount * buffer / 100
    is_buy = signal.direction is Direction.LONG
    adjusted = Money(trigger.amount + move if is_buy else trigger.amount - move, trigger.currency)
    return instrument.quantize_price(adjusted, rounding=ROUND_UP if is_buy else ROUND_DOWN)
