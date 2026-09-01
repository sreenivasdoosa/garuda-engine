"""Venues: what the engine trades on, and when each one is open.

The first thing to configure and the first thing every other page depends on,
so it is the first page served. The wire shape is camelCase because that is
what the copied Console reads; the translation lives here rather than in the
model, which stays snake_case like the rest of the database.

Three fields the Console knows about are not served, because garuda does not
store them: `positionalSquareOffMinutesBeforeClose` (when a carry-forward
position exits is the strategy's business, not the venue's),
`loginMinutesBeforeMarketOpen` (login is operator-initiated and never on a
timer) and `billingMinutesAfterClose` (there is no billing). They are optional
in the Console's own type and read as absent.
"""

from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import available_timezones

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.enums import Segment
from garuda.domain.money import Currency
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository

#: Every zone this machine's tz database knows, which is exactly the set
#: `ZoneInfo` will accept when the venue loader builds the calendar. Sorted
#: once at import; the list does not change while the process runs.
TIMEZONES: tuple[str, ...] = tuple(sorted(available_timezones()))

#: Weekend is a set of day names in the row, so the Console needs the spelling
#: `_parse_weekend` in the venue loader accepts.
WEEKDAYS = (
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
)


#: Stored comma-separated in one column; a list on the wire, because that is
#: what it is. Blank entries are dropped so `"EQUITY,"` does not become a
#: segment named "".
def _split(value: str | None) -> list[str]:
    return [part.strip() for part in (value or "").split(",") if part.strip()]


def _join(values: list[str] | None) -> str | None:
    cleaned = [v.strip() for v in (values or []) if v.strip()]
    return ",".join(cleaned) or None


def _time(value: dt.time | None) -> str | None:
    """`HH:MM` — seconds on a market open would be noise, and the Console's
    time inputs do not offer them."""
    return value.strftime("%H:%M") if value is not None else None


def _parse_time(value: str | None) -> dt.time | None:
    """`HH:MM` or `HH:MM:SS`. A time of day has no date and no zone -- the
    venue's own timezone column is what places it -- so this parses to `time`
    rather than through `datetime`."""
    if value is None or not value.strip():
        return None
    try:
        return dt.time.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{value!r} is not a time of day (HH:MM)"
        ) from None


def _wire(row: models.ExchangesRow) -> dict[str, Any]:
    return {
        "exchange": row.exchange_code,
        "exchangeName": row.exchange_name,
        "segments": _split(row.segments),
        "currency": row.currency,
        "timezone": row.timezone,
        "preMarketStart": _time(row.pre_market_start),
        "preMarketEnd": _time(row.pre_market_end),
        "marketOpen": _time(row.market_open),
        "marketClose": _time(row.market_close),
        "dayInitMinutesBeforeMarketOpen": row.day_init_minutes_before_market_open,
        "algoStartMinutesBeforeMarketOpen": row.algo_start_minutes_before_market_open,
        "intradaySquareOffMinutesBeforeClose": row.intraday_squareoff_minutes_before_close,
        "intradaySquareOffBlockMinutesBeforeClose": (
            row.intraday_squareoff_block_minutes_before_close
        ),
        "postMarketWindowMinutes": row.post_market_window_minutes,
        "reportMinutesAfterClose": row.report_minutes_after_close,
        "weekendDays": _split(row.weekend_days),
        "historyCacheEnabled": row.history_cache_enabled,
        "isActive": bool(row.is_active),
    }


class ExchangeBody(BaseModel):
    """What the Console may send. Every field optional on update, so a form
    that round-trips only what it edits cannot blank the rest."""

    exchangeName: str | None = None  # noqa: N815 -- the Console's field names
    segments: list[str] | None = None
    currency: str | None = None
    timezone: str | None = None
    preMarketStart: str | None = None  # noqa: N815
    preMarketEnd: str | None = None  # noqa: N815
    marketOpen: str | None = None  # noqa: N815
    marketClose: str | None = None  # noqa: N815
    dayInitMinutesBeforeMarketOpen: int | None = None  # noqa: N815
    algoStartMinutesBeforeMarketOpen: int | None = None  # noqa: N815
    intradaySquareOffMinutesBeforeClose: int | None = None  # noqa: N815
    intradaySquareOffBlockMinutesBeforeClose: int | None = None  # noqa: N815
    postMarketWindowMinutes: int | None = None  # noqa: N815
    reportMinutesAfterClose: int | None = None  # noqa: N815
    weekendDays: list[str] | None = None  # noqa: N815
    historyCacheEnabled: bool | None = None  # noqa: N815
    isActive: bool | None = None  # noqa: N815


class NewExchange(ExchangeBody):
    exchange: str = Field(min_length=1, max_length=10)


def _checked_currency(value: str | None) -> str | None:
    """The loader refuses a currency it does not know, and refuses it at
    startup -- a long way from the form that typed it. Refuse it here."""
    if value is None:
        return None
    code = value.strip().upper()
    if code not in {c.value for c in Currency}:
        known = ", ".join(sorted(c.value for c in Currency))
        raise HTTPException(status_code=400, detail=f"{value!r} is not a currency; one of {known}")
    return code


def _checked_timezone(value: str | None) -> str | None:
    """The venue loader passes this straight to `ZoneInfo`, which raises on a
    zone the tz database does not have -- at startup, a long way from here."""
    if value is None or not value.strip():
        return None
    zone = value.strip()
    if zone not in set(TIMEZONES):
        raise HTTPException(status_code=400, detail=f"{zone!r} is not an IANA timezone")
    return zone


def _checked_segments(values: list[str] | None) -> str | None:
    """Same: a venue that lists a segment the engine does not have will not
    load, and an empty list will not build an exchange at all."""
    if values is None:
        return None
    named = [v.strip().upper() for v in values if v.strip()]
    unknown = sorted(set(named) - {s.value for s in Segment})
    if unknown:
        known = ", ".join(sorted(s.value for s in Segment))
        raise HTTPException(
            status_code=400,
            detail=f"{', '.join(unknown)} is not a segment; some of {known}",
        )
    return ",".join(named) or None


#: Wire name -> (column, converter). One table, so the mapping is written once
#: and both create and update read it.
_COLUMNS: dict[str, tuple[str, Any]] = {
    "exchangeName": ("exchange_name", lambda v: v),
    "segments": ("segments", _checked_segments),
    "currency": ("currency", _checked_currency),
    "timezone": ("timezone", _checked_timezone),
    "preMarketStart": ("pre_market_start", _parse_time),
    "preMarketEnd": ("pre_market_end", _parse_time),
    "marketOpen": ("market_open", _parse_time),
    "marketClose": ("market_close", _parse_time),
    "dayInitMinutesBeforeMarketOpen": ("day_init_minutes_before_market_open", lambda v: v),
    "algoStartMinutesBeforeMarketOpen": ("algo_start_minutes_before_market_open", lambda v: v),
    "intradaySquareOffMinutesBeforeClose": (
        "intraday_squareoff_minutes_before_close",
        lambda v: v,
    ),
    "intradaySquareOffBlockMinutesBeforeClose": (
        "intraday_squareoff_block_minutes_before_close",
        lambda v: v,
    ),
    "postMarketWindowMinutes": ("post_market_window_minutes", lambda v: v),
    "reportMinutesAfterClose": ("report_minutes_after_close", lambda v: v),
    "weekendDays": ("weekend_days", _join),
    "historyCacheEnabled": ("history_cache_enabled", lambda v: v),
    "isActive": ("is_active", lambda v: v),
}


def _values(body: ExchangeBody) -> dict[str, Any]:
    """Only what was sent. `exclude_unset` is the point: `None` sent
    deliberately clears a column, `None` because the field was absent does
    not touch it."""
    sent = body.model_dump(exclude_unset=True)
    return {
        column: convert(sent[wire]) for wire, (column, convert) in _COLUMNS.items() if wire in sent
    }


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/exchanges", tags=["exchanges"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    @router.get("")
    async def list_exchanges(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await ExchangesRepository(db).all(order_by="exchange_code")
        return ok([_wire(row) for row in rows])

    @router.get("/options")
    async def options() -> dict[str, Any]:
        """What the venue form may choose from.

        Served rather than hardcoded in the Console: these are the engine's own
        enums, and a second copy of them in the UI drifts the moment one gains
        a member. Declared before `/{code}` so that path does not swallow it.
        """
        return ok(
            {
                "currencies": sorted(c.value for c in Currency),
                "segments": sorted(s.value for s in Segment),
                "weekendDays": list(WEEKDAYS),
                "timezones": list(TIMEZONES),
            }
        )

    @router.get("/{code}")
    async def one_exchange(code: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await ExchangesRepository(db).get(code.upper())
        if row is None:
            raise HTTPException(status_code=404, detail=f"no exchange {code!r}")
        return ok(_wire(row))

    @router.post("")
    async def create_exchange(
        body: NewExchange, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        exchanges = ExchangesRepository(db)
        code = body.exchange.upper()
        if await exchanges.get(code) is not None:
            raise HTTPException(status_code=409, detail=f"exchange {code} already exists")

        values = _values(body)
        # NOT NULL in the schema, and for a reason: a venue with no hours has
        # no session, and a P&L figure with no currency is a number with no
        # unit. Refuse rather than invent a default.
        for wire, column in (
            ("exchangeName", "exchange_name"),
            ("currency", "currency"),
            ("marketOpen", "market_open"),
            ("marketClose", "market_close"),
            # Not NOT NULL in the schema, but a venue with no segments cannot
            # be built, so accepting one is accepting a row that breaks
            # startup rather than this request.
            ("segments", "segments"),
        ):
            if values.get(column) is None:
                raise HTTPException(status_code=400, detail=f"{wire} is required")

        row = models.ExchangesRow(exchange_code=code, **values)
        exchanges.add(row)
        await db.commit()
        await db.refresh(row)
        return ok(_wire(row), message=f"{code} created")

    @router.put("/{code}")
    async def update_exchange(
        code: str, body: ExchangeBody, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        exchanges = ExchangesRepository(db)
        key = code.upper()
        if await exchanges.get(key) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {code!r}")

        values = _values(body)
        if values:
            await exchanges.update(key, **values)
            await db.commit()
        row = await exchanges.require(key)
        return ok(_wire(row), message=f"{key} saved")

    @router.delete("/{code}")
    async def delete_exchange(code: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        removed = await ExchangesRepository(db).delete(code.upper())
        if not removed:
            raise HTTPException(status_code=404, detail=f"no exchange {code!r}")
        await db.commit()
        return ok(None, message=f"{code.upper()} deleted")

    return router
