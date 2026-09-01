"""Days an exchange is shut.

A holiday is `(exchange, date)` and an optional description — the whole table.
The venue loader reads these into each exchange's trading calendar, so a
holiday against an exchange that does not exist is not a harmless orphan: it
is silently dropped, and the venue then trades on a day it should not.
Creation checks the exchange for that reason.

Dates are stored as `YYYY-MM-DD` text, which is what the column holds and what
the Console sends. They are parsed here anyway, so a malformed one is refused
rather than stored as a string no calendar will ever match.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository, HolidaysRepository


def _day(value: str) -> str:
    """`YYYY-MM-DD`, round-tripped through `date` so it is provably one."""
    try:
        return dt.date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{value!r} is not a date (YYYY-MM-DD)"
        ) from None


def _wire(row: models.HolidaysRow) -> dict[str, Any]:
    return {
        "exchange": row.exchange,
        "date": row.date,
        "description": row.description,
    }


class NewHoliday(BaseModel):
    exchange: str = Field(min_length=1, max_length=10)
    date: str
    description: str | None = None


class HolidayEdit(BaseModel):
    description: str | None = None


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/holidays", tags=["holidays"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    @router.get("/{exchange}")
    async def list_holidays(exchange: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every holiday for one exchange, oldest first.

        An exchange with no holidays and an exchange that does not exist both
        answer with an empty list. The Console asks for each exchange in turn
        while building its table, and a 404 in the middle of that would read as
        a failure rather than as "none".
        """
        rows = await HolidaysRepository(db).find(exchange=exchange.upper(), order_by="date")
        return ok([_wire(row) for row in rows])

    @router.post("")
    async def create_holiday(
        body: NewHoliday, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        exchange = body.exchange.upper()
        day = _day(body.date)

        # The venue loader groups holidays by exchange code. One that matches
        # no venue is never read, so the day it describes stays open.
        if await ExchangesRepository(db).get(exchange) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {body.exchange!r}")

        holidays = HolidaysRepository(db)
        if await holidays.get(day, exchange) is not None:
            raise HTTPException(
                status_code=409, detail=f"{exchange} already has a holiday on {day}"
            )

        row = models.HolidaysRow(
            date=day, exchange=exchange, description=(body.description or None)
        )
        holidays.add(row)
        await db.commit()
        return ok(_wire(row), message=f"{exchange} closed on {day}")

    @router.put("/{exchange}/{date}")
    async def update_holiday(
        exchange: str, date: str, body: HolidayEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Only the description is editable.

        Moving a holiday means deleting one and adding another: the pair is the
        key, so an edit that changed it would be an insert wearing a PUT.
        """
        holidays = HolidaysRepository(db)
        key = (_day(date), exchange.upper())
        if await holidays.get(*key) is None:
            raise HTTPException(status_code=404, detail=f"{key[1]} has no holiday on {key[0]}")

        await holidays.update(*key, description=(body.description or None))
        await db.commit()
        row = await holidays.require(*key)
        return ok(_wire(row), message="holiday updated")

    @router.delete("/{exchange}/{date}")
    async def delete_holiday(
        exchange: str, date: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        day, code = _day(date), exchange.upper()
        if not await HolidaysRepository(db).delete(day, code):
            raise HTTPException(status_code=404, detail=f"{code} has no holiday on {day}")
        await db.commit()
        return ok(None, message=f"{code} open on {day}")

    return router
