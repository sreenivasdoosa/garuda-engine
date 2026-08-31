"""How a stop follows a price.

The vocabulary a strategy configures trailing with, and nothing that acts on
it -- the arithmetic lives in `trademgmt/trailing_rules.py`. Here in the
domain because it rides on a trade: what a strategy asked for is resolved when
the signal is built, with the day conditions in hand, and has to survive a
restart the same way the stop level itself does.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum


class TrailingMode(StrEnum):
    """How a stop follows the price.

    Only ``RISK_MULTIPLE`` is implemented. It needs nothing but the price,
    while the rest need candle history threaded into the trailing pass -- the
    history and the indicators themselves now exist (`marketdata/history.py`,
    `engine/indicators.py`), so what is missing is the wiring rather than the
    arithmetic. They are named here so a configuration carrying one is refused
    loudly rather than silently trailing some other way.
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
