"""Stock universes: a named list of symbols a strategy can draw from.

`STOCK_UNIVERSES` and `STOCK_UNIVERSE_MEMBERS` in the reference. Two types
there, and the distinction is about where the members come from:

* **CUSTOM** — a list the operator edits. The members are the table's rows.
* **PREDEFINED_INDEX** — an NSE index whose members are materialised daily
  from the exchange's own CSVs, with `index_key` naming which one.

Only CUSTOM is usable here today. Garuda has no NSE CSV pipeline, so a
PREDEFINED_INDEX universe would have whatever members were last written by
hand and a `last_refreshed_at` that never moves. It is accepted, because the
column exists and an operator may want the row ready, and it is reported as
unbuilt in `docs/PROGRESS.md` rather than left to look as though it refreshes.

**The engine does not read these yet.** `strategy_definitions.universe_id` is
the hook and nothing resolves it into subscriptions; that is engine work
belonging with the strategy pages. Until then a universe is a list an operator
can curate and nothing trades from — which is stated here so the page does not
imply otherwise.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    ExchangesRepository,
    StockUniverseMembersRepository,
    StockUniversesRepository,
    SymbolsRepository,
)
from garuda.protocols.clock import Clock

CUSTOM = "CUSTOM"
PREDEFINED_INDEX = "PREDEFINED_INDEX"
TYPES = (CUSTOM, PREDEFINED_INDEX)

MANUAL = "MANUAL"
NSE_CSV = "NSE_CSV"
SOURCES = (MANUAL, NSE_CSV)


def _instant(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _wire(row: models.StockUniversesRow, members: list[str] | None = None) -> dict[str, Any]:
    body: dict[str, Any] = {
        "universeId": row.universe_id,
        "name": row.name,
        "universeType": row.universe_type,
        "indexKey": row.index_key,
        "exchange": row.exchange,
        "isActive": bool(row.is_active),
        "source": row.source,
        "lastRefreshedAt": _instant(row.last_refreshed_at),
        "createdAt": _instant(row.created_at),
        "updatedAt": _instant(row.updated_at),
    }
    if members is not None:
        body["members"] = members
    return body


class UniverseEdit(BaseModel):
    name: str | None = None
    universeType: str | None = None  # noqa: N815 -- the Console's field names
    indexKey: str | None = None  # noqa: N815
    exchange: str | None = None
    isActive: bool | None = None  # noqa: N815
    source: str | None = None
    members: list[str] | None = None


class NewUniverse(UniverseEdit):
    name: str = Field(min_length=1, max_length=100)


def _checked_type(value: str | None) -> str:
    if value is None:
        return CUSTOM
    kind = value.strip().upper()
    if kind not in TYPES:
        raise HTTPException(
            status_code=400, detail=f"universeType must be one of {', '.join(TYPES)}"
        )
    return kind


def _checked_source(value: str | None, kind: str) -> str:
    if value is None:
        # A predefined index is materialised from the exchange's CSVs; a custom
        # list is whatever the operator typed. Neither default is a guess.
        return NSE_CSV if kind == PREDEFINED_INDEX else MANUAL
    source = value.strip().upper()
    if source not in SOURCES:
        raise HTTPException(status_code=400, detail=f"source must be one of {', '.join(SOURCES)}")
    return source


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/engine/universes", tags=["stock-universes"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _members_of(db: AsyncSession, universe_id: int) -> list[str]:
        rows = await StockUniverseMembersRepository(db).find(
            universe_id=universe_id, order_by="symbol"
        )
        return [row.symbol for row in rows]

    async def _replace_members(
        db: AsyncSession, universe: models.StockUniversesRow, members: list[str]
    ) -> None:
        """Set the whole list. The Console sends the list it wants, not a diff.

        Every symbol must be curated on the Symbols page. A member that is not
        cannot be priced or sized, so a strategy drawing on this universe would
        skip it -- and the list would look complete while trading short.
        """
        wanted = []
        seen: set[str] = set()
        for raw in members:
            symbol = raw.strip().upper()
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            wanted.append(symbol)

        symbols = SymbolsRepository(db)
        unknown = [symbol for symbol in wanted if await symbols.get(symbol) is None]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"not curated on the Symbols page: {', '.join(sorted(unknown))}. "
                    "A universe may only name symbols the engine can price."
                ),
            )

        store = StockUniverseMembersRepository(db)
        await store.delete_where(universe_id=universe.universe_id)
        for symbol in wanted:
            store.add(
                models.StockUniverseMembersRow(
                    universe_id=universe.universe_id,
                    symbol=symbol,
                    exchange=universe.exchange,
                )
            )

    @router.get("")
    async def list_universes(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every universe, without members -- the list page shows headers."""
        rows = await StockUniversesRepository(db).all(order_by="name")
        return ok([_wire(row) for row in rows])

    @router.get("/active")
    async def list_active(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Declared before `/{universe_id}` so that path does not swallow it."""
        rows = await StockUniversesRepository(db).find(is_active=True, order_by="name")
        return ok([_wire(row) for row in rows])

    @router.get("/{universe_id}")
    async def one_universe(universe_id: int, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await StockUniversesRepository(db).get(universe_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no universe {universe_id}")
        return ok(_wire(row, await _members_of(db, universe_id)))

    @router.post("")
    async def create_universe(
        body: NewUniverse, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        kind = _checked_type(body.universeType)
        source = _checked_source(body.source, kind)
        exchange = (body.exchange or "NSE").strip().upper()
        if await ExchangesRepository(db).get(exchange) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {exchange!r}")

        universes = StockUniversesRepository(db)
        name = body.name.strip()
        if await universes.find_one(name=name) is not None:
            raise HTTPException(status_code=409, detail=f"a universe named {name!r} already exists")

        now = clock.now()
        row = models.StockUniversesRow(
            name=name,
            universe_type=kind,
            index_key=(body.indexKey or None),
            exchange=exchange,
            is_active=body.isActive if body.isActive is not None else True,
            source=source,
            created_at=now,
            updated_at=now,
        )
        universes.add(row)
        # Flushed so the generated id exists before the members reference it.
        await db.flush()
        if body.members is not None:
            await _replace_members(db, row, body.members)
        await db.commit()
        await db.refresh(row)
        return ok(_wire(row, await _members_of(db, row.universe_id)), message=f"{name} created")

    @router.put("/{universe_id}")
    async def update_universe(
        universe_id: int, body: UniverseEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        universes = StockUniversesRepository(db)
        row = await universes.get(universe_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no universe {universe_id}")

        sent = body.model_dump(exclude_unset=True)
        values: dict[str, Any] = {}
        if sent.get("name"):
            clash = await universes.find_one(name=sent["name"].strip())
            if clash is not None and clash.universe_id != universe_id:
                raise HTTPException(
                    status_code=409,
                    detail=f"a universe named {sent['name'].strip()!r} already exists",
                )
            values["name"] = sent["name"].strip()
        if "universeType" in sent:
            values["universe_type"] = _checked_type(sent["universeType"])
        if "indexKey" in sent:
            values["index_key"] = sent["indexKey"] or None
        if sent.get("exchange"):
            exchange = sent["exchange"].strip().upper()
            if await ExchangesRepository(db).get(exchange) is None:
                raise HTTPException(status_code=404, detail=f"no exchange {exchange!r}")
            values["exchange"] = exchange
        if "isActive" in sent:
            values["is_active"] = bool(sent["isActive"])
        if "source" in sent:
            values["source"] = _checked_source(
                sent["source"], values.get("universe_type", row.universe_type)
            )

        if values:
            values["updated_at"] = clock.now()
            await universes.update(universe_id, **values)

        if "members" in sent and sent["members"] is not None:
            await _replace_members(db, await universes.require(universe_id), sent["members"])
        await db.commit()
        saved = await universes.require(universe_id)
        return ok(_wire(saved, await _members_of(db, universe_id)), message=f"{saved.name} saved")

    @router.delete("/{universe_id}")
    async def delete_universe(
        universe_id: int, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        # The members go with it: they are keyed by universe and would
        # otherwise belong to nothing.
        await StockUniverseMembersRepository(db).delete_where(universe_id=universe_id)
        if not await StockUniversesRepository(db).delete(universe_id):
            raise HTTPException(status_code=404, detail=f"no universe {universe_id}")
        await db.commit()
        return ok(None, message=f"universe {universe_id} removed")

    return router
