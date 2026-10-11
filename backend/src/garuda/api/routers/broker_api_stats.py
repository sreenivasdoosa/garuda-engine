"""Broker API Stats: how long each call to the broker took, one day at a time.

Ported from the reference's servlet: a day, every broker or one, the raw
rows. The Console aggregates them itself -- counts, averages and the slow
ones -- which is why the rows go across whole. A day is the venue's day.
"""

from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository
from garuda.protocols.clock import Clock

MAX_ROWS = 5000


def _epoch_ms(moment: dt.datetime | None) -> int | None:
    return None if moment is None else int(moment.timestamp() * 1000)


def stat_wire(row: models.BrokerApiStatsRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "broker": row.broker_name,
        "operation": row.operation,
        "entityId": row.order_id,
        "startTime": row.start_time.isoformat() if row.start_time else None,
        "endTime": row.end_time.isoformat() if row.end_time else None,
        "startEpoch": _epoch_ms(row.start_time),
        "endEpoch": _epoch_ms(row.end_time),
        "timeTaken": row.time_taken or 0,
    }


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/broker-api-stats", tags=["broker-api-stats"])

    async def session() -> Any:
        async with sessions() as db:
            yield db

    async def _zone(db: AsyncSession) -> dt.tzinfo:
        for row in await ExchangesRepository(db).all(order_by="exchange_code"):
            if row.timezone:
                try:
                    return ZoneInfo(row.timezone)
                except ZoneInfoNotFoundError:
                    continue
        return dt.UTC

    @router.get("")
    async def stats(
        date: str | None = None,
        broker: str | None = None,
        limit: int = Query(default=MAX_ROWS, ge=1, le=MAX_ROWS),
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """Every timed call on a day, newest first. Today when no date is given."""
        zone = await _zone(db)
        if date:
            try:
                day = dt.date.fromisoformat(date.strip())
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"{date!r} is not a date (YYYY-MM-DD)"
                ) from None
        else:
            day = clock.now().astimezone(zone).date()
        start = dt.datetime.combine(day, dt.time.min, tzinfo=zone)
        table = models.BrokerApiStatsRow
        statement = (
            select(table)
            .where(table.start_time >= start)
            .where(table.start_time < start + dt.timedelta(days=1))
            .order_by(table.start_time.desc(), table.id.desc())
            .limit(limit)
        )
        if broker and broker.strip().lower() != "all":
            statement = statement.where(table.broker_name == broker.strip().lower())
        rows = (await db.execute(statement)).scalars()
        return ok([stat_wire(row) for row in rows])

    return router
