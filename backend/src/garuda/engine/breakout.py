"""Breakout watches: a tranche that waits for a price to move before it enters.

The reference's `BreakoutWatch` and the watch-building half of its F&O
evaluator (`STRATEGY_ENGINE.md` §4 step 2). When a tranche has
`breakout_enabled`, the scheduled evaluation does not enter: it arms watches
and stands back. The loop checks every armed watch against the live price,
and a breach re-enters the pipeline for that subscription.

Two kinds:

* ``OPTION_SYMBOL`` (the default) -- strikes are chosen at the scheduled
  time as for an immediate entry; each main leg is watched on its own
  premium, and a breach enters that leg (with its hedge) as it was chosen.
* ``UNDERLYING`` -- the underlying itself is watched; a breach on the high
  side trades `breakout_on_high_break` (LONG by default), on the low side
  `breakout_on_low_break` (SHORT), through the ordinary strike selection at
  the moment of the breach.

Trigger levels, the reference's `calculateTriggerPrices`:

* ``PERCENTAGE`` -- reference x (1 +/- value%); the default, 20%;
* ``ABSOLUTE`` -- reference +/- value;
* ``RANGE`` -- a frozen band (`engine/ranges.py`), one watch for each side;
* ``CANDLE_LOW`` -- below the watched option's lowest one-minute low over
  `lookback_minutes`.

`breakout_direction` (ABOVE, BELOW -- the default, for option selling -- or
EITHER) says which crossing counts. A watch lapses at the strategy's stop
time. With `breakout_reversal_mode` NONE or AFTER_CLOSE, the first breach of
an underlying range cancels its opposite watch; PARALLEL leaves it armed.
AFTER_CLOSE's re-arming once the first position closes is not built.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, replace
from decimal import Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.engine.config import ResolvedConfig
from garuda.engine.ranges import RangeSpec
from garuda.engine.vocabulary import (
    BreakoutDirection,
    BreakoutReversalMode,
    BreakoutSide,
    BreakoutTriggerMode,
    BreakoutWatchType,
)

#: The reference's default trigger value: 20%.
DEFAULT_TRIGGER_VALUE = Decimal(20)
HUNDRED = Decimal(100)


@dataclass(frozen=True, slots=True)
class WatchedLeg:
    """A leg a watch will enter when it fires, as chosen at arming time."""

    instrument: InstrumentId
    direction: Direction
    hedge: bool
    option_type: OptionType | None = None
    strike: Decimal | None = None


@dataclass(frozen=True, slots=True)
class Watch:
    """One armed breakout watch for one subscription's tranche."""

    key: str
    trading_client: TradingClientId
    strategy: str
    tranche: int
    kind: BreakoutWatchType
    #: What is watched: the option for OPTION_SYMBOL, the underlying for
    #: UNDERLYING.
    watched: InstrumentId
    direction: BreakoutDirection
    mode: BreakoutTriggerMode
    reference_price: Decimal
    above: Decimal | None
    below: Decimal | None
    valid_till: dt.datetime | None
    group: str
    is_paper: bool = False
    #: For OPTION_SYMBOL: the main leg and its hedge, as chosen when armed.
    legs: tuple[WatchedLeg, ...] = ()
    triggered_at: dt.datetime | None = None
    triggered_price: Decimal | None = None
    expired_at: dt.datetime | None = None

    @property
    def is_live(self) -> bool:
        return self.triggered_at is None and self.expired_at is None

    def breached(self, price: Decimal) -> BreakoutSide | None:
        """The reference's `checkTrigger`, and which side was crossed: high
        for the upper level, low for the lower."""
        if not self.is_live:
            return None
        up = self.above is not None and price >= self.above
        down = self.below is not None and price <= self.below
        if self.direction is BreakoutDirection.ABOVE and up:
            return BreakoutSide.LONG
        if self.direction is BreakoutDirection.BELOW and down:
            return BreakoutSide.SHORT
        if self.direction is BreakoutDirection.EITHER:
            if up:
                return BreakoutSide.LONG
            if down:
                return BreakoutSide.SHORT
        return None

    def fired(self, at: dt.datetime, price: Decimal) -> Watch:
        return replace(self, triggered_at=at, triggered_price=price)

    def lapsed(self, at: dt.datetime) -> Watch:
        return replace(self, expired_at=at)

    def due_to_lapse(self, now: dt.datetime) -> bool:
        return self.is_live and self.valid_till is not None and now > self.valid_till


@dataclass(frozen=True, slots=True)
class BreakoutSettings:
    """A tranche's breakout configuration, read with the reference's defaults."""

    kind: BreakoutWatchType
    direction: BreakoutDirection
    mode: BreakoutTriggerMode
    value: Decimal
    on_high: BreakoutSide
    on_low: BreakoutSide
    reversal: BreakoutReversalMode
    range_spec: RangeSpec | None

    @classmethod
    def of(
        cls, config: ResolvedConfig, provider_params: dict[str, object] | None = None
    ) -> BreakoutSettings:
        params = dict(provider_params or {})

        def pick(column: str, param: str) -> object:
            value = config.values.get(column)
            return value if value not in (None, "") else params.get(param)

        mode = BreakoutTriggerMode.parse(
            config.text("breakout_trigger_mode") or "PERCENTAGE", field="breakoutTriggerMode"
        )
        spec = None
        if mode is BreakoutTriggerMode.RANGE:
            spec = RangeSpec.from_params(
                {
                    "rangeType": pick("breakout_range_type", "rangeType"),
                    "rangeStart": pick("breakout_range_start", "rangeStart"),
                    "rangeEnd": pick("breakout_range_end", "rangeEnd"),
                    "lookbackPeriods": pick("breakout_range_lookback", "lookbackPeriods"),
                }
            )
        return cls(
            kind=BreakoutWatchType.parse(
                config.text("breakout_watch_type") or "OPTION_SYMBOL", field="breakoutWatchType"
            ),
            direction=BreakoutDirection.parse(
                config.text("breakout_direction") or "BELOW", field="breakoutDirection"
            ),
            mode=mode,
            value=config.number("breakout_trigger_value") or DEFAULT_TRIGGER_VALUE,
            on_high=BreakoutSide.parse(
                config.text("breakout_on_high_break") or "LONG", field="breakoutOnHighBreak"
            ),
            on_low=BreakoutSide.parse(
                config.text("breakout_on_low_break") or "SHORT", field="breakoutOnLowBreak"
            ),
            reversal=BreakoutReversalMode.parse(
                config.text("breakout_reversal_mode") or "AFTER_CLOSE", field="breakoutReversalMode"
            ),
            range_spec=spec,
        )

    def levels(self, reference: Decimal) -> tuple[Decimal | None, Decimal | None]:
        """Above and below for PERCENTAGE and ABSOLUTE."""
        if self.mode is BreakoutTriggerMode.PERCENTAGE:
            step = reference * self.value / HUNDRED
        elif self.mode is BreakoutTriggerMode.ABSOLUTE:
            step = self.value
        else:
            raise DomainError(f"{self.mode.value} levels come from history, not the reference")
        return reference + step, reference - step

    def pending_until(self) -> dt.time | None:
        """When a RANGE window closes, if the tranche must wait for it."""
        if self.range_spec is not None and self.range_spec.end is not None:
            return self.range_spec.end
        return None


def watch_key(
    client: TradingClientId, strategy: str, day: dt.date, tranche: int, suffix: str
) -> str:
    return f"{client.value}|{strategy}|{day.isoformat()}|T{tranche}|{suffix}"
