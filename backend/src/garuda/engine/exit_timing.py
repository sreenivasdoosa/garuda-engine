"""When a position should come off, whatever the price is doing.

The reference's `computeExitTradeAt` and `computeExitDate`, ported. The
configured `exit_mode` names a day and `exit_time` a time on it:

* ``SAME_DAY`` -- today;
* ``EXPIRY`` -- the contract's expiry;
* ``DAYS_FROM_ENTRY`` -- ``exit_days`` trading days on, never past expiry, and
  today when today is the expiry;
* ``DTE`` -- ``exit_days`` trading days before expiry, and today if that has
  already gone;
* ``MINUTES_FROM_ENTRY`` -- ``exit_days`` *minutes* after now (the reference
  reuses the column), never past five minutes before the expiry's close.

An intraday strategy always exits today, whatever the mode. The time defaults
to twenty minutes before the close; ``ENTRY_TIME`` means the time of entry.
A moment already past falls back to that default today, and if that has
passed too, to the close on an expiry day or the default on the next
trading day -- the reference's order, which never returns a moment behind
the clock.

No exit mode means no scheduled exit: the position is managed by its stop,
its target and the venue's square-off.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from garuda.domain.calendar import TradingCalendar
from garuda.domain.errors import DomainError
from garuda.engine.vocabulary import ExitMode

#: The reference's `DEFAULT_EXIT_MINUTES_BEFORE_CLOSE`.
DEFAULT_MINUTES_BEFORE_CLOSE = 20
#: How close to an expiry's close a minutes-based exit may run.
EXPIRY_CLOSE_MARGIN = dt.timedelta(minutes=5)
ENTRY_TIME = "ENTRY_TIME"


@dataclass(frozen=True, slots=True)
class ExitTiming:
    """What the calculation reads."""

    now: dt.datetime
    today: dt.date
    timezone: dt.tzinfo
    calendar: TradingCalendar
    market_close: dt.time
    intraday: bool
    expiry: dt.date | None
    exit_mode: str | None
    exit_time: str | None
    exit_days: int | None


def exit_at(timing: ExitTiming) -> dt.datetime | None:
    """The moment to exit, or None when nothing is configured."""
    if not (timing.exit_mode or "").strip():
        return None
    mode = ExitMode.parse(timing.exit_mode, field="exitMode")
    zone = timing.timezone
    close = timing.market_close

    if mode is ExitMode.MINUTES_FROM_ENTRY:
        minutes = timing.exit_days
        if minutes is None or minutes <= 0:
            return None
        moment = timing.now + dt.timedelta(minutes=minutes)
        if timing.expiry is not None:
            limit = dt.datetime.combine(timing.expiry, close, zone) - EXPIRY_CLOSE_MARGIN
            moment = min(moment, limit)
        return moment

    at = _time_of(timing)
    day = timing.today if timing.intraday else _exit_date(mode, timing)
    moment = dt.datetime.combine(day, at, zone)
    if moment > timing.now:
        return moment

    fallback = dt.datetime.combine(timing.today, _default_time(close), zone)
    if fallback > timing.now:
        return fallback
    if timing.expiry == timing.today:
        return dt.datetime.combine(timing.today, close, zone)
    following = timing.calendar.next_trading_day(timing.today)
    return dt.datetime.combine(following, _default_time(close), zone)


def _exit_date(mode: ExitMode, timing: ExitTiming) -> dt.date:
    today, expiry, days = timing.today, timing.expiry, timing.exit_days
    if mode is ExitMode.SAME_DAY:
        return today
    if mode is ExitMode.EXPIRY:
        return expiry or today
    if mode is ExitMode.DAYS_FROM_ENTRY:
        if expiry == today or days is None or days <= 0:
            return today
        day = today
        for _ in range(days):
            day = timing.calendar.next_trading_day(day)
        return min(day, expiry) if expiry is not None else day
    if mode is ExitMode.DTE:
        if expiry is None or days is None or days <= 0:
            return today
        day = expiry
        for _ in range(days):
            day = timing.calendar.previous_trading_day(day)
        return today if day <= today else day
    raise DomainError(f"exit mode {mode} has no exit date")  # pragma: no cover


def _time_of(timing: ExitTiming) -> dt.time:
    text = (timing.exit_time or "").strip()
    if not text:
        return _default_time(timing.market_close)
    if text.upper() == ENTRY_TIME:
        return timing.now.astimezone(timing.timezone).time().replace(microsecond=0)
    try:
        return dt.time.fromisoformat(text)
    except ValueError:
        raise DomainError(f"exit time {text!r} is not a time of day (HH:MM)") from None


def _default_time(close: dt.time) -> dt.time:
    anchor = dt.datetime.combine(dt.date(2000, 1, 3), close)
    return (anchor - dt.timedelta(minutes=DEFAULT_MINUTES_BEFORE_CLOSE)).time()
