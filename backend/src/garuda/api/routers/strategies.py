"""Strategies: what to trade, under which rules, on whose account.

Three tables, three resources:

* **definitions** -- `STRATEGY_DEFINITIONS` in the reference -- say what a
  strategy is: its underlying, its product, its legs. Legs live in the
  definition's combo column as a list of selector specs; a single-leg
  strategy is a combo with one leg.
* **rules** -- the reference's `STRATEGY_INDICATOR_RULES` -- say when it
  enters, which way, and when it leaves. The Console's rule builder writes
  the reference's tree shape and the engine reads it as it is.
* **subscriptions** -- `USER_STRATEGY_SUBSCRIPTIONS`, with the user half
  removed -- say which trading client runs it, with how much capital, live
  or paper.

**A strategy the engine would refuse is refused here.** Every write to a
definition or its rules is first built the way the engine builds it at
startup, and a refusal -- a leg that names no selector, a rule tree the
registry does not know -- comes back as the save's error rather than as a
line in tomorrow's log saying the strategy was left out.

**A write reaches the running engine.** The composition root re-reads the
tables into the strategy loop after each one, so a subscription made at ten
is swept at ten.

Not ported: templates (garuda composes from a spec; `SCOPE_DECISIONS.md`
§5a), `USERNAME`, `IS_PUBLIC`, `SCOPE` and `IS_MOCK` on the definition, and
`BROKER_NAME` on the subscription -- the trading client already names its
broker.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from collections.abc import Callable, Sequence
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.enums import OptionType, OrderType, ProductType
from garuda.domain.intent import LegRole
from garuda.engine.direction import registered as direction_rules_registered
from garuda.engine.rules.registry import registered as rules_registered
from garuda.engine.selectors import registered as selectors_registered
from garuda.engine.spec import SideRule
from garuda.persistence import models
from garuda.persistence.repositories import (
    StrategyConfigRepository,
    StrategyDefinitionsRepository,
    StrategyIndicatorRulesRepository,
    SubscriptionsRepository,
    TradingClientsRepository,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

STATUSES = ("ACTIVE", "INACTIVE", "WIND_DOWN")
PRODUCTS = ("INTRADAY", "POSITIONAL", "CASHBUY", "MTF")
EXPIRY_TYPES = ("WEEKLY", "MONTHLY")

#: Builds a strategy the way the engine does and answers why it would be
#: refused, or None. Supplied by the composition root, which owns the loader;
#: this layer may not import it.
type StrategyValidator = Callable[
    [models.StrategyDefinitionsRow, Sequence[models.StrategyConfigRow], Any], str | None
]


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _num(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _parsed(raw: str | None) -> Any:
    if not raw or not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


#: Column -> wire name, for every definition column the page edits. Written
#: once; read and write both use it.
_DEFINITION_COLUMNS: dict[str, str] = {
    "display_name": "displayName",
    "display_order": "displayOrder",
    "underlying_symbol": "underlyingSymbol",
    "exchange": "exchange",
    "product": "product",
    "tick_trigger_enabled": "tickTriggerEnabled",
    "scheduled_trigger_enabled": "scheduledTriggerEnabled",
    "signal_trigger_enabled": "signalTriggerEnabled",
    "periodic_trigger_enabled": "periodicTriggerEnabled",
    "start_time": "startTime",
    "stop_time": "stopTime",
    "tradable_days": "tradableDays",
    "excluded_days": "excludedDays",
    "capital_per_lot": "capitalPerLot",
    "capital_per_lot_hedged": "capitalPerLotHedged",
    "capital_per_lot_naked": "capitalPerLotNaked",
    "is_overlap_capital": "isOverlapCapital",
    "expiry_type": "expiryType",
    "exclude_monthly_expiry": "excludeMonthlyExpiry",
    "use_premium_balancing": "usePremiumBalancing",
    "underlying_type": "underlyingType",
    "hedge_distance_percentage_intraday": "hedgeDistancePercentageIntraday",
    "hedge_distance_percentage_positional": "hedgeDistancePercentagePositional",
    "is_directional": "isDirectional",
    "direction_provider_type": "directionProviderType",
    "direction_provider_params": "directionProviderParams",
    "status": "status",
    "catch_up_missed_tranches": "catchUpMissedTranches",
    "adaptive_tranches_enabled": "adaptiveTranchesEnabled",
    "periodic_interval_minutes": "periodicIntervalMinutes",
    "periodic_offset_seconds": "periodicOffsetSeconds",
    "hedge_replace_enabled": "hedgeReplaceEnabled",
    "hedge_morning_start_offset": "hedgeMorningStartOffset",
    "hedge_morning_end_offset": "hedgeMorningEndOffset",
    "hedge_evening_start_offset": "hedgeEveningStartOffset",
    "hedge_evening_end_offset": "hedgeEveningEndOffset",
    "risk_percentage": "riskPercentage",
    "absolute_max_risk": "absoluteMaxRisk",
    "min_risk_percentage": "minRiskPercentage",
    "max_risk_percentage": "maxRiskPercentage",
    "leverage": "leverage",
    "min_leverage": "minLeverage",
    "max_leverage": "maxLeverage",
    "universe_id": "universeId",
    "equity_sizing_model": "equitySizingModel",
    "fixed_amount_per_stock": "fixedAmountPerStock",
    "max_active_positions": "maxActivePositions",
    "max_risk_pct_per_trade": "maxRiskPctPerTrade",
    "on_index_removal": "onIndexRemoval",
    "combo_spec_json": "comboSpecJson",
    "entry_leg_order": "entryLegOrder",
    "exit_leg_order": "exitLegOrder",
}
_WIRE_TO_COLUMN = {wire: column for column, wire in _DEFINITION_COLUMNS.items()}

#: Columns that hold a number with a fraction; everything else numeric is an int.
_DECIMAL_COLUMNS = frozenset(
    {
        "hedge_distance_percentage_intraday",
        "hedge_distance_percentage_positional",
        "risk_percentage",
        "absolute_max_risk",
        "min_risk_percentage",
        "max_risk_percentage",
        "leverage",
        "min_leverage",
        "max_leverage",
        "fixed_amount_per_stock",
        "max_risk_pct_per_trade",
    }
)
#: Columns the row declares NOT NULL as booleans.
_REQUIRED_BOOLEANS = frozenset(
    {
        "exclude_monthly_expiry",
        "use_premium_balancing",
        "catch_up_missed_tranches",
        "adaptive_tranches_enabled",
    }
)


def definition_wire(
    row: models.StrategyDefinitionsRow, *, subscriptions: int | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {"strategyId": row.strategy_id, "strategyName": row.strategy_name}
    for column, wire in _DEFINITION_COLUMNS.items():
        value = getattr(row, column)
        out[wire] = float(value) if isinstance(value, Decimal) else value
    out["legs"] = _legs_of(row.combo_spec_json)
    out["tradeMode"] = row.trade_mode
    out["createdAt"] = _iso(row.created_at)
    out["updatedAt"] = _iso(row.updated_at)
    if subscriptions is not None:
        out["subscriptions"] = subscriptions
    return out


def _legs_of(raw: str | None) -> list[Any]:
    parsed = _parsed(raw)
    if isinstance(parsed, dict):
        legs = parsed.get("legs")
        return list(legs) if isinstance(legs, list) else []
    return list(parsed) if isinstance(parsed, list) else []


def rules_wire(strategy: str, row: models.StrategyIndicatorRulesRow | None) -> dict[str, Any]:
    return {
        "strategyName": strategy,
        "entryRulesJson": row.entry_rules_json if row else None,
        "directionRulesJson": row.direction_rules_json if row else None,
        "exitRulesJson": row.exit_rules_json if row else None,
        "entryRules": _parsed(row.entry_rules_json) if row else None,
        "directionRules": _parsed(row.direction_rules_json) if row else None,
        "exitRules": _parsed(row.exit_rules_json) if row else None,
        "useIndicatorExit": bool(row.use_indicator_exit) if row else False,
    }


def subscription_wire(
    row: models.SubscriptionsRow, display_name: str | None = None
) -> dict[str, Any]:
    return {
        "subscriptionId": row.subscription_id,
        "tradingClientId": row.trading_client_id,
        "displayName": display_name or row.trading_client_id,
        "strategyName": row.strategy_name,
        "isActive": bool(row.is_active),
        "capital": _num(row.capital),
        "riskPercentage": _num(row.risk_percentage),
        "absoluteMaxRisk": _num(row.absolute_max_risk),
        "leverage": _num(row.leverage),
        "maxActivePositions": row.max_active_positions,
        "isPaperTrading": bool(row.is_paper_trading),
        "activatedAt": _iso(row.activated_at),
        "deactivatedAt": _iso(row.deactivated_at),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


class DefinitionEdit(BaseModel):
    """Every column the page edits, optional. `legs` is the combo as objects."""

    model_config = {"extra": "allow"}

    strategyName: str | None = Field(default=None, max_length=100)  # noqa: N815
    legs: list[dict[str, Any]] | None = None


class NewDefinition(DefinitionEdit):
    strategyName: str = Field(min_length=1, max_length=100)  # noqa: N815
    underlyingSymbol: str = Field(min_length=1, max_length=50)  # noqa: N815
    exchange: str = Field(min_length=1, max_length=20)


class RulesEdit(BaseModel):
    entryRules: Any = None  # noqa: N815
    directionRules: Any = None  # noqa: N815
    exitRules: Any = None  # noqa: N815
    entryRulesJson: str | None = None  # noqa: N815
    directionRulesJson: str | None = None  # noqa: N815
    exitRulesJson: str | None = None  # noqa: N815
    useIndicatorExit: bool | None = None  # noqa: N815


class SubscriptionEdit(BaseModel):
    capital: float | None = None
    riskPercentage: float | None = None  # noqa: N815
    absoluteMaxRisk: float | None = None  # noqa: N815
    leverage: float | None = None
    maxActivePositions: int | None = None  # noqa: N815
    isActive: bool | None = None  # noqa: N815
    isPaperTrading: bool | None = None  # noqa: N815


class NewSubscription(SubscriptionEdit):
    tradingClientId: str = Field(min_length=1)  # noqa: N815
    strategyName: str = Field(min_length=1)  # noqa: N815


def _decimal(value: Any, field: str) -> Decimal | None:
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not a number") from None


def _json_text(value: Any, field: str) -> str | None:
    """Rules as text, from text or from the builder's object."""
    if value is None:
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            json.loads(text)
        except json.JSONDecodeError as error:
            raise HTTPException(
                status_code=400, detail=f"{field} is not readable JSON ({error})"
            ) from None
        return text
    return json.dumps(value)


def catalog() -> dict[str, Any]:
    """What a leg, a rule and a direction can be, for the form.

    Read from the registries, so a selector or rule added in code shows up
    here without this file knowing. The fields each takes are listed from
    the selectors' own dataclasses where they have one.
    """

    def fields_of(registration: Any) -> list[str]:
        built = getattr(registration, "cls", None) or getattr(registration, "factory", None)
        names = getattr(built, "__dataclass_fields__", None)
        return sorted(names) if names else []

    return {
        "selectors": [
            {"type": name, "fields": fields_of(entry)}
            for name, entry in sorted(selectors_registered().items())
        ],
        "rules": sorted(rules_registered()),
        "directionRules": sorted(direction_rules_registered()),
        "sideRules": [member.value for member in SideRule],
        "legRoles": [member.value for member in LegRole],
        "products": [member.value for member in ProductType],
        "definitionProducts": list(PRODUCTS),
        "orderTypes": [member.value for member in OrderType],
        "optionTypes": [member.value for member in OptionType],
        "expiryTypes": list(EXPIRY_TYPES),
        "statuses": list(STATUSES),
    }


def build(
    sessions: async_sessionmaker[AsyncSession],
    clock: Clock,
) -> APIRouter:
    router = APIRouter(prefix="/api/engine", tags=["strategies"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _reload(request: Request) -> None:
        """Tell the running engine. Never raises: the rows are already saved."""
        reload = getattr(request.app.state, "reload_strategies", None)
        if reload is None:
            return
        try:
            await reload()
        except Exception:
            logger.exception("the engine could not re-read its strategies")

    def _validator(request: Request) -> StrategyValidator | None:
        found = getattr(request.app.state, "validate_strategy", None)
        return found if callable(found) else None

    async def _refuse_if_unloadable(
        request: Request, db: AsyncSession, row: models.StrategyDefinitionsRow
    ) -> None:
        """Build it the way the engine will; refuse now rather than at startup."""
        validate = _validator(request)
        if validate is None or (row.status or "").upper() not in ("ACTIVE", "WIND_DOWN"):
            return
        configs = await StrategyConfigRepository(db).find(strategy_name=row.strategy_name)
        rules = await StrategyIndicatorRulesRepository(db).find_one(strategy_name=row.strategy_name)
        why = validate(row, configs, rules)
        if why is not None:
            raise HTTPException(status_code=400, detail=f"the engine would refuse it: {why}")

    async def _definition(db: AsyncSession, strategy_id: int) -> models.StrategyDefinitionsRow:
        row = await StrategyDefinitionsRepository(db).get(strategy_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"strategy {strategy_id} does not exist")
        return row

    def _apply_definition(row: models.StrategyDefinitionsRow, body: DefinitionEdit) -> None:
        given = body.model_dump(exclude_unset=True)
        legs = given.pop("legs", None)
        given.pop("strategyName", None)
        if legs is not None:
            if not legs:
                raise HTTPException(status_code=400, detail="a strategy needs at least one leg")
            row.combo_spec_json = json.dumps({"legs": legs})
            given.pop("comboSpecJson", None)
        for wire, value in given.items():
            column = _WIRE_TO_COLUMN.get(wire)
            if column is None:
                if wire in {"tradeMode", "templateName", "createdAt", "updatedAt", "subscriptions"}:
                    continue
                raise HTTPException(
                    status_code=400, detail=f"{wire!r} is not a field of a strategy definition"
                )
            if column == "status":
                status = (value or "").strip().upper()
                if status not in STATUSES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"status {value!r} is not one of {', '.join(STATUSES)}",
                    )
                row.status = status
            elif column == "product":
                product = (value or "").strip().upper()
                if product not in PRODUCTS:
                    raise HTTPException(
                        status_code=400,
                        detail=f"product {value!r} is not one of {', '.join(PRODUCTS)}",
                    )
                row.product = product
            elif column == "expiry_type":
                kind = (value or "").strip().upper() or None
                if kind is not None and kind not in EXPIRY_TYPES:
                    raise HTTPException(
                        status_code=400,
                        detail=f"expiryType {value!r} is not one of {', '.join(EXPIRY_TYPES)}",
                    )
                row.expiry_type = kind
            elif column in ("underlying_symbol", "exchange"):
                text = (value or "").strip().upper()
                if not text:
                    raise HTTPException(status_code=400, detail=f"{wire} is required")
                setattr(row, column, text)
            elif column in _DECIMAL_COLUMNS:
                setattr(row, column, _decimal(value, wire))
            elif column in _REQUIRED_BOOLEANS:
                setattr(row, column, bool(value))
            elif column == "combo_spec_json":
                text = _json_text(value, wire)
                if text is None:
                    raise HTTPException(status_code=400, detail="a strategy needs its legs")
                row.combo_spec_json = text
            else:
                setattr(row, column, value)

    # -- definitions ----------------------------------------------------------

    @router.get("/catalog")
    async def the_catalog() -> dict[str, Any]:
        return ok(catalog())

    @router.get("/definitions")
    async def list_definitions(
        db: AsyncSession = Depends(session),
        status: str | None = Query(default=None),
        symbol: str | None = Query(default=None),
        exchange: str | None = Query(default=None),
    ) -> dict[str, Any]:
        rows = await StrategyDefinitionsRepository(db).all(order_by="strategy_name")
        if status:
            rows = [r for r in rows if (r.status or "").upper() == status.strip().upper()]
        if symbol:
            rows = [r for r in rows if r.underlying_symbol.upper() == symbol.strip().upper()]
        if exchange:
            rows = [r for r in rows if r.exchange.upper() == exchange.strip().upper()]
        counts: dict[str, int] = {}
        for sub in await SubscriptionsRepository(db).all():
            counts[sub.strategy_name] = counts.get(sub.strategy_name, 0) + 1
        return ok(
            [definition_wire(r, subscriptions=counts.get(r.strategy_name, 0)) for r in rows],
            count=len(rows),
        )

    @router.get("/definitions/active")
    async def active_definitions(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = [
            r
            for r in await StrategyDefinitionsRepository(db).all(order_by="strategy_name")
            if (r.status or "").upper() == "ACTIVE"
        ]
        return ok([definition_wire(r) for r in rows], count=len(rows))

    @router.get("/definitions/name/{name}")
    async def by_name(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await StrategyDefinitionsRepository(db).find_one(strategy_name=name)
        if row is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a strategy")
        return ok(definition_wire(row))

    @router.get("/definitions/{strategy_id}")
    async def get_definition(
        strategy_id: int, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        return ok(definition_wire(await _definition(db, strategy_id)))

    @router.post("/definitions", status_code=201)
    async def create_definition(
        body: NewDefinition, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        repository = StrategyDefinitionsRepository(db)
        name = body.strategyName.strip()
        if await repository.find_one(strategy_name=name) is not None:
            raise HTTPException(status_code=409, detail=f"{name!r} is already a strategy")
        now = clock.now()
        row = models.StrategyDefinitionsRow(
            strategy_name=name,
            underlying_symbol=body.underlyingSymbol.strip().upper(),
            exchange=body.exchange.strip().upper(),
            product="INTRADAY",
            trade_mode="SPEC",
            status="INACTIVE",
            exclude_monthly_expiry=False,
            use_premium_balancing=True,
            catch_up_missed_tranches=True,
            adaptive_tranches_enabled=False,
            scheduled_trigger_enabled=True,
            created_at=now,
            updated_at=now,
        )
        _apply_definition(row, body)
        _refuse_bad_window(row)
        await _refuse_if_unloadable(request, db, row)
        repository.add(row)
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise HTTPException(status_code=409, detail=str(error.orig)) from None
        await _reload(request)
        logger.info("strategy defined: %s (%s)", row.strategy_name, row.status)
        return ok(definition_wire(row, subscriptions=0), message=f"{row.strategy_name} saved")

    @router.put("/definitions/{strategy_id}")
    async def update_definition(
        strategy_id: int,
        body: DefinitionEdit,
        request: Request,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        row = await _definition(db, strategy_id)
        _apply_definition(row, body)
        row.updated_at = clock.now()
        _refuse_bad_window(row)
        await _refuse_if_unloadable(request, db, row)
        await db.commit()
        await _reload(request)
        return ok(definition_wire(row), message=f"{row.strategy_name} saved")

    @router.put("/definitions/{strategy_id}/status/{status}")
    async def change_status(
        strategy_id: int, status: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _definition(db, strategy_id)
        wanted = status.strip().upper()
        if wanted not in STATUSES:
            raise HTTPException(
                status_code=400, detail=f"status {status!r} is not one of {', '.join(STATUSES)}"
            )
        row.status = wanted
        row.updated_at = clock.now()
        await _refuse_if_unloadable(request, db, row)
        await db.commit()
        await _reload(request)
        logger.info("strategy %s is now %s", row.strategy_name, wanted)
        return ok(definition_wire(row), message=f"{row.strategy_name} is {wanted}")

    @router.delete("/definitions/{strategy_id}")
    async def delete_definition(
        strategy_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _definition(db, strategy_id)
        subscribed = await SubscriptionsRepository(db).for_strategy(row.strategy_name)
        if subscribed:
            raise HTTPException(
                status_code=409,
                detail=f"{row.strategy_name} has {len(subscribed)} subscription(s); "
                "remove them first",
            )
        await StrategyIndicatorRulesRepository(db).delete_where(strategy_name=row.strategy_name)
        await StrategyConfigRepository(db).delete_where(strategy_name=row.strategy_name)
        await StrategyDefinitionsRepository(db).delete(strategy_id)
        await db.commit()
        await _reload(request)
        logger.info("strategy deleted: %s", row.strategy_name)
        return ok(None, message=f"{row.strategy_name} removed")

    # -- rules ----------------------------------------------------------------

    @router.get("/indicator-rules/{name}")
    async def get_rules(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        if await StrategyDefinitionsRepository(db).find_one(strategy_name=name) is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a strategy")
        row = await StrategyIndicatorRulesRepository(db).find_one(strategy_name=name)
        return ok(rules_wire(name, row))

    @router.put("/indicator-rules/{name}")
    async def put_rules(
        name: str, body: RulesEdit, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        definition = await StrategyDefinitionsRepository(db).find_one(strategy_name=name)
        if definition is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a strategy")
        repository = StrategyIndicatorRulesRepository(db)
        row = await repository.find_one(strategy_name=name)
        now = clock.now()
        if row is None:
            row = models.StrategyIndicatorRulesRow(
                strategy_name=name, use_indicator_exit=False, created_at=now
            )
            repository.add(row)
        given = body.model_dump(exclude_unset=True)
        for text_field, object_field, column in (
            ("entryRulesJson", "entryRules", "entry_rules_json"),
            ("directionRulesJson", "directionRules", "direction_rules_json"),
            ("exitRulesJson", "exitRules", "exit_rules_json"),
        ):
            if object_field in given:
                setattr(row, column, _json_text(given[object_field], object_field))
            elif text_field in given:
                setattr(row, column, _json_text(given[text_field], text_field))
        if "useIndicatorExit" in given:
            row.use_indicator_exit = bool(given["useIndicatorExit"])
        row.updated_at = now
        await db.flush()
        # Validated against the definition as it stands, with these rules.
        validate = _validator(request)
        if validate is not None and (definition.status or "").upper() == "ACTIVE":
            configs = await StrategyConfigRepository(db).find(strategy_name=name)
            why = validate(definition, configs, row)
            if why is not None:
                await db.rollback()
                raise HTTPException(status_code=400, detail=f"the engine would refuse it: {why}")
        await db.commit()
        await _reload(request)
        return ok(rules_wire(name, row), message=f"{name}: rules saved")

    # -- subscriptions --------------------------------------------------------

    async def _names(db: AsyncSession) -> dict[str, str]:
        return {row.id: row.display_name for row in await TradingClientsRepository(db).all()}

    async def _subscription(db: AsyncSession, subscription_id: int) -> models.SubscriptionsRow:
        row = await SubscriptionsRepository(db).find_one(subscription_id=subscription_id)
        if row is None:
            raise HTTPException(
                status_code=404, detail=f"subscription {subscription_id} does not exist"
            )
        return row

    def _apply_subscription(row: models.SubscriptionsRow, body: SubscriptionEdit) -> None:
        given = body.model_dump(exclude_unset=True)
        if "capital" in given:
            capital = _decimal(given["capital"], "capital")
            if capital is None or capital <= 0:
                raise HTTPException(
                    status_code=400,
                    detail="capital must be a positive amount; the engine will not trade a "
                    "subscription with none",
                )
            row.capital = capital
        for wire, column in (
            ("riskPercentage", "risk_percentage"),
            ("absoluteMaxRisk", "absolute_max_risk"),
            ("leverage", "leverage"),
        ):
            if wire in given:
                setattr(row, column, _decimal(given[wire], wire))
        if "maxActivePositions" in given:
            row.max_active_positions = given["maxActivePositions"]
        if "isPaperTrading" in given:
            row.is_paper_trading = bool(given["isPaperTrading"])

    @router.get("/subscriptions")
    async def list_subscriptions(
        db: AsyncSession = Depends(session),
        activeOnly: bool = Query(default=False),  # noqa: N803 -- the Console's name
    ) -> dict[str, Any]:
        rows = await SubscriptionsRepository(db).all(order_by="subscription_id")
        if activeOnly:
            rows = [r for r in rows if r.is_active]
        names = await _names(db)
        return ok(
            [subscription_wire(r, names.get(r.trading_client_id)) for r in rows],
            count=len(rows),
        )

    @router.get("/subscriptions/active")
    async def active_subscriptions(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = [r for r in await SubscriptionsRepository(db).all() if r.is_active]
        names = await _names(db)
        return ok([subscription_wire(r, names.get(r.trading_client_id)) for r in rows])

    @router.get("/subscriptions/client/{trading_client_id}")
    async def for_client(
        trading_client_id: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        rows = await SubscriptionsRepository(db).for_client(trading_client_id)
        names = await _names(db)
        return ok([subscription_wire(r, names.get(r.trading_client_id)) for r in rows])

    @router.get("/subscriptions/strategy/{name}")
    async def for_strategy(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await SubscriptionsRepository(db).for_strategy(name)
        names = await _names(db)
        return ok([subscription_wire(r, names.get(r.trading_client_id)) for r in rows])

    @router.get("/subscriptions/{subscription_id}")
    async def get_subscription(
        subscription_id: int, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _subscription(db, subscription_id)
        return ok(subscription_wire(row, (await _names(db)).get(row.trading_client_id)))

    @router.post("/subscriptions", status_code=201)
    async def create_subscription(
        body: NewSubscription, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        client = await TradingClientsRepository(db).get(body.tradingClientId.strip())
        if client is None:
            raise HTTPException(
                status_code=404, detail=f"{body.tradingClientId!r} is not a trading client"
            )
        name = body.strategyName.strip()
        if await StrategyDefinitionsRepository(db).find_one(strategy_name=name) is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a strategy")
        existing = await SubscriptionsRepository(db).find_one(
            trading_client_id=client.id, strategy_name=name
        )
        if existing is not None:
            # Two subscriptions to one strategy on one account would enter
            # every signal twice.
            raise HTTPException(
                status_code=409,
                detail=f"{client.display_name} is already subscribed to {name}; edit that one",
            )
        now = clock.now()
        active = body.isActive if body.isActive is not None else True
        row = models.SubscriptionsRow(
            trading_client_id=client.id,
            strategy_name=name,
            is_active=active,
            activated_at=now if active else None,
            is_paper_trading=False,
            created_at=now,
            updated_at=now,
        )
        _apply_subscription(row, body)
        if row.capital is None:
            raise HTTPException(status_code=400, detail="capital is required")
        SubscriptionsRepository(db).add(row)
        await db.commit()
        await _reload(request)
        logger.info(
            "%s subscribed to %s with %s (%s)",
            client.display_name,
            name,
            row.capital,
            "paper" if row.is_paper_trading else "live",
        )
        return ok(
            subscription_wire(row, client.display_name),
            message=f"{client.display_name} subscribed to {name}",
        )

    @router.put("/subscriptions/{subscription_id}")
    async def update_subscription(
        subscription_id: int,
        body: SubscriptionEdit,
        request: Request,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        row = await _subscription(db, subscription_id)
        _apply_subscription(row, body)
        if body.isActive is not None and bool(row.is_active) != body.isActive:
            _set_active(row, body.isActive, clock.now())
        row.updated_at = clock.now()
        await db.commit()
        await _reload(request)
        return ok(subscription_wire(row, (await _names(db)).get(row.trading_client_id)))

    @router.put("/subscriptions/{subscription_id}/activate")
    async def activate(
        subscription_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _subscription(db, subscription_id)
        if row.is_active:
            raise HTTPException(status_code=400, detail="the subscription is already active")
        _set_active(row, True, clock.now())
        await db.commit()
        await _reload(request)
        return ok(subscription_wire(row, (await _names(db)).get(row.trading_client_id)))

    @router.put("/subscriptions/{subscription_id}/deactivate")
    async def deactivate(
        subscription_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Stops new entries. Open positions are managed to their end."""
        row = await _subscription(db, subscription_id)
        if not row.is_active:
            raise HTTPException(status_code=400, detail="the subscription is already inactive")
        _set_active(row, False, clock.now())
        await db.commit()
        await _reload(request)
        return ok(subscription_wire(row, (await _names(db)).get(row.trading_client_id)))

    @router.delete("/subscriptions/{subscription_id}")
    async def delete_subscription(
        subscription_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _subscription(db, subscription_id)
        await SubscriptionsRepository(db).delete_where(subscription_id=subscription_id)
        await db.commit()
        await _reload(request)
        return ok(None, message=f"{row.trading_client_id} unsubscribed from {row.strategy_name}")

    return router


def _refuse_bad_window(row: models.StrategyDefinitionsRow) -> None:
    """Start strictly before stop, when both are set and readable.

    The reference's rule: an inverted or empty window is a strategy that
    never fires, and that is a thing to learn at the form.
    """
    start, stop = (row.start_time or "").strip(), (row.stop_time or "").strip()
    if not start or not stop:
        return
    try:
        begins = dt.time.fromisoformat(start)
        ends = dt.time.fromisoformat(stop)
    except ValueError:
        return
    if begins >= ends:
        raise HTTPException(
            status_code=400,
            detail=f"startTime {start} is not before stopTime {stop}; the trading window is "
            "empty and the strategy would never fire",
        )


def _set_active(row: models.SubscriptionsRow, active: bool, now: datetime) -> None:
    row.is_active = active
    if active:
        row.activated_at = now
        row.deactivated_at = None
    else:
        row.deactivated_at = now
    row.updated_at = now
