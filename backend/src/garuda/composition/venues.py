"""Building venues out of their configuration rows.

An exchange is data: its sessions, its holidays, and how far each phase of the
day sits from its own open and close. Everything here reads those rows and
returns the value objects the runner and the square-off services work in, so
that adding a venue is an insert and not a code change.

Everything a venue is comes from its row. Nothing here is filled in from a
table of known codes: a venue that does not say what it trades or what it
settles in is refused by name, because a default would tell a strategy that a
commodity exchange lists equities.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.calendar import Session, TradingCalendar
from garuda.domain.enums import Segment, SettlementCycle
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.money import Currency
from garuda.domain.phases import DayOffsets
from garuda.persistence.models import (
    ExchangeSegmentTimingsRow,
    ExchangesRow,
    HolidaysRow,
    SpecialTradingDaysRow,
)
from garuda.persistence.uow import UnitOfWork
from garuda.trademgmt.squareoff_rules import ExitWindow

logger = logging.getLogger(__name__)

#: Saturday and Sunday, as ``date.weekday()`` numbers.
DEFAULT_WEEKEND = frozenset({5, 6})

#: Used where a venue's row does not say. Indian equities settle T+1.
DEFAULT_SETTLEMENT = SettlementCycle.T1


@dataclass(frozen=True)
class Venues:
    """Every configured venue, and the offsets that shape its day."""

    exchanges: Mapping[str, Exchange]
    offsets: Mapping[str, DayOffsets]
    #: How long before the close intraday products stop being squared off,
    #: per venue. None where the venue does not say, in which case an intraday
    #: position stays squareable until the close like any other.
    intraday_blocks: Mapping[str, timedelta | None]

    @property
    def all(self) -> Sequence[Exchange]:
        """In a stable order, so a log line reads the same on every restart."""
        return [self.exchanges[code] for code in sorted(self.exchanges)]

    def exit_window(
        self, exchange: Exchange, trading_day: date, segment: Segment | None = None
    ) -> ExitWindow | None:
        """When square-offs may still be attempted on a venue's trading day.

        By the segment's own close when it has one: a cash position is
        measured against the cash close, not the derivatives'. None on a day
        the venue does not trade -- there is no close to measure from, and
        inventing one would make every retry window look open.
        """
        windows = exchange.calendar.windows_on(
            trading_day, segment.value if segment is not None else None
        )
        if not windows:
            return None
        close = windows[-1].end
        block = self.intraday_blocks.get(exchange.code)
        return ExitWindow(
            market_close=close,
            intraday_block=close - block if block is not None else None,
        )

    def intraday_cutoff(
        self, exchange: Exchange, trading_day: date, segment: Segment | None = None
    ) -> datetime | None:
        """When the engine squares off intraday positions of its own accord.

        Earlier than the broker's own forced closure, which is what
        ``intraday_block`` marks: being closed out by the broker is a worse
        price and a worse audit trail than closing out deliberately.
        """
        window = self.exit_window(exchange, trading_day, segment)
        if window is None:
            return None
        lead = self.offsets.get(exchange.code, DayOffsets()).intraday_square_off_lead
        return window.market_close - lead


async def load_venues(sessions: async_sessionmaker[AsyncSession]) -> Venues:
    """Read every active exchange, its holidays and its special trading days."""
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.exchanges.all()
        holiday_rows = await uow.repositories.holidays.all()
        special_rows = await uow.repositories.special_trading_days.all()
        segment_rows = await uow.repositories.exchange_segment_timings.all()
    return venues_from(rows, holiday_rows, special_rows, segment_rows)


def venues_from(
    rows: Sequence[ExchangesRow],
    holiday_rows: Sequence[HolidaysRow],
    special_rows: Sequence[SpecialTradingDaysRow] = (),
    segment_rows: Sequence[ExchangeSegmentTimingsRow] = (),
) -> Venues:
    """Turn configuration rows into venues. The whole mapping, and nothing else."""
    timings: dict[str, list[ExchangeSegmentTimingsRow]] = {}
    for timing in segment_rows:
        timings.setdefault(timing.exchange_code, []).append(timing)

    holidays: dict[str, set[date]] = {}
    for holiday in holiday_rows:
        parsed = _parse_day(holiday.date)
        if parsed is None:
            logger.warning(
                "holiday %r on %s is not a date; ignored", holiday.date, holiday.exchange
            )
            continue
        holidays.setdefault(holiday.exchange, set()).add(parsed)

    specials: dict[str, dict[date, SpecialTradingDaysRow]] = {}
    for special in special_rows:
        parsed = _parse_day(special.trading_date)
        if parsed is None:
            logger.warning(
                "special trading day %r on %s is not a date; ignored",
                special.trading_date,
                special.exchange,
            )
            continue
        specials.setdefault(special.exchange, {})[parsed] = special

    exchanges: dict[str, Exchange] = {}
    offsets: dict[str, DayOffsets] = {}
    blocks: dict[str, timedelta | None] = {}
    for row in rows:
        if row.is_active is False:
            continue
        code = row.exchange_code
        try:
            exchanges[code] = _exchange_from(
                row,
                frozenset(holidays.get(code, ())),
                specials.get(code, {}),
                timings.get(code, ()),
            )
        except DomainError as error:
            # One misconfigured venue is not a reason for the others to stop
            # trading. It is reported by name and left out.
            logger.error("%s is not usable and will not be traded: %s", code, error)
            continue
        offsets[code] = _offsets_from(row)
        blocks[code] = (
            timedelta(minutes=row.intraday_squareoff_block_minutes_before_close)
            if row.intraday_squareoff_block_minutes_before_close is not None
            else None
        )

    if not exchanges:
        logger.warning("no active exchanges are configured; the engine has no day to run")
    return Venues(exchanges=exchanges, offsets=offsets, intraday_blocks=blocks)


def _exchange_from(
    row: ExchangesRow,
    holidays: frozenset[date],
    specials: Mapping[date, SpecialTradingDaysRow] | None = None,
    timings: Sequence[ExchangeSegmentTimingsRow] = (),
) -> Exchange:
    code = row.exchange_code
    tz = ZoneInfo(row.timezone or "Asia/Kolkata")
    session = Session(opens=row.market_open, closes=row.market_close)
    weekend = _parse_weekend(row.weekend_days)
    segments = _segments(row)
    calendar = TradingCalendar(
        name=row.exchange_name or code,
        timezone=tz,
        weekly={day: (session,) for day in range(7) if day not in weekend},
        holidays=holidays,
        special_sessions=_special_sessions(specials or {}, session),
        pre_open=_pre_open(row),
        segment_sessions=_segment_sessions(code, timings, segments, session),
    )
    return Exchange(
        code=code,
        name=row.exchange_name or code,
        currency=_currency(row),
        calendar=calendar,
        settlement=DEFAULT_SETTLEMENT,
        segments=segments,
    )


def _segment_sessions(
    code: str,
    timings: Sequence[ExchangeSegmentTimingsRow],
    segments: frozenset[Segment],
    usual: Session,
) -> dict[str, tuple[Session, ...]]:
    """Each segment's own hours, where a row gives them.

    Either side left null takes the venue's -- the owner's rule: a segment
    says only what differs. A row for a segment the venue does not list, or
    hours that do not make a session, is reported and left out rather than
    allowed to shape a day nothing trades.
    """
    own: dict[str, tuple[Session, ...]] = {}
    for timing in timings:
        name = (timing.segment or "").strip().upper()
        if name not in {segment.value for segment in segments}:
            logger.warning("%s has hours for segment %r, which it does not list", code, name)
            continue
        opens = timing.market_open if timing.market_open is not None else usual.opens
        closes = timing.market_close if timing.market_close is not None else usual.closes
        try:
            own[name] = (Session(opens=opens, closes=closes),)
        except DomainError as error:
            logger.error("%s %s hours are unusable and are ignored: %s", code, name, error)
    return own


def _currency(row: ExchangesRow) -> Currency:
    """What the venue settles in, as the engine's own enum.

    A code the engine does not know is refused loudly rather than defaulted:
    a P&L figure carrying the wrong currency is worse than a venue that will
    not load, because nothing about it looks wrong.
    """
    try:
        return Currency(row.currency.strip().upper())
    except (ValueError, AttributeError):
        raise DomainError(
            f"{row.exchange_code} settles in {row.currency!r}, which is not a currency "
            "the engine knows"
        ) from None


def _segments(row: ExchangesRow) -> frozenset[Segment]:
    """Which segments the venue lists, from its own row.

    Refused rather than defaulted. "All of them" would have a strategy believe
    a commodity exchange lists equities, and an empty set cannot build an
    exchange at all -- so a venue that does not say is a venue that does not
    load.
    """
    named = [part.strip().upper() for part in (row.segments or "").split(",") if part.strip()]
    if not named:
        raise DomainError(
            f"{row.exchange_code} does not say which segments it trades; "
            f"expected some of {', '.join(sorted(s.value for s in Segment))}"
        )
    try:
        return frozenset(Segment(name) for name in named)
    except ValueError as error:
        raise DomainError(f"{row.exchange_code} lists a segment that is not one: {error}") from None


def _special_sessions(
    specials: Mapping[date, SpecialTradingDaysRow], usual: Session
) -> dict[date, tuple[Session, ...]]:
    """The days this venue opens against its own weekly schedule.

    A row with no hours of its own trades the venue's usual session -- Budget
    day falling on a Saturday is that case, and it is the common one. A row
    with hours replaces them, which is how a Diwali muhurat evening is
    expressed. Half a pair is not enough to build a session from, so it falls
    back to the usual hours and says so rather than inventing the missing end.
    """
    sessions: dict[date, tuple[Session, ...]] = {}
    for day, row in specials.items():
        if row.market_open is not None and row.market_close is not None:
            sessions[day] = (Session(opens=row.market_open, closes=row.market_close),)
            continue
        if row.market_open is not None or row.market_close is not None:
            logger.warning(
                "%s on %s gives only one side of its hours; using the usual session",
                row.exchange,
                row.trading_date,
            )
        sessions[day] = (usual,)
    return sessions


def _pre_open(row: ExchangesRow) -> Session | None:
    """The auction window, where the venue runs one.

    Both ends or neither: a half-configured window would make a strategy
    believe orders behave differently for a period nobody defined.
    """
    start: time | None = row.pre_market_start
    end: time | None = row.pre_market_end
    if start is None or end is None or end <= start:
        return None
    return Session(opens=start, closes=end)


def _offsets_from(row: ExchangesRow) -> DayOffsets:
    default = DayOffsets()
    return DayOffsets(
        day_init_lead=_minutes(
            row.day_init_minutes_before_market_open,
            default.day_init_lead,
        ),
        algo_start_lead=_minutes(
            row.algo_start_minutes_before_market_open,
            default.algo_start_lead,
        ),
        intraday_square_off_lead=_minutes(
            row.intraday_squareoff_minutes_before_close,
            default.intraday_square_off_lead,
        ),
        report_lag=_minutes(
            row.report_minutes_after_close,
            default.report_lag,
        ),
        post_market_window=_minutes(
            row.post_market_window_minutes,
            default.post_market_window,
        ),
    )


def _minutes(value: int | None, fallback: timedelta) -> timedelta:
    return timedelta(minutes=value) if value is not None else fallback


def _parse_weekend(value: str | None) -> frozenset[int]:
    """Weekend days, however the row spells them.

    Accepts day numbers and day names, comma-separated. Anything unreadable
    falls back to Saturday and Sunday rather than to no weekend at all --
    a venue with no weekend would have the engine expecting Sunday ticks.
    """
    if not value:
        return frozenset(DEFAULT_WEEKEND)
    names = {
        "MON": 0,
        "TUE": 1,
        "WED": 2,
        "THU": 3,
        "FRI": 4,
        "SAT": 5,
        "SUN": 6,
    }
    days: set[int] = set()
    for part in value.replace(";", ",").split(","):
        token = part.strip().upper()
        if not token:
            continue
        if token.isdigit() and 0 <= int(token) <= 6:
            days.add(int(token))
        elif token[:3] in names:
            days.add(names[token[:3]])
        else:
            logger.warning("weekend day %r is not a day; falling back to Sat/Sun", part)
            return frozenset(DEFAULT_WEEKEND)
    return frozenset(days) if days else frozenset(DEFAULT_WEEKEND)


def _parse_day(value: str) -> date | None:
    try:
        return date.fromisoformat(value.strip())
    except (ValueError, AttributeError):
        return None
