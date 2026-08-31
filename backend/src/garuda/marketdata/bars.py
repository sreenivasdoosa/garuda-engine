"""Keeping a series of bars honest.

Two things go wrong with candle history, and both are quiet.

**The last bar is usually still forming.** A provider hands back the current
period alongside the closed ones, and a rule that reads it as history sees a
value that will change before the period ends. An indicator computed over it
moves as the bar fills, so a threshold can be crossed and uncrossed inside one
minute — the repainting problem. Every reader wants closed bars; this is where
the forming one is dropped.

**A series can silently stop.** A feed that stalls leaves yesterday's bars in
place, and every indicator computed from them keeps returning a plausible
number. A stale series has to be detectable, because "plausible but old" is
the worst shape a price can have.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

from garuda.domain.market import Bar, BarInterval


def closed_bars(bars: Sequence[Bar], now: datetime) -> Sequence[Bar]:
    """Everything that has finished. Drops a trailing bar still forming.

    Only the last bar is considered, because a series is ordered and only its
    end can be incomplete. A bar whose period has elapsed is closed even if
    nothing has traded since, which is the right answer for an illiquid strike.
    """
    if not bars:
        return bars
    return bars[:-1] if bars[-1].end > now else bars


def is_stale(
    bars: Sequence[Bar],
    now: datetime,
    *,
    interval: BarInterval,
    session_start: datetime,
) -> bool:
    """Whether the series has stopped keeping up.

    Stale once a whole interval has passed since the last bar should have
    closed: one late bar is a slow provider, two is a series that has stopped.

    An empty series is stale only after the first bar of the session was due.
    Before that there is simply nothing yet, which at the open is the normal
    state and not a fault.

    The interval is passed rather than read off the last bar, because the case
    that matters most — an empty series — has no last bar to read it from.
    """
    if not bars:
        return now >= session_start + interval.duration * 2

    return now >= bars[-1].end + interval.duration


def bars_per_session(interval: BarInterval, *, opens: datetime, closes: datetime) -> int:
    """How many bars a full session produces.

    Used to size a history request: asking for "the last twenty bars" near the
    open should not silently reach into yesterday, and asking for a day of
    them needs to know how long a day is here. A venue that trades into the
    night has far more than one that does not, which is why this takes the
    session rather than assuming a number.
    """
    # Floor division on a negative span answers -1, which is worse than
    # useless as a count.
    return max(0, (closes - opens) // interval.duration)
