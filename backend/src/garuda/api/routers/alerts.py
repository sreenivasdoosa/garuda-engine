"""Alerts: everything the engine has said, with the bell's two reads.

The Terminal shows today's open alerts live over the socket. This is the
page over the table, which is where an alert goes once it has been
raised, coalesced by key, and kept: the operator's only channel, since
there is no email and no Telegram, so what the bell did not catch must be
readable later. Ported from the reference's alerts servlet: the bell's
recent and since reads, the paged list with its filters and search, and
the filter choices. Read-only, as the reference's was.

Garuda has no alert audience; the reference's ``audience`` parameter is
accepted and ignored so the copied page keeps working while it is
simplified.
"""

from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.alert import AlertLevel, EntityType
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository
from garuda.protocols.clock import Clock

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500
DEFAULT_RECENT = 50


def _iso(moment: dt.datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def alert_wire(row: models.AlertsRow) -> dict[str, Any]:
    """The bell's shape, the same the socket sends, plus what the table knows."""
    return {
        "id": row.id,
        "timestamp": _iso(row.raised_at),
        "tradingDay": row.trading_day.isoformat(),
        "alertLevel": row.level,
        "entityType": row.entity_type,
        "entityName": row.entity,
        "operation": row.operation,
        "alertMessage": row.message,
        "uniqueKey": row.unique_key,
        "firstOccurrenceTime": _iso(row.first_raised_at),
        "occurrenceCount": row.occurrences,
    }


def _moment(
    value: str | None, zone: dt.tzinfo, *, name: str, end: bool = False
) -> dt.datetime | None:
    """A bound as the operator meant it: an instant, or a venue day."""
    if value is None or not value.strip():
        return None
    text = value.strip().replace(" ", "T", 1)
    try:
        if text.lstrip("-").isdigit():
            return dt.datetime.fromtimestamp(int(text) / 1000, tz=dt.UTC)
        if len(text) == 10:
            day = dt.date.fromisoformat(text)
            if end:
                day += dt.timedelta(days=1)
            return dt.datetime.combine(day, dt.time.min, tzinfo=zone)
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{name}: {value!r} is not a date or a date and time"
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=zone)


def _level(value: str | None) -> str | None:
    if value is None or not value.strip() or value.strip().lower() == "all":
        return None
    wanted = value.strip().upper()
    if wanted not in {level.value for level in AlertLevel}:
        raise HTTPException(status_code=400, detail=f"{value!r} is not an alert level")
    return wanted


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/alerts", tags=["alerts"])
    table = models.AlertsRow
    del clock  # the bounds are the operator's; nothing here needs now

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

    @router.get("/recent")
    async def recent(
        limit: int = Query(default=DEFAULT_RECENT, ge=1, le=MAX_PAGE_SIZE),
        alertLevel: str | None = None,  # noqa: N803
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """The bell: the latest, newest first."""
        statement = select(table).order_by(table.raised_at.desc(), table.id.desc()).limit(limit)
        level = _level(alertLevel)
        if level:
            statement = statement.where(table.level == level)
        rows = (await db.execute(statement)).scalars()
        return ok([alert_wire(row) for row in rows])

    @router.get("/since")
    async def since(
        timestamp: str = Query(default=""),
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """What was raised after an instant; the bell's poll."""
        if not timestamp.strip():
            raise HTTPException(status_code=400, detail="timestamp is required")
        after = _moment(timestamp, await _zone(db), name="timestamp")
        statement = (
            select(table)
            .where(table.raised_at > after)
            .order_by(table.raised_at.desc(), table.id.desc())
            .limit(MAX_PAGE_SIZE)
        )
        rows = (await db.execute(statement)).scalars()
        return ok([alert_wire(row) for row in rows])

    @router.get("/filters")
    async def filters(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """What the dropdowns offer: every value the table holds, and the levels."""

        async def distinct(column: Any) -> list[str]:
            values = (await db.execute(select(column).distinct())).scalars()
            return sorted(v for v in values if v)

        return ok(
            {
                "operations": await distinct(table.operation),
                "entityTypes": sorted(
                    set(await distinct(table.entity_type)) | {t.value for t in EntityType}
                ),
                "entityNames": await distinct(table.entity),
                "alertLevels": [level.value for level in AlertLevel],
            }
        )

    @router.get("")
    async def listing(
        page: int = Query(default=1, ge=1),
        pageSize: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),  # noqa: N803
        alertLevel: str | None = None,  # noqa: N803
        entityType: str | None = None,  # noqa: N803
        entityName: str | None = None,  # noqa: N803
        operation: str | None = None,
        search: str | None = None,
        startTime: str | None = None,  # noqa: N803
        endTime: str | None = None,  # noqa: N803
        audience: str | None = None,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """The page: filtered, searched and paged in SQL, newest first."""
        del audience  # the reference's; garuda has one audience
        zone = await _zone(db)
        statement = select(table)
        level = _level(alertLevel)
        if level:
            statement = statement.where(table.level == level)
        if entityType and entityType.strip().lower() != "all":
            statement = statement.where(table.entity_type == entityType.strip().upper())
        if entityName and entityName.strip():
            statement = statement.where(table.entity == entityName.strip())
        if operation and operation.strip():
            statement = statement.where(table.operation == operation.strip())
        start = _moment(startTime, zone, name="startTime")
        end = _moment(endTime, zone, name="endTime", end=True)
        if start is not None:
            statement = statement.where(table.raised_at >= start)
        if end is not None:
            statement = statement.where(table.raised_at < end)
        if search and search.strip():
            like = f"%{search.strip().lower()}%"
            statement = statement.where(
                or_(
                    func.lower(table.message).like(like),
                    func.lower(table.entity).like(like),
                    func.lower(table.operation).like(like),
                )
            )
        total = int(
            (await db.execute(select(func.count()).select_from(statement.subquery()))).scalar_one()
        )
        rows = (
            await db.execute(
                statement.order_by(table.raised_at.desc(), table.id.desc())
                .offset((page - 1) * pageSize)
                .limit(pageSize)
            )
        ).scalars()
        pages = max(1, (total + pageSize - 1) // pageSize)
        return ok(
            {
                "alerts": [alert_wire(row) for row in rows],
                "pagination": {
                    "page": page,
                    "pageSize": pageSize,
                    "totalCount": total,
                    "totalPages": pages,
                    "hasNext": page < pages,
                    "hasPrev": page > 1,
                },
            }
        )

    return router
