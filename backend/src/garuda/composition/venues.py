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
from garuda.persistence.models import ExchangesRow, HolidaysRow
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

    def exit_window(self, exchange: Exchange, trading_day: date) -> ExitWindow | None:
        """When square-offs may still be attempted on a venue's trading day.

        None on a day the venue does not trade -- there is no close to measure
        from, and inventing one would make every retry window look open.
        """
        windows = exchange.calendar.windows_on(trading_day)
        if not windows:
            return None
        close = windows[-1].end
        block = self.intraday_blocks.get(exchange.code)
        return ExitWindow(
            market_close=close,
            intraday_block=close - block if block is not None else None,
        )

    def intraday_cutoff(self, exchange: Exchange, trading_day: date) -> datetime | None:
        """When the engine squares off intraday positions of its own accord.

        Earlier than the broker's own forced closure, which is what
        ``intraday_block`` marks: being closed out by the broker is a worse
        price and a worse audit trail than closing out deliberately.
        """
        window = self.exit_window(exchange, trading_day)
        if window is None:
            return None
        lead = self.offsets.get(exchange.code, DayOffsets()).intraday_square_off_lead
        return window.market_close - lead


async def load_venues(sessions: async_sessionmaker[AsyncSession]) -> Venues:
    """Read every active exchange and its holidays."""
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.exchanges.all()
        holiday_rows = await uow.repositories.holidays.all()
    return venues_from(rows, holiday_rows)


def venues_from(rows: Sequence[ExchangesRow], holiday_rows: Sequence[HolidaysRow]) -> Venues:
    """Turn configuration rows into venues. The whole mapping, and nothing else."""
    holidays: dict[str, set[date]] = {}
    for holiday in holiday_rows:
        parsed = _parse_day(holiday.date)
        if parsed is None:
            logger.warning(
                "holiday %r on %s is not a date; ignored", holiday.date, holiday.exchange
            )
            continue
        holidays.setdefault(holiday.exchange, set()).add(parsed)

    exchanges: dict[str, Exchange] = {}
    offsets: dict[str, DayOffsets] = {}
    blocks: dict[str, timedelta | None] = {}
    for row in rows:
        if row.is_active is False:
            continue
        code = row.exchange_code
        try:
            exchanges[code] = _exchange_from(row, frozenset(holidays.get(code, ())))
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


def _exchange_from(row: ExchangesRow, holidays: frozenset[date]) -> Exchange:
    code = row.exchange_code
    tz = ZoneInfo(row.timezone or "Asia/Kolkata")
    session = Session(opens=row.market_open, closes=row.market_close)
    weekend = _parse_weekend(row.weekend_days)
    calendar = TradingCalendar(
        name=row.exchange_name or code,
        timezone=tz,
        weekly={day: (session,) for day in range(7) if day not in weekend},
        holidays=holidays,
        pre_open=_pre_open(row),
    )
    return Exchange(
        code=code,
        name=row.exchange_name or code,
        currency=_currency(row),
        calendar=calendar,
        settlement=DEFAULT_SETTLEMENT,
        segments=_segments(row),
    )


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
