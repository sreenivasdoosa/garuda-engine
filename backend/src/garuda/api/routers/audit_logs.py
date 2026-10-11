"""Audit Logs: who changed what, and what it was before.

Read-only. The rows are written by the audit middleware from what the
repositories captured during each request; this is the page over them.
Ported from the reference's audit log servlet: a paged list with its
filters, the entity types for the dropdown, one entity's history, and one
user's. Its search is the reference's five columns, in SQL, so the count
and the page agree.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.audit import ENTITY_TYPES, AuditAction
from garuda.protocols.clock import Clock

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 1000


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value else None


def entry_wire(row: models.AuditLogRow) -> dict[str, Any]:
    return {
        "id": row.id,
        "entityType": row.entity_type,
        "entityId": row.entity_id,
        "entityName": row.entity_name,
        "action": row.action,
        "oldData": row.old_data,
        "newData": row.new_data,
        "changedBy": row.changed_by,
        "changedTimestamp": _iso(row.changed_timestamp),
    }


def _moment(value: str, *, name: str) -> dt.datetime:
    """Epoch milliseconds, as the reference takes, or an ISO instant."""
    text = value.strip()
    if text.lstrip("-").isdigit():
        return dt.datetime.fromtimestamp(int(text) / 1000, tz=dt.UTC)
    try:
        parsed = dt.datetime.fromisoformat(text)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"{name}: {value!r} is neither epoch milliseconds nor an ISO instant",
        ) from None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.UTC)


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/audit-logs", tags=["audit-logs"])
    table = models.AuditLogRow

    async def session() -> Any:
        async with sessions() as db:
            yield db

    @router.get("/entity-types")
    async def entity_types(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every entity type the log knows: the named ones, and any it holds."""
        stored = (await db.execute(select(table.entity_type).distinct())).scalars()
        return ok(sorted(set(ENTITY_TYPES.values()) | set(stored)))

    @router.get("/entity/{entity_type}/{entity_id}")
    async def by_entity(
        entity_type: str, entity_id: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Everything that ever happened to one thing, newest first."""
        statement = (
            select(table)
            .where(table.entity_type == entity_type.upper())
            .where(table.entity_id == entity_id)
            .order_by(table.changed_timestamp.desc(), table.id.desc())
        )
        rows = (await db.execute(statement)).scalars()
        return ok([entry_wire(row) for row in rows])

    @router.get("/user/{username}")
    async def by_user(
        username: str,
        limit: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        statement = (
            select(table)
            .where(table.changed_by == username)
            .order_by(table.changed_timestamp.desc(), table.id.desc())
            .limit(limit)
        )
        rows = (await db.execute(statement)).scalars()
        return ok([entry_wire(row) for row in rows])

    @router.get("")
    async def listing(
        page: int | None = Query(default=None, ge=1),
        pageSize: int | None = Query(default=None, ge=1, le=MAX_PAGE_SIZE),  # noqa: N803
        limit: int | None = Query(default=None, ge=1, le=MAX_PAGE_SIZE),
        offset: int | None = Query(default=None, ge=0),
        entityType: str | None = None,  # noqa: N803
        entityTypes: str | None = None,  # noqa: N803
        action: str | None = None,
        username: str | None = None,
        days: int | None = Query(default=None, ge=1),
        startDate: str | None = None,  # noqa: N803
        endDate: str | None = None,  # noqa: N803
        search: str | None = None,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """The log, newest first, filtered and paged in SQL.

        ``page``/``pageSize`` is the Console's envelope; ``limit``/``offset``
        is honoured for older callers, as the reference does.
        """
        if page is not None or pageSize is not None:
            size = pageSize or DEFAULT_PAGE_SIZE
            number = page or 1
        else:
            size = limit or DEFAULT_PAGE_SIZE
            number = ((offset or 0) // size) + 1

        statement = select(table)
        types: list[str] = []
        if entityTypes:
            types = [part.strip().upper() for part in entityTypes.split(",") if part.strip()]
        elif entityType:
            types = [entityType.strip().upper()]
        if types:
            statement = statement.where(table.entity_type.in_(types))
        if action:
            wanted = action.strip().upper()
            if wanted not in {a.value for a in AuditAction}:
                raise HTTPException(status_code=400, detail=f"{action!r} is not an audit action")
            statement = statement.where(table.action == wanted)
        if username:
            statement = statement.where(table.changed_by == username)
        if days is not None:
            end = clock.now()
            statement = statement.where(table.changed_timestamp >= end - dt.timedelta(days=days))
            statement = statement.where(table.changed_timestamp <= end)
        elif startDate and endDate:
            statement = statement.where(
                table.changed_timestamp >= _moment(startDate, name="startDate")
            ).where(table.changed_timestamp <= _moment(endDate, name="endDate"))
        if search and search.strip():
            like = f"%{search.strip().lower()}%"
            statement = statement.where(
                or_(
                    func.lower(table.entity_type).like(like),
                    func.lower(table.entity_id).like(like),
                    func.lower(table.entity_name).like(like),
                    func.lower(table.changed_by).like(like),
                    func.lower(table.action).like(like),
                )
            )

        total = int(
            (await db.execute(select(func.count()).select_from(statement.subquery()))).scalar_one()
        )
        rows = (
            await db.execute(
                statement.order_by(table.changed_timestamp.desc(), table.id.desc())
                .offset((number - 1) * size)
                .limit(size)
            )
        ).scalars()
        pages = max(1, (total + size - 1) // size)
        return ok(
            {
                "data": [entry_wire(row) for row in rows],
                "pagination": {
                    "page": number,
                    "pageSize": size,
                    "totalCount": total,
                    "totalPages": pages,
                    "hasNext": number < pages,
                    "hasPrev": number > 1,
                },
            }
        )

    return router
