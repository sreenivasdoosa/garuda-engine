"""Day allocation: what share of a strategy's lots to trade on each kind of day.

`STRATEGY_DAYS_ALLOCATION_CONFIG` in the reference engine, keyed there by
allocation model as well; models are out, so one row per strategy. A
percentage per weekday and per expiry proximity, 100 meaning full size and 0
meaning sit the day out. Expiry beats DT1 beats DT2 beats the weekday when a
day is more than one of them -- the reference's order, read for this.

No row means every day at 100%, so there is nothing to create before the
first edit: a PUT writes the row whether or not it exists.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    StrategyDaysAllocationRepository,
    StrategyDefinitionsRepository,
)

#: Column -> wire name, in the order the page shows them.
FIELDS: dict[str, str] = {
    "monday": "monday",
    "tuesday": "tuesday",
    "wednesday": "wednesday",
    "thursday": "thursday",
    "friday": "friday",
    "expiry_day": "expiryDay",
    "dt1_day": "dt1Day",
    "dt2_day": "dt2Day",
}
FULL_SIZE = 100


class DayAllocation(BaseModel):
    monday: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)
    tuesday: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)
    wednesday: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)
    thursday: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)
    friday: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)
    expiryDay: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)  # noqa: N815
    dt1Day: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)  # noqa: N815
    dt2Day: int = Field(default=FULL_SIZE, ge=0, le=FULL_SIZE)  # noqa: N815


def _wire(row: models.StrategyDaysAllocationRow) -> dict[str, Any]:
    out: dict[str, Any] = {"strategyName": row.strategy_name}
    for column, wire in FIELDS.items():
        out[wire] = getattr(row, column)
    return out


def _full_size(strategy: str) -> dict[str, Any]:
    return {"strategyName": strategy, **dict.fromkeys(FIELDS.values(), FULL_SIZE)}


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/strategy-days-allocation", tags=["strategy-days-allocation"])

    async def session() -> Any:
        async with sessions() as db:
            yield db

    @router.get("")
    async def list_allocations(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await StrategyDaysAllocationRepository(db).all(order_by="strategy_name")
        return ok([_wire(row) for row in rows], count=len(rows))

    @router.get("/{strategy}")
    async def allocation_of(strategy: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """The row, or full size on every day when there is none."""
        row = await StrategyDaysAllocationRepository(db).get(strategy)
        return ok(_wire(row) if row is not None else _full_size(strategy))

    @router.put("/{strategy}")
    async def set_allocation(
        strategy: str, body: DayAllocation, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        if await StrategyDefinitionsRepository(db).find_one(strategy_name=strategy) is None:
            raise HTTPException(status_code=404, detail=f"{strategy!r} is not a strategy")
        repository = StrategyDaysAllocationRepository(db)
        row = await repository.get(strategy)
        if row is None:
            row = models.StrategyDaysAllocationRow(strategy_name=strategy)
            repository.add(row)
        for column, wire in FIELDS.items():
            setattr(row, column, getattr(body, wire))
        await db.commit()
        return ok(
            _wire(await repository.require(strategy)), message=f"{strategy}: day allocation saved"
        )

    @router.delete("/{strategy}")
    async def clear_allocation(
        strategy: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        repository = StrategyDaysAllocationRepository(db)
        row = await repository.get(strategy)
        if row is None:
            raise HTTPException(status_code=404, detail=f"{strategy!r} has no day allocation")
        await repository.delete(strategy)
        await db.commit()
        return ok(None, message=f"{strategy}: trades full size every day")

    return router
