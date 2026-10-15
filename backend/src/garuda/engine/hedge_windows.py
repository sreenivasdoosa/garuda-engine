"""Hedge windows: when a positional short's hedge is moved.

The reference's `HedgeWindowScheduler` (`STRATEGY_ENGINE.md` §4). A
positional option-selling strategy with `hedge_replace_enabled` widens its
hedges for the day and tightens them for the night:

* **MORNING** -- from `hedge_morning_start_offset` to
  `hedge_morning_end_offset` minutes after the open, hedges move out to the
  intraday distance (4% by default);
* **EVENING** -- from `hedge_evening_start_offset` to
  `hedge_evening_end_offset` minutes before the close, hedges move in to the
  positional distance (1% by default). Not on an expiry day.

In a window, each live short whose hedge is not already at the window's
distance gets a replacement hedge; when the replacement is on, the old hedge
is squared off. One attempt per hedge per day, as the reference allows.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from garuda.engine.runtime_config import Definition

#: The reference's recovery cadence inside a window.
RECOVERY_INTERVAL = dt.timedelta(minutes=2)


class WindowKind(StrEnum):
    MORNING = "MORNING"
    EVENING = "EVENING"


@dataclass(frozen=True, slots=True)
class HedgeWindow:
    kind: WindowKind
    start: dt.datetime
    end: dt.datetime
    distance: Decimal

    def contains(self, moment: dt.datetime) -> bool:
        return self.start <= moment <= self.end


def windows_for(
    definition: Definition, *, opens: dt.datetime, closes: dt.datetime, expiry_day: bool
) -> list[HedgeWindow]:
    """The day's windows for one strategy; none unless it replaces hedges."""
    if not definition.hedge_replace_enabled:
        return []
    minutes = dt.timedelta(minutes=1)
    out = [
        HedgeWindow(
            WindowKind.MORNING,
            opens + minutes * definition.hedge_morning_start_offset,
            opens + minutes * definition.hedge_morning_end_offset,
            definition.hedge_distance_intraday,
        )
    ]
    if not expiry_day:
        out.append(
            HedgeWindow(
                WindowKind.EVENING,
                closes - minutes * definition.hedge_evening_start_offset,
                closes - minutes * definition.hedge_evening_end_offset,
                definition.hedge_distance_positional,
            )
        )
    return [window for window in out if window.start < window.end]
