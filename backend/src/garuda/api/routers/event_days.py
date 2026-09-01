"""Event days: dates the operator wants traded at reduced size.

Two levels, and no more. An event day sets a percentage for one exchange on
one date; a strategy override sets a different percentage for one named
strategy on that same date and exchange. Everything else on that exchange
keeps the day's figure.

    event day   2026-02-02  NSE  50%     every strategy trades half size
    override    2026-02-02  NSE  short-strangle  60%

The reference engine also resolved per user and per product, between those
two. Product is not a scope a strategy is configured against here, and with
one operator a per-user override is an override of yourself.

The reference engine also carried a `BO_CO_BLOCKED` flag on an event day.
Garuda places neither bracket nor cover orders -- both carry a broker-side
stop the engine cannot see or move -- so the flag has nothing to block and the
column is gone.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.capital.event_days import as_written
from garuda.persistence import models
from garuda.persistence.repositories import (
    EventDaysRepository,
    ExchangesRepository,
    StrategyEventDaysRepository,
)

#: The engine refuses anything outside this when it builds its lookup, so the
#: API refuses it here -- otherwise the row is stored and then dropped at
#: startup, and the day silently trades full size.
LOWEST = Decimal(0)
HIGHEST = Decimal(100)


def _day(value: str) -> str:
    try:
        return dt.date.fromisoformat(value.strip()).isoformat()
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{value!r} is not a date (YYYY-MM-DD)"
        ) from None


def _percentage(value: Decimal | float | int | None) -> Decimal:
    """Always required.

    A day with no figure states nothing, and the engine skips such a row --
    so accepting one would store something that does not do what it looks
    like. `None` is a refusal rather than a default.
    """
    if value is None:
        raise HTTPException(status_code=400, detail="capitalPercentage is required")
    number = Decimal(str(value))
    if number < LOWEST or number > HIGHEST:
        raise HTTPException(
            status_code=400,
            detail=(
                f"capitalPercentage {number:g} is outside 0-100. Above 100 would size up on a "
                "day flagged as risky; 0 sits the day out."
            ),
        )
    return number


def _wire(row: models.EventDaysRow) -> dict[str, Any]:
    return {
        "exchange": row.exchange_code,
        "eventDate": row.event_date,
        "eventName": row.event_name,
        "capitalPercentage": (
            float(row.capital_percentage) if row.capital_percentage is not None else None
        ),
    }


def _override_wire(row: models.StrategyEventDaysRow) -> dict[str, Any]:
    return {
        "strategyName": row.strategy_name,
        "exchangeCode": row.exchange_code,
        "eventDate": row.event_date,
        "capitalPercentage": float(row.capital_percentage),
    }


class EventDayEdit(BaseModel):
    eventName: str | None = None  # noqa: N815 -- the Console's field names
    capitalPercentage: float | None = None  # noqa: N815


class NewEventDay(EventDayEdit):
    eventDate: str  # noqa: N815


class OverrideEdit(BaseModel):
    capitalPercentage: float  # noqa: N815


class NewOverride(OverrideEdit):
    eventDate: str  # noqa: N815
    exchangeCode: str = Field(min_length=1, max_length=10)  # noqa: N815


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(tags=["event-days"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    # -- the exchange-level day ---------------------------------------------

    @router.get("/api/event-days/{exchange}")
    async def list_days(exchange: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """One exchange's event days, oldest first. An unknown exchange lists
        nothing rather than 404ing, as with holidays."""
        rows = await EventDaysRepository(db).find(
            exchange_code=exchange.upper(), order_by="event_date"
        )
        return ok([_wire(row) for row in rows])

    @router.get("/api/event-days/{exchange}/{event_date}")
    async def one_day(
        exchange: str, event_date: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await EventDaysRepository(db).get(_day(event_date), exchange.upper())
        if row is None:
            raise HTTPException(
                status_code=404, detail=f"{exchange.upper()} has no event day on {event_date}"
            )
        return ok(_wire(row))

    @router.post("/api/event-days/{exchange}")
    async def create_day(
        exchange: str, body: NewEventDay, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        code, day = exchange.upper(), _day(body.eventDate)
        percentage = _percentage(body.capitalPercentage)

        # The engine keys event days by exchange code, so one that matches no
        # venue is never read and the day trades full size.
        if await ExchangesRepository(db).get(code) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {exchange!r}")

        days = EventDaysRepository(db)
        if await days.get(day, code) is not None:
            raise HTTPException(status_code=409, detail=f"{code} already has an event day on {day}")

        row = models.EventDaysRow(
            event_date=day,
            exchange_code=code,
            event_name=(body.eventName or None),
            capital_percentage=percentage,
        )
        days.add(row)
        await db.commit()
        return ok(_wire(row), message=f"{code} trades at {as_written(percentage)}% on {day}")

    @router.put("/api/event-days/{exchange}/{event_date}")
    async def update_day(
        exchange: str, event_date: str, body: EventDayEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        days = EventDaysRepository(db)
        key = (_day(event_date), exchange.upper())
        if await days.get(*key) is None:
            raise HTTPException(status_code=404, detail=f"{key[1]} has no event day on {key[0]}")

        sent = body.model_dump(exclude_unset=True)
        values: dict[str, Any] = {}
        if "eventName" in sent:
            values["event_name"] = sent["eventName"] or None
        if "capitalPercentage" in sent:
            values["capital_percentage"] = _percentage(sent["capitalPercentage"])
        if values:
            await days.update(*key, **values)
            await db.commit()
        return ok(_wire(await days.require(*key)), message="event day updated")

    @router.delete("/api/event-days/{exchange}/{event_date}")
    async def delete_day(
        exchange: str, event_date: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        code, day = exchange.upper(), _day(event_date)
        if not await EventDaysRepository(db).delete(day, code):
            raise HTTPException(status_code=404, detail=f"{code} has no event day on {day}")
        await db.commit()
        return ok(None, message=f"{code} trades normally on {day}")

    # -- one strategy's override -------------------------------------------

    @router.get("/api/strategy-event-day-actions")
    async def list_overrides(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await StrategyEventDaysRepository(db).all(order_by="event_date")
        return ok([_override_wire(row) for row in rows])

    @router.get("/api/strategy-event-day-actions/{strategy}")
    async def overrides_for(
        strategy: str,
        db: AsyncSession = Depends(session),
        exchange: str | None = Query(default=None),
        eventDate: str | None = Query(default=None),  # noqa: N803 -- the Console's parameter
    ) -> dict[str, Any]:
        """One strategy's overrides, narrowed by the query parameters the
        Console sends."""
        filters: dict[str, Any] = {"strategy_name": strategy}
        if exchange:
            filters["exchange_code"] = exchange.upper()
        if eventDate:
            filters["event_date"] = _day(eventDate)
        rows = await StrategyEventDaysRepository(db).find(order_by="event_date", **filters)
        return ok([_override_wire(row) for row in rows])

    @router.post("/api/strategy-event-day-actions/{strategy}")
    async def create_override(
        strategy: str, body: NewOverride, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        code, day = body.exchangeCode.upper(), _day(body.eventDate)
        percentage = _percentage(body.capitalPercentage)

        # An override with no event day under it is allowed on purpose: it
        # scales that strategy on that date whether or not the operator has
        # flagged the day for everything else.
        if await ExchangesRepository(db).get(code) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {body.exchangeCode!r}")

        overrides = StrategyEventDaysRepository(db)
        if await overrides.get(strategy, day, code) is not None:
            raise HTTPException(
                status_code=409,
                detail=f"{strategy} already has an override for {code} on {day}",
            )

        row = models.StrategyEventDaysRow(
            strategy_name=strategy,
            event_date=day,
            exchange_code=code,
            capital_percentage=percentage,
        )
        overrides.add(row)
        await db.commit()
        return ok(
            _override_wire(row),
            message=f"{strategy} trades at {as_written(percentage)}% on {code} on {day}",
        )

    @router.put("/api/strategy-event-day-actions/{strategy}")
    async def update_override(
        strategy: str,
        body: OverrideEdit,
        db: AsyncSession = Depends(session),
        exchange: str = Query(),
        eventDate: str = Query(),  # noqa: N803
    ) -> dict[str, Any]:
        overrides = StrategyEventDaysRepository(db)
        key = (strategy, _day(eventDate), exchange.upper())
        if await overrides.get(*key) is None:
            raise HTTPException(
                status_code=404,
                detail=f"{strategy} has no override for {key[2]} on {key[1]}",
            )

        percentage = _percentage(body.capitalPercentage)
        await overrides.update(*key, capital_percentage=percentage)
        await db.commit()
        return ok(_override_wire(await overrides.require(*key)), message="override updated")

    @router.delete("/api/strategy-event-day-actions/{strategy}")
    async def delete_override(
        strategy: str,
        db: AsyncSession = Depends(session),
        exchange: str | None = Query(default=None),
        eventDate: str | None = Query(default=None),  # noqa: N803
    ) -> dict[str, Any]:
        """One override, or every one this strategy has.

        Both parameters or neither: deleting "every override on NSE" is not
        something the Console offers, and guessing at it here would make a
        half-filled query destructive.
        """
        overrides = StrategyEventDaysRepository(db)
        if bool(exchange) != bool(eventDate):
            raise HTTPException(
                status_code=400,
                detail="give both exchange and eventDate, or neither to delete all of them",
            )
        if exchange and eventDate:
            key = (strategy, _day(eventDate), exchange.upper())
            if not await overrides.delete(*key):
                raise HTTPException(
                    status_code=404,
                    detail=f"{strategy} has no override for {key[2]} on {key[1]}",
                )
            await db.commit()
            return ok(None, message=f"{strategy} follows the event day again")

        removed = await overrides.delete_where(strategy_name=strategy)
        await db.commit()
        return ok(None, message=f"{removed} override(s) removed from {strategy}")

    return router
