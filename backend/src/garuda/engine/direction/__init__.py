"""Which way to trade.

A direction rule answers LONG, SHORT, or nothing at all. They are configured
as an ordered list and **the first that answers wins**, so a strategy can say
"use the skew, and if it is flat fall back to the candle" — which in the
reference engine needs a new provider class.

Answering nothing is not a veto. A direction rule with no opinion stands the
strategy aside for want of a direction; refusing to trade for a *reason* is an
entry rule's job, and keeping the two apart is what lets "which way" and
"whether at all" be tested separately.

What LONG and SHORT mean to the legs is the legs' business. A short strangle
reads LONG as "sell the put side", an option buyer reads it as "buy the call".
That is `SideRule` on the leg, not a mode here.
"""

from garuda.engine.direction.candles import (
    CandleDirection,
    CandleReference,
    Compare,
    IndicatorDirection,
    LongWhen,
    NBarsBreakout,
    PriceDirection,
    PriceType,
    ReferenceTime,
    SuperTrendDirection,
)
from garuda.engine.direction.registry import (
    DirectionRule,
    build,
    build_all,
    direction,
    first_answer,
    registered,
)
from garuda.engine.direction.simple import Fixed

__all__ = [
    "CandleDirection",
    "CandleReference",
    "Compare",
    "DirectionRule",
    "Fixed",
    "IndicatorDirection",
    "LongWhen",
    "NBarsBreakout",
    "PriceDirection",
    "PriceType",
    "ReferenceTime",
    "SuperTrendDirection",
    "build",
    "build_all",
    "direction",
    "first_answer",
    "registered",
]
