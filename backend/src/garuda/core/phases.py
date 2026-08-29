"""The trading day, phase by phase, per venue.

The engine runs continuously; each venue's day begins and ends underneath it.
Every phase is derived from that venue's calendar and its own offsets, in its
own timezone, on its own trading day — so adding a venue in another country
means adding a row, not an ``if``.

There is deliberately no global "the market is open" and no global day
boundary. Two venues are routinely in different phases at the same moment:
MCX still trades while NSE is in EOD.

There is deliberately no login phase either. The reference engine schedules one
because it logs in automatically; Garuda's operator clicks Login whenever they
choose, so a phase named for it would imply a gate that does not exist — and
sooner or later someone would implement the gate.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import StrEnum

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange


class DayPhase(StrEnum):
    """The points in a venue's day that work hangs off.

    Ordered as they occur. The order matters: a phase list is walked in it, and
    a phase missed while the process was down is caught up in it.
    """

    #: Caches, instrument master, corporate actions — everything the day needs
    #: before anyone logs in.
    DAY_INIT = "DAY_INIT"
    #: Strategy evaluation starts; scheduled entries can now fire.
    ALGO_START = "ALGO_START"
    #: Only where the venue runs an auction before the open. Orders behave
    #: differently in it, so it is a phase rather than an early session.
    PRE_OPEN = "PRE_OPEN"
    SESSION_OPEN = "SESSION_OPEN"
    #: Intraday positions must be flat by the close, so they are closed before
    #: the exchange does it at a price nobody chose. This is a venue phase
    #: because the venue enforces it. Exiting a carry-forward position is not:
    #: when that happens is a strategy's decision, expressed in its exit
    #: configuration, and no venue has an opinion about it.
    INTRADAY_SQUARE_OFF = "INTRADAY_SQUARE_OFF"
    SESSION_CLOSE = "SESSION_CLOSE"
    REPORTS = "REPORTS"
    #: Archive, prune, and put the day away.
    EOD = "EOD"


@dataclass(frozen=True, slots=True)
class DayOffsets:
    """How far each phase sits from the venue's session.

    Columns on the exchange in the database, so a new venue is configuration.
    Defaults match a normal Indian equity day; nothing about them is universal.
    """

    day_init_lead: timedelta = timedelta(minutes=180)
    algo_start_lead: timedelta = timedelta(minutes=90)
    intraday_square_off_lead: timedelta = timedelta(minutes=20)
    report_lag: timedelta = timedelta(minutes=15)
    post_market_window: timedelta = timedelta(minutes=60)

    def __post_init__(self) -> None:
        for name in (
            "day_init_lead",
            "algo_start_lead",
            "intraday_square_off_lead",
            "report_lag",
            "post_market_window",
        ):
            if getattr(self, name) < timedelta(0):
                raise DomainError(f"{name} cannot be negative")
        if self.day_init_lead < self.algo_start_lead:
            raise DomainError(
                "the day must be initialised before the engine starts trading it: "
                f"day_init_lead {self.day_init_lead} is inside algo_start_lead "
                f"{self.algo_start_lead}"
            )


def offsets_from_exchange_row(row: object) -> DayOffsets:
    """Read a venue's offsets out of its row.

    The point of the whole design: no phase time is written in code. A venue in
    another country is a row whose offsets differ, and nothing here knows which
    country it is in.

    A column left null falls back to the default, so a partially configured
    venue still has a coherent day rather than a missing phase.
    """
    defaults = DayOffsets()

    def minutes(name: str, fallback: timedelta) -> timedelta:
        value = getattr(row, name, None)
        return timedelta(minutes=int(value)) if value is not None else fallback

    return DayOffsets(
        day_init_lead=minutes("day_init_minutes_before_market_open", defaults.day_init_lead),
        algo_start_lead=minutes("algo_start_minutes_before_market_open", defaults.algo_start_lead),
        intraday_square_off_lead=minutes(
            "intraday_squareoff_minutes_before_close", defaults.intraday_square_off_lead
        ),
        report_lag=minutes("report_minutes_after_close", defaults.report_lag),
        post_market_window=minutes("post_market_window_minutes", defaults.post_market_window),
    )


@dataclass(frozen=True, slots=True)
class PhaseInstant:
    """One phase of one venue's day, resolved to an instant."""

    exchange: str
    trading_day: date
    phase: DayPhase
    at: datetime

    def __str__(self) -> str:
        return f"{self.exchange} {self.trading_day} {self.phase} at {self.at.isoformat()}"


def schedule_for(
    exchange: Exchange, trading_day: date, offsets: DayOffsets | None = None
) -> tuple[PhaseInstant, ...]:
    """Every phase of one venue's trading day, in order.

    Empty when the venue is closed that day — a holiday has no phases, not a
    day-init that quietly initialises nothing.
    """
    windows = exchange.calendar.windows_on(trading_day)
    if not windows:
        return ()

    offsets = offsets or DayOffsets()
    first_open = windows[0].start
    last_close = windows[-1].end

    instants: list[PhaseInstant] = [
        _at(exchange, trading_day, DayPhase.DAY_INIT, first_open - offsets.day_init_lead),
        _at(exchange, trading_day, DayPhase.ALGO_START, first_open - offsets.algo_start_lead),
    ]

    # Only venues that run an auction have one; the rest go straight to open.
    pre_open = exchange.calendar.pre_open_window_on(trading_day)
    if pre_open is not None:
        instants.append(_at(exchange, trading_day, DayPhase.PRE_OPEN, pre_open.start))

    for window in windows:
        instants.append(_at(exchange, trading_day, DayPhase.SESSION_OPEN, window.start))
    instants.append(
        _at(
            exchange,
            trading_day,
            DayPhase.INTRADAY_SQUARE_OFF,
            last_close - offsets.intraday_square_off_lead,
        )
    )
    for window in windows:
        instants.append(_at(exchange, trading_day, DayPhase.SESSION_CLOSE, window.end))

    instants.append(_at(exchange, trading_day, DayPhase.REPORTS, last_close + offsets.report_lag))
    instants.append(
        _at(exchange, trading_day, DayPhase.EOD, last_close + offsets.post_market_window)
    )
    return tuple(sorted(instants, key=lambda instant: (instant.at, _order(instant.phase))))


def due_phases(
    exchange: Exchange,
    trading_day: date,
    now: datetime,
    completed: frozenset[DayPhase],
    offsets: DayOffsets | None = None,
) -> tuple[PhaseInstant, ...]:
    """Phases whose moment has passed and which have not run.

    This is what makes the scheduler a reconciler rather than a timer. A
    process that was down at 06:15 runs DAY_INIT when it comes up at 07:00,
    because the record says today's has not run — not because a timer happened
    to fire while it was running.
    """
    require_aware(now)
    return tuple(
        instant
        for instant in schedule_for(exchange, trading_day, offsets)
        if instant.at <= now and instant.phase not in completed
    )


def next_phase_after(
    exchange: Exchange,
    now: datetime,
    offsets: DayOffsets | None = None,
    *,
    lookahead_days: int = 10,
) -> PhaseInstant | None:
    """The next phase due for this venue, today or on a later trading day.

    What the process sleeps until. None when the venue has nothing scheduled
    within the lookahead, which means its calendar is misconfigured.
    """
    require_aware(now)
    day = now.astimezone(exchange.timezone).date()
    for offset in range(lookahead_days + 1):
        for instant in schedule_for(exchange, day + timedelta(days=offset), offsets):
            if instant.at > now:
                return instant
    return None


_PHASE_ORDER = {phase: index for index, phase in enumerate(DayPhase)}


def _order(phase: DayPhase) -> int:
    return _PHASE_ORDER[phase]


def _at(exchange: Exchange, trading_day: date, phase: DayPhase, at: datetime) -> PhaseInstant:
    return PhaseInstant(exchange=exchange.code, trading_day=trading_day, phase=phase, at=at)
