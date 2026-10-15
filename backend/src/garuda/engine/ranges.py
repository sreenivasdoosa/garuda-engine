"""A frozen price band: the reference's `RangeSpec` and `PriceRangeResolver`.

Used by the ORB direction provider and by underlying breakout watches. Two
kinds:

* ``INTRADAY_WINDOW`` -- the high and low of today's one-minute bars opening
  in ``[rangeStart, rangeEnd)``; not ready until the window has closed;
* ``PREVIOUS_DAYS`` -- the high and low of the last ``lookbackPeriods``
  completed sessions.

``PREVIOUS_WEEKS`` is refused, as the reference refuses it.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from garuda.domain.errors import DomainError
from garuda.domain.market import Bar
from garuda.engine.vocabulary import BreakoutRangeType


@dataclass(frozen=True, slots=True)
class RangeSpec:
    kind: BreakoutRangeType
    start: dt.time | None = None
    end: dt.time | None = None
    lookback: int = 1

    @classmethod
    def from_params(cls, params: Mapping[str, Any]) -> RangeSpec:
        """From provider params (``rangeType``, ``rangeStart``, ``rangeEnd``,
        ``lookbackPeriods``)."""
        raw = str(params.get("rangeType") or "INTRADAY_WINDOW").strip().upper()
        if raw == "PREVIOUS_WEEKS":
            raise DomainError("PREVIOUS_WEEKS is not implemented, as in the reference")
        kind = BreakoutRangeType.parse(raw, field="rangeType")
        if kind is BreakoutRangeType.INTRADAY_WINDOW:
            return cls.window(params.get("rangeStart"), params.get("rangeEnd"))
        return cls.days(params.get("lookbackPeriods"))

    @classmethod
    def window(cls, start: object, end: object) -> RangeSpec:
        if not start or not end:
            raise DomainError("INTRADAY_WINDOW needs both rangeStart and rangeEnd (HH:MM)")
        try:
            opens, closes = dt.time.fromisoformat(str(start)), dt.time.fromisoformat(str(end))
        except ValueError:
            raise DomainError(
                f"rangeStart/rangeEnd must be HH:MM, got {start!r}, {end!r}"
            ) from None
        if opens >= closes:
            raise DomainError(f"rangeStart {opens} must be before rangeEnd {closes}")
        return cls(BreakoutRangeType.INTRADAY_WINDOW, opens, closes)

    @classmethod
    def days(cls, lookback: object) -> RangeSpec:
        count = int(str(lookback)) if lookback not in (None, "") else 1
        if count < 1:
            raise DomainError("PREVIOUS_DAYS needs lookbackPeriods of at least 1")
        return cls(BreakoutRangeType.PREVIOUS_DAYS, lookback=count)


@dataclass(frozen=True, slots=True)
class Band:
    high: Decimal
    low: Decimal
    bars: int


def resolve(
    spec: RangeSpec,
    *,
    now: dt.datetime,
    timezone: dt.tzinfo,
    today: dt.date,
    minute_bars: Sequence[Bar],
    day_bars: Sequence[Bar],
) -> Band | str:
    """The band, or why there is none yet."""
    if spec.kind is BreakoutRangeType.INTRADAY_WINDOW:
        if spec.start is None or spec.end is None:  # pragma: no cover - by construction
            raise DomainError("an intraday window without its times")
        local = now.astimezone(timezone)
        if local.time() < spec.end or local.date() != today:
            return f"the range {spec.start:%H:%M}-{spec.end:%H:%M} has not closed"
        inside = [
            bar
            for bar in minute_bars
            if bar.start.astimezone(timezone).date() == today
            and spec.start <= bar.start.astimezone(timezone).time() < spec.end
        ]
        if not inside:
            return f"no one-minute bars in {spec.start:%H:%M}-{spec.end:%H:%M}"
        return Band(
            high=max(bar.high.amount for bar in inside),
            low=min(bar.low.amount for bar in inside),
            bars=len(inside),
        )
    completed = [bar for bar in day_bars if bar.start.astimezone(timezone).date() < today]
    if len(completed) < spec.lookback:
        return f"only {len(completed)} completed session(s), need {spec.lookback}"
    window = completed[-spec.lookback :]
    return Band(
        high=max(bar.high.amount for bar in window),
        low=min(bar.low.amount for bar in window),
        bars=len(window),
    )
