"""Strategy configuration: the layers the engine merges per column.

`STRATEGY_CONFIG_TREE` in the reference engine, with its user and broker
scopes dropped (`STRATEGY_ENGINE.md` §1). A strategy is configured at four
scopes -- base, day, tranche, tranche and day -- and the engine takes the
most specific non-null value **per column**, so a tranche row that sets
only the strike type still inherits the base row's stop. The page here
shows exactly that: the rows, and the effective configuration for a chosen
tranche and day with where each value came from.

**A null is "not set at this scope"**, never "set to nothing". The wire
carries nulls, the row stores nulls, and the resolver skips them; nothing
here can express "set to nothing", because the table cannot either.

**One row per scope.** The database's unique constraint cannot enforce it
-- a null scope is distinct from every other null in SQL -- so it is
checked here before every insert, and the Console asks `exists` while the
form is being filled, as the reference does.

Ported from the reference's servlet, read for this: the duplicate-scope
refusal, `max_tranches` kept base-only (dropped with a warning on a tranche
row, as the reference does), bulk delete by strategy refused, and a tranche
timing earlier than the definition's start time refused.

The engine reads a handful of these columns today -- the stop, target and
trailing family -- and the rest are stored for the parts not yet built. The
catalog says which is which, so the page can show it rather than let an
operator believe a setting took effect.
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import Boolean, Integer, Numeric
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.errors import DomainError
from garuda.engine.config import ConfigLayer, resolve
from garuda.engine.daycondition import DayCondition
from garuda.engine.vocabulary import CONFIG_CHOICES
from garuda.persistence import models
from garuda.persistence.repositories import (
    StrategyConfigRepository,
    StrategyDefinitionsRepository,
    StrategyIndicatorRulesRepository,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: Columns that are not settings. Everything else on the row is one.
NOT_A_SETTING = frozenset(
    {
        "id",
        "priority",
        "strategy_name",
        "tranch_number",
        "day_condition",
        "description",
        "created_at",
        "updated_at",
    }
)

#: Settings the engine reads today. The others are stored for the parts not
#: yet built, and the page says so.
READ_BY_ENGINE = frozenset(
    {
        "sl_percentage",
        "target_percentage",
        "combined_sl_percentage",
        "combined_target_percentage",
        "trail_sl",
        "trail_sl_type",
        "trail_config",
        "trail_sl_to_cost",
        "combined_trail_sl",
        "sl_trigger_to_limit_gap_percentage",
        "no_stop_loss",
        # The scheduled pipeline (`STRATEGY_ENGINE.md` §4).
        "strike_type",
        "strike_value",
        "lots_per_tranch",
        "max_tranches",
        "hedging_enabled",
        "hedge_strike_rounding_min_distance",
        "volume_filter",
        "oi_filter",
        "apply_volume_filter_to_hedge",
        "apply_oi_filter_to_hedge",
        "tranch_timing",
        "tranch_cutoff_time",
        "exit_mode",
        "exit_time",
        "exit_days",
        "order_fill_escalation_mode",
        "order_fill_escalation_seconds",
        "order_fill_escalation_steps",
    }
)

#: Meaningful only on the base row. The reference drops it from a tranche
#: row with a warning, so a phantom value cannot cap one tranche's count.
BASE_ONLY = frozenset({"max_tranches"})

#: How the page groups the settings. A column not listed lands in "Other".
GROUPS: dict[str, tuple[str, ...]] = {
    "Stop and target": (
        "sl_percentage",
        "target_percentage",
        "no_stop_loss",
        "combined_sl_percentage",
        "combined_target_percentage",
        "risk_calculation_mode",
        "sl_trigger_to_limit_gap_percentage",
        "sl_buffer_percentage",
    ),
    "Trailing": (
        "trail_sl",
        "trail_sl_type",
        "trail_config",
        "trail_sl_to_cost",
        "combined_trail_sl",
    ),
    "Strike selection": (
        "strike_type",
        "strike_value",
        "option_premium",
        "option_premium_upper",
        "use_atm_if_itm",
        "ignore_itm_strikes",
        "otm_levels",
        "oi_rank",
        "lookback_minutes",
        "volume_filter",
        "oi_filter",
        "apply_volume_filter_to_hedge",
        "apply_oi_filter_to_hedge",
        "hedge_strike_rounding_min_distance",
        "target_delta",
        "max_delta_deviation",
    ),
    "Sizing and tranches": (
        "lots_per_tranch",
        "max_tranches",
        "stop_after_loss_tranches",
        "stop_after_profit_tranches",
        "tranch_timing",
        "tranch_cutoff_time",
        "min_tranch_gap",
        "tranch_gap",
        "hedging_enabled",
        "directional",
    ),
    "Exit and re-entry": (
        "exit_mode",
        "exit_days",
        "exit_time",
        "re_entry",
        "max_reentries",
        "min_reentry_loss_percentage",
        "order_fill_escalation_mode",
        "order_fill_escalation_seconds",
        "order_fill_escalation_steps",
    ),
    "Breakout": (
        "breakout_enabled",
        "breakout_watch_type",
        "breakout_direction",
        "breakout_trigger_mode",
        "breakout_trigger_value",
        "breakout_select_fresh_strikes",
        "breakout_range_type",
        "breakout_range_start",
        "breakout_range_end",
        "breakout_range_lookback",
        "breakout_on_high_break",
        "breakout_on_low_break",
        "breakout_reversal_mode",
    ),
}

#: The vocabulary, per `STRATEGY_ENGINE.md` §1. Offered as choices; anything
#: else is refused by name.
CHOICES: dict[str, tuple[str, ...]] = dict(CONFIG_CHOICES)


def _camel(column: str) -> str:
    head, *rest = column.split("_")
    return head + "".join(part.title() for part in rest)


_COLUMNS = {
    column.name: column
    for column in models.StrategyConfigRow.__table__.columns
    if column.name not in NOT_A_SETTING
}
_WIRE_TO_COLUMN = {_camel(name): name for name in _COLUMNS}


def _kind(column: Any) -> str:
    if isinstance(column.type, Boolean):
        return "boolean"
    if isinstance(column.type, Integer):
        return "integer"
    if isinstance(column.type, Numeric):
        return "decimal"
    return "text"


def _plain(value: Any) -> Any:
    return float(value) if isinstance(value, Decimal) else value


def row_wire(row: models.StrategyConfigRow) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": row.id,
        "strategyName": row.strategy_name,
        "tranchNumber": row.tranch_number,
        "dayCondition": row.day_condition,
        "priority": row.priority,
        "scope": _scope_label(row.tranch_number, row.day_condition),
        "description": row.description,
        "createdAt": row.created_at.isoformat() if row.created_at else None,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }
    for name in _COLUMNS:
        out[_camel(name)] = _plain(getattr(row, name))
    out["setFields"] = sorted(_camel(n) for n in _COLUMNS if getattr(row, n) is not None)
    return out


def _scope_label(tranche: int | None, day: str | None) -> str:
    if tranche is None and day is None:
        return "base"
    if tranche is not None and day is None:
        return f"tranche {tranche}"
    if tranche is None:
        return f"day {day}"
    return f"tranche {tranche} on {day}"


def catalog() -> dict[str, Any]:
    grouped = {name for names in GROUPS.values() for name in names}
    groups = [
        {
            "name": title,
            "fields": [_camel(n) for n in names if n in _COLUMNS],
        }
        for title, names in GROUPS.items()
    ]
    rest = [_camel(n) for n in _COLUMNS if n not in grouped]
    if rest:
        groups.append({"name": "Other", "fields": sorted(rest)})
    return {
        "fields": {
            _camel(name): {
                "column": name,
                "kind": _kind(column),
                "readByEngine": name in READ_BY_ENGINE,
                "baseOnly": name in BASE_ONLY,
                "choices": list(CHOICES.get(name, ())),
            }
            for name, column in _COLUMNS.items()
        },
        "groups": groups,
        "dayConditions": [
            {"code": member.value, "name": member.name.replace("_", " ").lower()}
            for member in DayCondition
        ],
    }


def layer_of(row: models.StrategyConfigRow) -> ConfigLayer:
    """One row, reduced to the fields it sets. The loader's own reduction."""
    values = {name: getattr(row, name) for name in _COLUMNS if getattr(row, name) is not None}
    return ConfigLayer(
        values=values,
        tranche=row.tranch_number,
        day_condition=DayCondition.parse(row.day_condition) if row.day_condition else None,
    )


class ConfigEdit(BaseModel):
    """Any setting, by its wire name. Absent leaves it; null clears it."""

    model_config = {"extra": "allow"}

    description: str | None = None


class NewConfig(ConfigEdit):
    strategyName: str  # noqa: N815 -- the Console's names
    tranchNumber: int | None = None  # noqa: N815
    dayCondition: str | None = None  # noqa: N815


def _day_condition(value: str | None) -> str | None:
    code = (value or "").strip().upper()
    if not code:
        return None
    try:
        return DayCondition.parse(code).value
    except (DomainError, ValueError, KeyError):
        raise HTTPException(
            status_code=400,
            detail=f"{value!r} is not a day condition; one of "
            + ", ".join(m.value for m in DayCondition),
        ) from None


def _coerce(name: str, value: Any) -> Any:
    column = _COLUMNS[name]
    wire = _camel(name)
    if value is None or value == "":
        return None
    kind = _kind(column)
    try:
        if kind == "boolean":
            if isinstance(value, str):
                return value.strip().lower() in ("true", "1", "yes", "on")
            return bool(value)
        if kind == "integer":
            number = int(value)
            if (
                name
                in (
                    "lots_per_tranch",
                    "max_tranches",
                    "stop_after_loss_tranches",
                    "stop_after_profit_tranches",
                    "breakout_range_lookback",
                )
                and number < 0
            ):
                raise HTTPException(status_code=400, detail=f"{wire} cannot be negative")
            return number
        if kind == "decimal":
            parsed = Decimal(str(value))
            if name.endswith("_percentage") and parsed < 0:
                raise HTTPException(status_code=400, detail=f"{wire} cannot be negative")
            return parsed
    except (ValueError, TypeError, InvalidOperation):
        raise HTTPException(status_code=400, detail=f"{wire}: {value!r} is not a number") from None
    text = str(value).strip()
    if name in CHOICES and text not in CHOICES[name]:
        raise HTTPException(
            status_code=400,
            detail=f"{wire}: {text!r} is not one of {', '.join(CHOICES[name])}",
        )
    return text or None


def _clock_time(value: str) -> dt.time | None:
    try:
        return dt.time.fromisoformat(value.strip())
    except ValueError:
        return None


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/strategy-config-tree", tags=["strategy-config"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _reload(request: Request) -> None:
        reload = getattr(request.app.state, "reload_strategies", None)
        if reload is None:
            return
        try:
            await reload()
        except Exception:
            logger.exception("the engine could not re-read its strategies")

    async def _row(db: AsyncSession, config_id: int) -> models.StrategyConfigRow:
        row = await StrategyConfigRepository(db).get(config_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"config {config_id} does not exist")
        return row

    async def _definition(db: AsyncSession, name: str) -> models.StrategyDefinitionsRow:
        found = await StrategyDefinitionsRepository(db).find_one(strategy_name=name)
        if found is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a strategy")
        return found

    async def _same_scope(
        db: AsyncSession, name: str, tranche: int | None, day: str | None
    ) -> models.StrategyConfigRow | None:
        for row in await StrategyConfigRepository(db).find(strategy_name=name):
            if row.tranch_number == tranche and row.day_condition == day:
                return row
        return None

    def _apply(row: models.StrategyConfigRow, body: ConfigEdit) -> None:
        given = body.model_dump(exclude_unset=True)
        for wire, value in given.items():
            if wire in ("strategyName", "tranchNumber", "dayCondition", "id", "priority", "scope"):
                continue
            if wire == "description":
                row.description = (value or "").strip() or None
                continue
            if wire in ("setFields", "createdAt", "updatedAt"):
                continue
            name = _WIRE_TO_COLUMN.get(wire)
            if name is None:
                raise HTTPException(
                    status_code=400, detail=f"{wire!r} is not a strategy configuration field"
                )
            setattr(row, name, _coerce(name, value))
        # The reference's rule: meaningful only at the base scope; dropped
        # from a tranche row with a warning rather than left to cap one.
        if row.tranch_number not in (None, 0):
            for name in BASE_ONLY:
                if getattr(row, name) is not None:
                    logger.warning(
                        "dropping %s on a tranche row: %s tranche %s",
                        name,
                        row.strategy_name,
                        row.tranch_number,
                    )
                    setattr(row, name, None)

    def _refuse_timing_before_start(
        row: models.StrategyConfigRow, definition: models.StrategyDefinitionsRow
    ) -> None:
        if not row.tranch_timing or not definition.start_time:
            return
        timing = _clock_time(row.tranch_timing)
        start = _clock_time(definition.start_time)
        if timing is None or start is None:
            return
        if timing < start:
            label = f"tranche {row.tranch_number}" if row.tranch_number is not None else "tranche"
            raise HTTPException(
                status_code=400,
                detail=f"{label} timing {row.tranch_timing} is earlier than "
                f"{definition.strategy_name}'s start time {definition.start_time}",
            )

    async def _refuse_if_unloadable(
        request: Request, db: AsyncSession, definition: models.StrategyDefinitionsRow
    ) -> None:
        validate = getattr(request.app.state, "validate_strategy", None)
        if not callable(validate) or (definition.status or "").upper() not in (
            "ACTIVE",
            "WIND_DOWN",
        ):
            return
        configs = await StrategyConfigRepository(db).find(strategy_name=definition.strategy_name)
        rules = await StrategyIndicatorRulesRepository(db).find_one(
            strategy_name=definition.strategy_name
        )
        why = validate(definition, configs, rules)
        if why is not None:
            raise HTTPException(status_code=400, detail=f"the engine would refuse it: {why}")

    # -- reading --------------------------------------------------------------

    @router.get("/catalog")
    async def the_catalog() -> dict[str, Any]:
        return ok(catalog())

    @router.get("/day-conditions")
    async def day_conditions() -> dict[str, Any]:
        return ok(catalog()["dayConditions"])

    @router.get("/strategy-names")
    async def strategy_names(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every strategy, with how many rows configure it."""
        definitions = await StrategyDefinitionsRepository(db).all(order_by="strategy_name")
        counts: dict[str, int] = {}
        for row in await StrategyConfigRepository(db).all():
            counts[row.strategy_name] = counts.get(row.strategy_name, 0) + 1
        return ok(
            [
                {
                    "strategyName": d.strategy_name,
                    "displayName": d.display_name,
                    "status": d.status,
                    "startTime": d.start_time,
                    "rows": counts.get(d.strategy_name, 0),
                }
                for d in definitions
            ]
        )

    @router.get("/base")
    async def base_rows(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = [
            r
            for r in await StrategyConfigRepository(db).all(order_by="strategy_name")
            if r.tranch_number is None and r.day_condition is None
        ]
        return ok([row_wire(r) for r in rows], count=len(rows))

    @router.get("/exists")
    async def exists(
        db: AsyncSession = Depends(session),
        strategyName: str = Query(...),  # noqa: N803 -- the Console's names
        tranchNumber: int | None = Query(default=None),  # noqa: N803
        dayCondition: str | None = Query(default=None),  # noqa: N803
    ) -> dict[str, Any]:
        found = await _same_scope(
            db, strategyName.strip(), tranchNumber, _day_condition(dayCondition)
        )
        return ok({"exists": found is not None, "id": found.id if found else None})

    @router.get("/effective")
    async def effective(
        db: AsyncSession = Depends(session),
        strategyName: str = Query(...),  # noqa: N803
        tranchNumber: int = Query(default=0),  # noqa: N803
        dayCondition: str | None = Query(default=None),  # noqa: N803
    ) -> dict[str, Any]:
        """What the engine would use for one tranche on one kind of day.

        Merged per column exactly as the engine merges it, with where each
        value came from -- which is the question an operator has when a stop
        is not the one they expected.
        """
        name = strategyName.strip()
        await _definition(db, name)
        rows = await StrategyConfigRepository(db).find(strategy_name=name)
        conditions = frozenset(
            DayCondition.parse(code)
            for code in (c.strip().upper() for c in (dayCondition or "").split(","))
            if code
        )
        try:
            built = [layer_of(r) for r in rows]
            resolved = resolve(name, built, tranche=tranchNumber, conditions=conditions)
        except DomainError as error:
            raise HTTPException(status_code=400, detail=str(error)) from None
        sources: dict[str, Any] = {}
        for layer in resolved.layers:
            for field in layer.values:
                wire = _camel(field)
                if wire not in sources:
                    sources[wire] = {
                        "tranchNumber": layer.tranche,
                        "dayCondition": layer.day_condition.value if layer.day_condition else None,
                        "priority": layer.priority,
                        "scope": _scope_label(
                            layer.tranche,
                            layer.day_condition.value if layer.day_condition else None,
                        ),
                    }
        return ok(
            {
                "strategyName": name,
                "tranchNumber": tranchNumber,
                "dayConditions": sorted(c.value for c in conditions),
                "values": {_camel(k): _plain(v) for k, v in resolved.values.items()},
                "sources": sources,
                "layersInScope": len(resolved.layers),
            }
        )

    @router.get("")
    async def list_rows(
        db: AsyncSession = Depends(session),
        strategyName: str | None = Query(default=None),  # noqa: N803
    ) -> dict[str, Any]:
        rows = await StrategyConfigRepository(db).all()
        if strategyName:
            rows = [r for r in rows if r.strategy_name == strategyName.strip()]
        ordered = sorted(
            rows,
            key=lambda r: (
                r.strategy_name,
                r.priority,
                r.tranch_number or -1,
                r.day_condition or "",
            ),
        )
        return ok([row_wire(r) for r in ordered], count=len(ordered))

    @router.get("/strategy/{name}")
    async def for_strategy(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await StrategyConfigRepository(db).find(strategy_name=name)
        ordered = sorted(
            rows, key=lambda r: (r.priority, r.tranch_number or -1, r.day_condition or "")
        )
        return ok([row_wire(r) for r in ordered], count=len(ordered))

    @router.get("/{config_id}")
    async def get_row(config_id: int, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        return ok(row_wire(await _row(db, config_id)))

    # -- writing --------------------------------------------------------------

    @router.post("", status_code=201)
    async def create_row(
        body: NewConfig, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        name = body.strategyName.strip()
        definition = await _definition(db, name)
        tranche = body.tranchNumber
        if tranche is not None and tranche < 0:
            raise HTTPException(status_code=400, detail="tranchNumber cannot be negative")
        day = _day_condition(body.dayCondition)
        if await _same_scope(db, name, tranche, day) is not None:
            raise HTTPException(
                status_code=409,
                detail=f"{name} already has a {_scope_label(tranche, day)} row; edit that one",
            )
        now = clock.now()
        row = models.StrategyConfigRow(
            strategy_name=name,
            tranch_number=tranche,
            day_condition=day,
            created_at=now,
            updated_at=now,
        )
        _apply(row, body)
        _refuse_timing_before_start(row, definition)
        StrategyConfigRepository(db).add(row)
        await db.flush()
        await _refuse_if_unloadable(request, db, definition)
        await db.commit()
        await db.refresh(row)
        await _reload(request)
        logger.info("%s configured: %s row added", name, _scope_label(tranche, day))
        return ok(row_wire(row), message=f"{name}: {_scope_label(tranche, day)} row added")

    @router.put("/{config_id}")
    async def update_row(
        config_id: int, body: ConfigEdit, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """The scope is fixed; the settings change. A different scope is a new row."""
        row = await _row(db, config_id)
        definition = await _definition(db, row.strategy_name)
        _apply(row, body)
        row.updated_at = clock.now()
        _refuse_timing_before_start(row, definition)
        await db.flush()
        await _refuse_if_unloadable(request, db, definition)
        await db.commit()
        await db.refresh(row)
        await _reload(request)
        return ok(row_wire(row), message=f"{row.strategy_name}: {row_wire(row)['scope']} row saved")

    @router.delete("/strategy/{name}")
    async def delete_all(name: str) -> dict[str, Any]:
        raise HTTPException(
            status_code=400,
            detail=f"removing every row of {name} at once is not supported; delete rows one "
            "by one, so the base row goes last and on purpose",
        )

    @router.delete("/{config_id}")
    async def delete_row(
        config_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _row(db, config_id)
        label = row_wire(row)["scope"]
        name = row.strategy_name
        await StrategyConfigRepository(db).delete(config_id)
        await db.commit()
        await _reload(request)
        logger.info("%s: %s row removed", name, label)
        return ok(None, message=f"{name}: {label} row removed")

    return router
