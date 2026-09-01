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

from garuda.domain.enums import Direction
from garuda.domain.instrument import Instrument
from garuda.domain.money import Money
from garuda.domain.trailing import GapUnit, TrailConfig, TrailingMode

HUNDRED = Decimal(100)


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


@dataclass(frozen=True, slots=True)
class CandleMode:
    """Which indicator a trailing mode reads, and how it is shaped by default.

    The defaults are the reference engine's, so a row that names neither
    period nor multiplier trails the way it did there.
    """

    indicator: str
    period: int
    multiplier: Decimal | None = None
    buffer_percent: Decimal = Decimal(0)


#: The modes that read closed bars. A mode absent here is one this engine
#: cannot compute, and the caller reports it by name rather than trailing some
#: other way.
CANDLE_MODES: dict[TrailingMode, CandleMode] = {
    TrailingMode.ATR: CandleMode("atr", period=21, multiplier=Decimal(4)),
    TrailingMode.EMA: CandleMode("ema", period=13, buffer_percent=Decimal("0.05")),
    TrailingMode.SUPER_TREND: CandleMode("supertrend", period=10, multiplier=Decimal(3)),
}


def indicator_for(config: TrailConfig) -> tuple[str, dict[str, object]] | None:
    """Which indicator a candle mode reads, and with what parameters."""
    mode = CANDLE_MODES.get(config.mode)
    if mode is None:
        return None

    params: dict[str, object] = {"period": config.period or mode.period}
    if mode.multiplier is not None:
        params["multiplier"] = config.multiplier or mode.multiplier
    return mode.indicator, params


def reach_of(config: TrailConfig) -> Decimal:
    """The ATR multiple, from the row or from the mode's default."""
    mode = CANDLE_MODES[TrailingMode.ATR]
    multiplier = config.multiplier or mode.multiplier
    return multiplier if multiplier is not None else Decimal(4)


def buffer_of(config: TrailConfig) -> Decimal:
    """How far off the line the stop sits, as a per cent of it."""
    if config.buffer_percent is not None:
        return config.buffer_percent
    mode = CANDLE_MODES.get(config.mode)
    return mode.buffer_percent if mode is not None else Decimal(0)


def candle_stop(
    *,
    direction: Direction,
    line: Money,
    last_close: Money,
    config: TrailConfig,
    instrument: Instrument,
) -> Money | None:
    """Where a candle mode puts the stop, given the indicator it reads.

    Each mode reads one number off closed bars and places the stop a buffer
    away from it, on the losing side. What differs between them is which
    number, and whether the price has to be on the right side of it:

    * **ATR** is a distance, not a level, so the stop sits that far from the
      close. A widening range therefore loosens the level -- which the caller
      refuses, so a volatile bar cannot give back what the position earned.
    * **EMA** and **SuperTrend** are levels, and the stop rides just behind.
    * **SuperTrend** flips sides with the trend, so it only trails while the
      close is on the favourable side of it. On the wrong side the line is
      where the *opposite* position's stop would go, and following it would
      put a long's stop above the price.

    ``None`` when the mode does not apply right now, which is not the same as
    a level that would loosen -- the caller refuses those separately. A wide
    range on a cheap option reaches past the whole premium and puts a long's
    level below nothing; that is refused there too, because a level below
    nothing is below the stop it would replace.
    """
    long_way = direction is Direction.LONG
    buffer = line * (buffer_of(config) / HUNDRED)

    if config.mode is TrailingMode.ATR:
        reach = line * reach_of(config)
        level = last_close - reach if long_way else last_close + reach
    elif config.mode is TrailingMode.SUPER_TREND:
        if (long_way and last_close <= line) or (not long_way and last_close >= line):
            return None
        level = line - buffer if long_way else line + buffer
    else:
        level = line - buffer if long_way else line + buffer

    return instrument.quantize_price(
        level,
        # Toward the entry, so rounding never places the stop further away
        # than the calculation intended.
        rounding=ROUND_DOWN if long_way else ROUND_UP,
    )
