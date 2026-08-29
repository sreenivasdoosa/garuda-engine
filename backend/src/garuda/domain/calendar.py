"""Trading calendars, sessions, and the trading day.

**A trading day is not a calendar date.** MCX evening sessions run past 23:00
IST; a CME session opens the prior calendar evening in Chicago and belongs to
the next day's business. Daily P&L rollover, end-of-day reconciliation,
"today's orders" and the ``trade_date`` partition key must all key off
:meth:`TradingCalendar.trading_day_for`, never ``date.today()``.

All instants are timezone-aware. Local time exists here for calendar
arithmetic and for display, nowhere else.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Final
from zoneinfo import ZoneInfo

from garuda.domain.errors import DomainError, NaiveDatetimeError

#: How far forward :meth:`TradingCalendar.trading_day_for` will look for the
#: next session before giving up. Longer than any plausible exchange closure;
#: a calendar with no trading day in this window is misconfigured.
MAX_LOOKAHEAD_DAYS: Final = 30

_ONE_DAY: Final = timedelta(days=1)


def require_aware(instant: datetime) -> datetime:
    """Reject a naive datetime at the boundary rather than guessing its zone."""
    if instant.tzinfo is None or instant.tzinfo.utcoffset(instant) is None:
        raise NaiveDatetimeError(
            f"{instant!r} has no timezone; every instant in the engine is aware"
        )
    return instant


@dataclass(frozen=True, slots=True)
class Session:
    """One continuous trading window, expressed in the exchange's local time.

    ``opens_previous_day`` marks a session that begins on the calendar evening
    *before* the trading day it belongs to -- the CME shape, where Monday's
    business opens 17:00 Sunday in Chicago. Without it, a venue model that
    works for NSE quietly mis-assigns every overnight fill.
    """

    opens: time
    closes: time
    opens_previous_day: bool = False

    def __post_init__(self) -> None:
        if self.opens.tzinfo is not None or self.closes.tzinfo is not None:
            raise DomainError("session times are local to the exchange and carry no tzinfo")
        if not self.opens_previous_day and self.closes <= self.opens:
            raise DomainError(
                f"session {self.opens}-{self.closes} ends before it starts; "
                "set opens_previous_day=True for a session that spans midnight"
            )

    def window_for(self, trading_day: date, tz: ZoneInfo) -> SessionWindow:
        """Resolve this session to concrete instants for one trading day."""
        start_date = trading_day - _ONE_DAY if self.opens_previous_day else trading_day
        return SessionWindow(
            start=datetime.combine(start_date, self.opens, tzinfo=tz),
            end=datetime.combine(trading_day, self.closes, tzinfo=tz),
            trading_day=trading_day,
        )


@dataclass(frozen=True, slots=True)
class SessionWindow:
    """A session resolved to absolute instants."""

    start: datetime
    end: datetime
    trading_day: date

    def contains(self, instant: datetime) -> bool:
        """Half-open: the closing instant belongs to no session."""
        return self.start <= require_aware(instant) < self.end


@dataclass(frozen=True)
class TradingCalendar:
    """Sessions, holidays and special days for one venue.

    ``weekly`` maps ``date.weekday()`` (0 = Monday) to that day's sessions. A
    weekday absent from the mapping is not a trading day.

    ``special_sessions`` overrides the weekly schedule for one date -- a
    half-day, or a session held on what is otherwise a holiday. It wins over
    both ``weekly`` and ``holidays``, which is what makes a Diwali muhurat
    session expressible.
    """

    name: str
    timezone: ZoneInfo
    weekly: Mapping[int, tuple[Session, ...]]
    holidays: frozenset[date] = field(default_factory=frozenset)
    special_sessions: Mapping[date, tuple[Session, ...]] = field(default_factory=dict)
    #: The pre-open window, where the venue has one. Orders behave differently
    #: in it -- NSE runs an auction between 09:00 and 09:08 -- so it is a
    #: distinct window rather than an early part of the session. Venues without
    #: one leave it None.
    pre_open: Session | None = None

    # -- schedule -----------------------------------------------------------

    def sessions_on(self, day: date) -> tuple[Session, ...]:
        """The sessions belonging to ``day`` as a trading day. Empty if closed."""
        special = self.special_sessions.get(day)
        if special is not None:
            return special
        if day in self.holidays:
            return ()
        return tuple(self.weekly.get(day.weekday(), ()))

    def is_trading_day(self, day: date) -> bool:
        return bool(self.sessions_on(day))

    def windows_on(self, day: date) -> tuple[SessionWindow, ...]:
        """``day``'s sessions resolved to instants, in chronological order."""
        windows = [s.window_for(day, self.timezone) for s in self.sessions_on(day)]
        return tuple(sorted(windows, key=lambda w: w.start))

    def pre_open_window_on(self, day: date) -> SessionWindow | None:
        """The pre-open auction on a trading day, if the venue runs one."""
        if self.pre_open is None or not self.is_trading_day(day):
            return None
        return self.pre_open.window_for(day, self.timezone)

    def is_open(self, instant: datetime) -> bool:
        require_aware(instant)
        return any(
            window.contains(instant)
            for day in self._candidate_days(instant)
            for window in self.windows_on(day)
        )

    # -- the trading day ----------------------------------------------------

    def trading_day_for(self, instant: datetime) -> date:
        """The trading day an instant belongs to.

        Inside a session, that session's trading day. Outside one, the next
        trading day to open -- so an instant after Monday's close reports
        Tuesday, and the function stays total, which a partition key requires.

        Use :meth:`last_completed_trading_day` when you mean the day that has
        just finished rather than the one about to begin.
        """
        require_aware(instant)
        for day in self._candidate_days(instant):
            for window in self.windows_on(day):
                if window.contains(instant):
                    return window.trading_day

        local_date = instant.astimezone(self.timezone).date()
        for offset in range(MAX_LOOKAHEAD_DAYS + 1):
            day = local_date + timedelta(days=offset)
            for window in self.windows_on(day):
                if window.start > instant:
                    return window.trading_day
        raise DomainError(
            f"{self.name} has no trading session within {MAX_LOOKAHEAD_DAYS} days "
            f"of {instant.isoformat()}; the calendar is misconfigured"
        )

    def last_completed_trading_day(self, instant: datetime) -> date:
        """The most recent trading day whose final session has closed."""
        require_aware(instant)
        local_date = instant.astimezone(self.timezone).date()
        for offset in range(MAX_LOOKAHEAD_DAYS + 1):
            day = local_date + _ONE_DAY - timedelta(days=offset)
            windows = self.windows_on(day)
            if windows and windows[-1].end <= instant:
                return day
        raise DomainError(
            f"{self.name} has no completed trading day within {MAX_LOOKAHEAD_DAYS} days "
            f"before {instant.isoformat()}; the calendar is misconfigured"
        )

    def _candidate_days(self, instant: datetime) -> tuple[date, date]:
        """Trading days whose windows could contain ``instant``.

        A session may start the previous calendar evening, so the local date
        and the day after it are the only candidates.
        """
        local_date = instant.astimezone(self.timezone).date()
        return (local_date, local_date + _ONE_DAY)

    # -- navigation ---------------------------------------------------------

    def next_trading_day(self, day: date) -> date:
        return self._step(day, +1)

    def previous_trading_day(self, day: date) -> date:
        return self._step(day, -1)

    def _step(self, day: date, direction: int) -> date:
        for offset in range(1, MAX_LOOKAHEAD_DAYS + 1):
            candidate = day + timedelta(days=offset * direction)
            if self.is_trading_day(candidate):
                return candidate
        raise DomainError(
            f"{self.name} has no trading day within {MAX_LOOKAHEAD_DAYS} days "
            f"{'after' if direction > 0 else 'before'} {day}"
        )

    def trading_days_between(self, start: date, end: date) -> Sequence[date]:
        """Trading days in ``[start, end]``, inclusive of both ends."""
        if end < start:
            raise DomainError(f"{end} precedes {start}")
        days: list[date] = []
        day = start
        while day <= end:
            if self.is_trading_day(day):
                days.append(day)
            day += _ONE_DAY
        return days
