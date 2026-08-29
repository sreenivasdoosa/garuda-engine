"""Where a trailing stop should be, given what the market has done.

Pure arithmetic: prices and a configuration in, a new stop level or nothing
out. Deciding whether to act on it, and how to move the order, is elsewhere.

**A trailing stop only ever tightens.** Every calculation here returns where
the stop *could* be; the caller refuses anything that would loosen it. That
rule is not a detail -- a stop that can move away from the price is not a stop,
and a calculator that momentarily reads a lower high would give back
everything the position had earned.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_UP, Decimal
from enum import StrEnum

from garuda.domain.enums import Direction
from garuda.domain.instrument import Instrument
from garuda.domain.money import Money


class TrailingMode(StrEnum):
    """How a stop follows the price.

    Only ``RISK_MULTIPLE`` is implemented: it needs nothing but the price, and
    the rest need candle history and indicators the engine does not have yet.
    They are named here so a configuration carrying one is refused loudly
    rather than silently trailing some other way.
    """

    RISK_MULTIPLE = "RISK_MULTIPLE"
    ATR = "ATR"
    EMA = "EMA"
    SUPER_TREND = "SUPER_TREND"
    HEIKIN_ASHI = "HEIKIN_ASHI"
    CUSTOM = "CUSTOM"

    @property
    def needs_candles(self) -> bool:
        return self is not TrailingMode.RISK_MULTIPLE


class GapUnit(StrEnum):
    """Whether a configured gap is in points or in per cent of the entry."""

    ABSOLUTE = "ABSOLUTE"
    PERCENTAGE = "PERCENTAGE"
    #: Multiples of the initial risk -- the distance from entry to first stop.
    RISK_MULTIPLE = "RISK_MULTIPLE"


@dataclass(frozen=True, slots=True)
class TrailConfig:
    """What a strategy asked for when it turned trailing on."""

    mode: TrailingMode = TrailingMode.RISK_MULTIPLE
    #: How much profit earns one step of trailing. Defaults to one unit of
    #: initial risk, which is what "R-multiple" means.
    profit_gap: Decimal | None = None
    #: How far the stop moves per step. Defaults to the same.
    stop_move_gap: Decimal | None = None
    gap_unit: GapUnit = GapUnit.ABSOLUTE
    #: Profit at which the stop moves to break even, once.
    trail_to_cost_gap: Decimal | None = None
    trail_to_cost_unit: GapUnit = GapUnit.RISK_MULTIPLE


def initial_risk(entry: Money, initial_stop: Money) -> Decimal:
    """The distance from entry to the first stop -- one unit of risk."""
    return abs(entry.amount - initial_stop.amount)


def _as_points(gap: Decimal, unit: GapUnit, entry: Money, risk: Decimal) -> Decimal:
    match unit:
        case GapUnit.PERCENTAGE:
            return entry.amount * gap / 100
        case GapUnit.RISK_MULTIPLE:
            return gap * risk
        case _:
            return gap


def improves(direction: Direction, new_stop: Money, current: Money) -> bool:
    """Whether moving the stop there tightens it.

    Tighter means closer to the price on the side the position is exposed:
    upward for a long, downward for a short.
    """
    return new_stop > current if direction is Direction.LONG else new_stop < current


def risk_multiple_stop(
    *,
    direction: Direction,
    entry: Money,
    initial_stop: Money,
    extreme: Money,
    config: TrailConfig,
    instrument: Instrument,
) -> Money | None:
    """Trail the stop one step for each step of profit earned.

    ``extreme`` is the best the market has been since entry -- the high for a
    long, the low for a short. Measuring from the extreme rather than the
    current price is the point: profit already earned counts even if the
    market has since come back.

    The step count is whole. A position two and a half steps in profit moves
    its stop two steps, not two and a half, so the level does not jitter with
    every tick.
    """
    risk = initial_risk(entry, initial_stop)
    if risk <= 0:
        # No distance between entry and stop means no unit to measure in.
        return None

    profit_gap = _as_points(
        config.profit_gap if config.profit_gap is not None else risk,
        config.gap_unit,
        entry,
        risk,
    )
    move_gap = _as_points(
        config.stop_move_gap if config.stop_move_gap is not None else risk,
        config.gap_unit,
        entry,
        risk,
    )
    if profit_gap <= 0:
        return None

    profit = (
        extreme.amount - entry.amount
        if direction is Direction.LONG
        else entry.amount - extreme.amount
    )
    steps = int(profit / profit_gap)
    if steps < 1:
        return None

    moved = (
        initial_stop.amount + steps * move_gap
        if direction is Direction.LONG
        else initial_stop.amount - steps * move_gap
    )
    return instrument.quantize_price(
        Money(moved, entry.currency),
        # Toward the entry, so rounding never places the stop further away
        # than the calculation intended.
        rounding=ROUND_DOWN if direction is Direction.LONG else ROUND_UP,
    )


def trail_to_cost_stop(
    *,
    direction: Direction,
    entry: Money,
    initial_stop: Money,
    last: Money,
    config: TrailConfig,
    instrument: Instrument,
) -> Money | None:
    """Move the stop to break even once the position is far enough ahead.

    A one-time move, and the most valuable one: it converts a position that
    can lose into one that cannot. Measured from the current price rather than
    the extreme, because a position that has given its profit back should not
    have its stop pulled up to a level the market has already passed.
    """
    if config.trail_to_cost_gap is None:
        return None
    risk = initial_risk(entry, initial_stop)
    if risk <= 0:
        return None

    threshold = _as_points(config.trail_to_cost_gap, config.trail_to_cost_unit, entry, risk)
    profit = (
        last.amount - entry.amount if direction is Direction.LONG else entry.amount - last.amount
    )
    if profit < threshold:
        return None
    return instrument.quantize_price(entry)
