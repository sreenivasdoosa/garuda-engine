"""Days the venue is open that its own schedule would have closed.

Two cases, one table. Budget day falling on a Saturday is the common one: the
exchange trades its usual hours on a day the weekend rule would shut, so the
row carries no hours of its own. Diwali muhurat is the other: a short evening
session on a day that is otherwise a holiday, so the row carries both.

The venue loader turns these into the calendar's `special_sessions`, which win
over the weekly schedule *and* over holidays. The reference engine's rule was
narrower -- a special day overrode a weekend but not an explicit holiday --
which cannot express a muhurat session at all, since Diwali is both.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository, SpecialTradingDaysRepository


def _day(value: str) -> str:
    try:
        return dt.date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{value!r} is not a date (YYYY-MM-DD)"
        ) from None


def _time(value: dt.time | None) -> str | None:
    return value.strftime("%H:%M") if value is not None else None


def _parse_time(value: str | None) -> dt.time | None:
    if value is None or not value.strip():
        return None
    try:
        return dt.time.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{value!r} is not a time of day (HH:MM)"
        ) from None


def _wire(row: models.SpecialTradingDaysRow) -> dict[str, Any]:
    return {
        "exchange": row.exchange,
        "tradingDate": row.trading_date,
        "tradingDayName": row.trading_day_name,
        "marketOpen": _time(row.market_open),
        "marketClose": _time(row.market_close),
    }


class SpecialDayEdit(BaseModel):
    tradingDayName: str | None = None  # noqa: N815 -- the Console's field names
    marketOpen: str | None = None  # noqa: N815
    marketClose: str | None = None  # noqa: N815


class NewSpecialDay(SpecialDayEdit):
    exchange: str = Field(min_length=1, max_length=10)
    tradingDate: str  # noqa: N815


def _hours(body: SpecialDayEdit) -> tuple[dt.time | None, dt.time | None]:
    """Both hours or neither.

    One side alone cannot make a session, and the loader would quietly fall
    back to the venue's usual hours -- which looks like the edit was ignored.
    Refuse it here instead, while there is someone to tell.
    """
    opens, closes = _parse_time(body.marketOpen), _parse_time(body.marketClose)
    if (opens is None) != (closes is None):
        raise HTTPException(
            status_code=400,
            detail="give both marketOpen and marketClose, or neither for the venue's usual hours",
        )
    if opens is not None and closes is not None and opens >= closes:
        raise HTTPException(status_code=400, detail="marketOpen must be before marketClose")
    return opens, closes


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/special-trading-days", tags=["special-trading-days"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    @router.get("")
    async def list_all(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every venue's special days, oldest first."""
        rows = await SpecialTradingDaysRepository(db).all(order_by="trading_date")
        return ok([_wire(row) for row in rows])

    @router.get("/{exchange}")
    async def list_for_exchange(
        exchange: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """One venue's. An unknown venue lists nothing rather than 404ing, as
        with holidays -- the Console asks per exchange while building a table."""
        rows = await SpecialTradingDaysRepository(db).find(
            exchange=exchange.upper(), order_by="trading_date"
        )
        return ok([_wire(row) for row in rows])

    @router.post("")
    async def create(body: NewSpecialDay, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        exchange = body.exchange.upper()
        day = _day(body.tradingDate)
        opens, closes = _hours(body)

        # The loader keys these by exchange code, so one that matches no venue
        # is never read -- and the day it was meant to open stays shut.
        if await ExchangesRepository(db).get(exchange) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {body.exchange!r}")

        days = SpecialTradingDaysRepository(db)
        if await days.get(exchange, day) is not None:
            raise HTTPException(
                status_code=409, detail=f"{exchange} already has a special day on {day}"
            )

        row = models.SpecialTradingDaysRow(
            exchange=exchange,
            trading_date=day,
            trading_day_name=(body.tradingDayName or None),
            market_open=opens,
            market_close=closes,
        )
        days.add(row)
        await db.commit()
        return ok(_wire(row), message=f"{exchange} trades on {day}")

    @router.put("/{exchange}/{date}")
    async def update(
        exchange: str, date: str, body: SpecialDayEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        days = SpecialTradingDaysRepository(db)
        key = (exchange.upper(), _day(date))
        if await days.get(*key) is None:
            raise HTTPException(status_code=404, detail=f"{key[0]} has no special day on {key[1]}")

        opens, closes = _hours(body)
        await days.update(
            *key,
            trading_day_name=(body.tradingDayName or None),
            market_open=opens,
            market_close=closes,
        )
        await db.commit()
        return ok(_wire(await days.require(*key)), message="special trading day updated")

    @router.delete("/{exchange}/{date}")
    async def remove(
        exchange: str, date: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        code, day = exchange.upper(), _day(date)
        if not await SpecialTradingDaysRepository(db).delete(code, day):
            raise HTTPException(status_code=404, detail=f"{code} has no special day on {day}")
        await db.commit()
        return ok(None, message=f"{code} closed on {day}")

    return router
