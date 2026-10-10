"""Risk: the limits, the breach log and the kill switches.

`RMS_CONFIG`, `RMS_BREACH_LOG`, `KILL_SWITCHES` and `KILL_SWITCH_TYPES` in
the reference engine, served the way garuda reads them.

**Limits are scoped, not levelled.** The reference's `config_level` column
disagrees with its own scope columns often enough to be unusable -- rows
labelled `SYMBOL` with no symbol, `GLOBAL` naming an exchange -- so the
engine resolves by the populated columns and ignores the label
(`rms/scope.py`). Here the label is *computed* from the columns on every
write, so the two can never disagree again, and the broker and user scopes
are folded into the trading client, which is what a limit belongs to. The
effective view resolves exactly as the gate does: the narrowest row that
applies wins, column by column.

**A column that means nothing at a row's scope is dropped**, with the
reference's own applicability table: a rate limit on a symbol row, a stale
price window on an account row. The reference nulls them at merge time and
says nothing; garuda drops them at the write and says which.

**The gate cannot be switched off.** The reference has an enable/disable
pair on the service; garuda does not, because a gate with an off switch is
a gate someone will leave off. What the operator has instead is the kill
switch, which stops entries and never exits.

**Kill switches keep the reference's three states.** Active stops orders;
inactive is turned off but still listed, an audit trail and a tombstone;
removed is gone from today's list with its row kept. Each is a separate
operator action, as there. A source can be disarmed through the typed
table, though the automatic sources are not built yet and the page says so.

Every write re-reads the table into the running engine's book, so a limit
or a stop applies to the next order rather than the next restart.
"""

from __future__ import annotations

import datetime as dt
import logging
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlalchemy import Boolean, Integer, Numeric, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    ExchangesRepository,
    KillSwitchesRepository,
    KillSwitchTypesRepository,
    RmsConfigRepository,
    TradingClientsRepository,
)
from garuda.protocols.clock import Clock
from garuda.rms.breaches import BreachType
from garuda.rms.killswitch import MANUAL
from garuda.rms.scope import (
    APPLICABLE_AT,
    ENFORCED_COLUMNS,
    LEVELS,
    SEGMENT_KINDS,
    inapplicable,
    level_of,
)

logger = logging.getLogger(__name__)

#: Columns that are not limits. Everything else on the row is one.
NOT_A_SETTING = frozenset(
    {
        "id",
        "config_level",
        "exchange",
        "trading_client_id",
        "symbol",
        "segment_type",
        "is_active",
        "created_at",
        "updated_at",
    }
)

#: What the reference calls a segment on this table. Narrows a row to one
#: sort of contract; a row without one applies to every sort.
SEGMENTS: tuple[str, ...] = ("EQUITY", "FUTURES", "OPTIONS")

#: How the page groups the limits, in the reference's order.
GROUPS: dict[str, tuple[str, ...]] = {
    "Price validation": (
        "stale_price_seconds",
        "early_market_grace_seconds",
        "min_volume_today",
        "min_volume_early_market",
        "min_volume_early_period_seconds",
        "min_open_interest",
        "max_bid_ask_spread_pct",
        "max_bid_ask_spread_absolute",
        "bid_ask_absolute_threshold_price",
        "min_depth_quantity",
        "min_depth_levels",
        "enable_freak_price_check",
        "freak_check_min_price",
        "max_price_deviation_pct",
        "max_price_deviation_abs",
        "skip_price_validation_for_exit",
    ),
    "Order and position limits": (
        "max_order_qty",
        "max_order_qty_lots",
        "max_order_value",
        "enable_freeze_qty_check",
        "max_order_operations_per_second",
        "max_orders_per_second",
        "max_orders_per_minute",
        "max_orders_per_day",
        "max_buy_orders_per_day",
        "max_sell_orders_per_day",
        "max_orders_per_symbol_per_day",
        "max_total_positions",
        "max_total_combos",
        "max_position_qty_per_symbol",
        "max_buy_qty_per_symbol_per_day",
        "max_sell_qty_per_symbol_per_day",
    ),
    "Loss protection": (
        "max_daily_loss_amount",
        "max_daily_loss_pct",
        "enable_auto_kill_on_loss",
        "auto_square_off_on_breach",
    ),
    "Circuit breakers": (
        "max_rejection_rate_pct",
        "max_vix_level",
        "volatility_pause_minutes",
    ),
}

#: What can raise a switch without an operator, in the reference. None of
#: them is built here; the arm/disarm flags are stored and honoured by the
#: loader so a ported configuration keeps its meaning.
AUTOMATIC_SOURCES: tuple[str, ...] = ("DAILY_LOSS", "REJECTION_RATE", "VOLATILITY")

#: What a kill switch can stop. The reference's five, less the broker:
#: stopping every account at one broker is what the Brokers page does.
KILL_LEVELS: tuple[str, ...] = ("GLOBAL", "EXCHANGE", "SYMBOL", "CLIENT")

#: The one answer the gate has when it refuses: nothing went to the broker.
ORDER_REJECTED = "ORDER_REJECTED"

#: What the Console cannot send on its own. There is one operator.
OPERATOR = "admin"

#: The stale-quote window the gate uses when no row sets one. The one limit
#: whose absence is not "off"; see `composition/risk.py`.
DEFAULT_STALE_SECONDS = 30


def _camel(column: str) -> str:
    head, *rest = column.split("_")
    return head + "".join(part.title() for part in rest)


_COLUMNS = {
    column.name: column
    for column in models.RmsConfigRow.__table__.columns
    if column.name not in NOT_A_SETTING
}
_WIRE_TO_COLUMN = {_camel(name): name for name in _COLUMNS}

#: Specificity weights, the same as `LimitScope.specificity`: an underlying
#: beats an account, which beats an exchange, which beats a segment.
_WEIGHTS = {"symbol": 8, "trading_client_id": 4, "exchange": 2, "segment_type": 1}


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


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value else None


type Labels = dict[str, tuple[str, str]]


def scope_label(
    *,
    exchange: str | None,
    client: str | None,
    symbol: str | None,
    segment: str | None,
) -> str:
    parts = [
        f"{label} {value}"
        for label, value in (("exchange", exchange), ("symbol", symbol), ("client", client))
        if value
    ]
    text = " and ".join(parts) if parts else "global"
    return f"{text} for {segment}" if segment else text


def row_wire(row: models.RmsConfigRow, labels: Labels) -> dict[str, Any]:
    client = labels.get(row.trading_client_id or "", (None, None))
    out: dict[str, Any] = {
        "id": row.id,
        "configLevel": row.config_level,
        "exchange": row.exchange,
        "symbol": row.symbol,
        "tradingClientId": row.trading_client_id,
        "tradingClient": client[0],
        "broker": client[1],
        "segmentType": row.segment_type,
        "isActive": row.is_active is not False,
        "scope": scope_label(
            exchange=row.exchange,
            client=client[0] or row.trading_client_id,
            symbol=row.symbol,
            segment=row.segment_type,
        ),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }
    for name in _COLUMNS:
        out[_camel(name)] = _plain(getattr(row, name))
    out["setFields"] = sorted(_camel(n) for n in _COLUMNS if getattr(row, n) is not None)
    return out


def catalog() -> dict[str, Any]:
    grouped = {name for names in GROUPS.values() for name in names}
    groups = [
        {"name": title, "fields": [_camel(n) for n in names if n in _COLUMNS]}
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
                "enforced": name in ENFORCED_COLUMNS,
                "levels": sorted(APPLICABLE_AT.get(name, frozenset(LEVELS)), key=LEVELS.index),
            }
            for name, column in _COLUMNS.items()
        },
        "groups": groups,
        "levels": list(LEVELS),
        "segments": list(SEGMENTS),
        "killLevels": list(KILL_LEVELS),
        "automaticSources": list(AUTOMATIC_SOURCES),
    }


def breach_wire(row: models.RmsBreachLogRow, labels: Labels) -> dict[str, Any]:
    client = labels.get(row.trading_client_id or "", (None, None))
    return {
        "id": row.id,
        "breachTime": _iso(row.breach_time),
        "tradingClientId": row.trading_client_id,
        "tradingClient": client[0],
        "broker": client[1],
        "strategyName": row.strategy_name,
        "tradingSymbol": row.trading_symbol,
        "exchange": row.exchange,
        "breachType": row.breach_type,
        "breachCategory": row.breach_category,
        "breachDetails": row.breach_details,
        "actionTaken": row.action_taken,
        "currentValue": row.current_value,
        "limitValue": row.limit_value,
        "severity": row.severity if row.severity is not None else 1,
    }


def breach_filters() -> dict[str, Any]:
    by_category: dict[str, list[str]] = {}
    for member in BreachType:
        by_category.setdefault(member.family.value, []).append(member.value)
    return {
        "breachTypes": [m.value for m in BreachType],
        "categories": list(by_category),
        "typesByCategory": by_category,
        "severities": {m.value: m.severity for m in BreachType},
    }


def switch_key(
    level: str, *, exchange: str | None, symbol: str | None, trading_client: str | None
) -> str:
    """The reference's key, with the client where its user and broker were."""
    if level == "GLOBAL":
        return "GLOBAL"
    if level == "EXCHANGE":
        return f"EXCHANGE|{exchange}"
    if level == "SYMBOL":
        return f"SYMBOL|{symbol}"
    return f"CLIENT|{trading_client}"


def switch_wire(row: models.KillSwitchesRow, labels: Labels) -> dict[str, Any]:
    client = labels.get(row.trading_client_id or "", (None, None))
    return {
        "key": row.key_name,
        "level": row.level,
        "exchange": row.exchange,
        "symbol": row.symbol,
        "tradingClientId": row.trading_client_id,
        "tradingClient": client[0],
        "broker": client[1],
        "reason": row.reason,
        "active": bool(row.active),
        "source": row.source,
        "createdDate": row.created_date.isoformat(),
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
        "updatedBy": row.updated_by,
    }


class ConfigEdit(BaseModel):
    """Any limit, by its wire name. Absent leaves it; null clears it."""

    model_config = {"extra": "allow"}

    isActive: bool | None = None  # noqa: N815 -- the Console's names


class NewConfig(ConfigEdit):
    exchange: str | None = None
    symbol: str | None = None
    tradingClientId: str | None = None  # noqa: N815
    segmentType: str | None = None  # noqa: N815


class KillSwitchRequest(BaseModel):
    level: str
    exchange: str | None = None
    symbol: str | None = None
    tradingClientId: str | None = None  # noqa: N815
    reason: str | None = None


class KeysRequest(BaseModel):
    keys: list[str]


class KillSwitchTypeRequest(BaseModel):
    source: str
    enabled: bool
    alsoRemoveInstances: bool = False  # noqa: N815


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
            if number < 0:
                raise HTTPException(status_code=400, detail=f"{wire} cannot be negative")
            return number
        if kind == "decimal":
            parsed = Decimal(str(value))
            if parsed < 0:
                raise HTTPException(status_code=400, detail=f"{wire} cannot be negative")
            return parsed
    except (ValueError, TypeError, InvalidOperation):
        raise HTTPException(status_code=400, detail=f"{wire}: {value!r} is not a number") from None
    return str(value).strip() or None


def _segment(value: str | None) -> str | None:
    code = (value or "").strip().upper()
    if not code:
        return None
    if code not in SEGMENTS:
        raise HTTPException(
            status_code=400,
            detail=f"{value!r} is not a segment; one of " + ", ".join(SEGMENTS),
        )
    return code


def _specificity(row: models.RmsConfigRow) -> int:
    return sum(weight for name, weight in _WEIGHTS.items() if getattr(row, name))


def _applies(
    row: models.RmsConfigRow,
    *,
    exchange: str | None,
    client: str | None,
    symbol: str | None,
    segment: str | None,
) -> bool:
    """Whether a row is about this order, by the same rules as the gate."""
    if row.exchange and row.exchange.upper() != (exchange or "").upper():
        return False
    if row.trading_client_id and row.trading_client_id != client:
        return False
    if row.symbol and row.symbol.upper() != (symbol or "").upper():
        return False
    if row.segment_type:
        kind = SEGMENT_KINDS.get(row.segment_type.upper())
        wanted = SEGMENT_KINDS.get((segment or "").upper())
        # A segment the loader cannot place applies to every kind, there
        # and here.
        if kind is not None and kind is not wanted:
            return False
    return True


def _level(row: models.RmsConfigRow) -> str:
    return level_of(exchange=row.exchange, trading_client=row.trading_client_id, symbol=row.symbol)


def _effective(
    rows: list[models.RmsConfigRow], labels: Labels
) -> tuple[dict[str, Any], dict[str, str], int]:
    """Merge the applicable rows widest first, recording where each value came from."""
    values: dict[str, Any] = {}
    sources: dict[str, str] = {}
    for row in sorted(rows, key=_specificity):
        level = _level(row)
        set_here = [n for n in _COLUMNS if getattr(row, n) is not None]
        skipped = set(inapplicable(level, set_here))
        label = row_wire(row, labels)["scope"]
        for name in set_here:
            if name in skipped:
                continue
            values[_camel(name)] = _plain(getattr(row, name))
            sources[_camel(name)] = label
    if "stalePriceSeconds" not in values:
        values["stalePriceSeconds"] = DEFAULT_STALE_SECONDS
        sources["stalePriceSeconds"] = "default"
    return values, sources, len(rows)


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/rms-config", tags=["rms"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _reload(request: Request, hook: str) -> None:
        reload = getattr(request.app.state, hook, None)
        if reload is None:
            return
        try:
            await reload()
        except Exception:
            logger.exception("the engine could not re-read its %s", hook.removeprefix("reload_"))

    async def _labels(db: AsyncSession) -> Labels:
        return {
            row.id: (row.display_name, row.broker)
            for row in await TradingClientsRepository(db).all()
        }

    async def _zone(db: AsyncSession) -> dt.tzinfo:
        """The venue's clock, for what "today" means. UTC when none is set."""
        for row in await ExchangesRepository(db).all(order_by="exchange_code"):
            if row.timezone:
                try:
                    return ZoneInfo(row.timezone)
                except ZoneInfoNotFoundError:
                    continue
        return dt.UTC

    async def _today(request: Request, db: AsyncSession) -> dt.date:
        """Which session a kill switch belongs to.

        The venue's trading day as the engine's own calendar reckons it, so a
        switch set on Saturday evening is dated Monday and stops Monday's
        entries -- and so this page and the engine's loader can never
        disagree about which rows are today's. The calendar lives on the
        running engine; without one, the venue's calendar date.
        """
        now = clock.now()
        engine = getattr(request.app.state, "engine", None)
        venues = getattr(getattr(engine, "parts", None), "venues", None)
        exchanges = getattr(venues, "all", ())
        if exchanges:
            day: dt.date = exchanges[0].trading_day_for(now)
            return day
        return now.astimezone(await _zone(db)).date()

    async def _row(db: AsyncSession, config_id: int) -> models.RmsConfigRow:
        row = await RmsConfigRepository(db).get(config_id)
        if row is None:
            raise HTTPException(status_code=404, detail=f"risk config {config_id} does not exist")
        return row

    async def _exchange(db: AsyncSession, value: str | None) -> str | None:
        code = (value or "").strip().upper()
        if not code:
            return None
        if await ExchangesRepository(db).get(code) is None:
            raise HTTPException(status_code=400, detail=f"{code!r} is not an exchange")
        return code

    async def _client(db: AsyncSession, value: str | None) -> str | None:
        client_id = (value or "").strip()
        if not client_id:
            return None
        if await TradingClientsRepository(db).get(client_id) is None:
            raise HTTPException(status_code=404, detail=f"{client_id!r} is not a trading client")
        return client_id

    async def _same_scope(
        db: AsyncSession,
        *,
        exchange: str | None,
        client: str | None,
        symbol: str | None,
        segment: str | None,
    ) -> models.RmsConfigRow | None:
        for row in await RmsConfigRepository(db).all():
            if (
                (row.exchange or None) == exchange
                and (row.trading_client_id or None) == client
                and (row.symbol or None) == symbol
                and (row.segment_type or None) == segment
            ):
                return row
        return None

    def _apply(row: models.RmsConfigRow, body: ConfigEdit) -> list[str]:
        """Write the limits onto the row. Returns the wire names dropped."""
        given = body.model_dump(exclude_unset=True)
        for wire, value in given.items():
            if wire in (
                "id",
                "exchange",
                "symbol",
                "tradingClientId",
                "tradingClient",
                "broker",
                "segmentType",
                "configLevel",
                "scope",
                "setFields",
                "createdAt",
                "updatedAt",
            ):
                continue
            if wire == "isActive":
                if value is not None:
                    row.is_active = bool(value)
                continue
            name = _WIRE_TO_COLUMN.get(wire)
            if name is None:
                raise HTTPException(status_code=400, detail=f"{wire!r} is not a risk limit")
            setattr(row, name, _coerce(name, value))
        row.config_level = _level(row)
        dropped = inapplicable(
            row.config_level, [n for n in _COLUMNS if getattr(row, n) is not None]
        )
        for name in dropped:
            logger.warning(
                "dropping %s from a %s-scoped risk row: it does not apply there",
                name,
                row.config_level,
            )
            setattr(row, name, None)
        return [_camel(n) for n in dropped]

    def _saved_message(row: models.RmsConfigRow, labels: Labels, dropped: list[str]) -> str:
        scope = row_wire(row, labels)["scope"]
        note = ""
        if dropped:
            note = f"; {', '.join(dropped)} dropped as meaningless at {row.config_level} scope"
        return f"risk limits for {scope} saved{note}"

    # -- limits ---------------------------------------------------------------

    @router.get("/catalog")
    async def the_catalog() -> dict[str, Any]:
        return ok(catalog())

    @router.get("/field-applicability")
    async def field_applicability() -> dict[str, Any]:
        return ok({wire: field["levels"] for wire, field in catalog()["fields"].items()})

    @router.get("/status")
    async def status(request: Request, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """What the gate is working with. It is always on; that is the point."""
        today = await _today(request, db)
        rows = await RmsConfigRepository(db).all()
        switches = [
            r
            for r in await KillSwitchesRepository(db).find(created_date=today)
            if r.removed_at is None and r.active
        ]
        return ok(
            {
                "enabled": True,
                "activeConfigRows": sum(1 for r in rows if r.is_active is not False),
                "activeKillSwitchCount": len(switches),
                "breachesToday": await _count_today(db, today),
            }
        )

    async def _count_today(db: AsyncSession, today: dt.date) -> int:
        zone = await _zone(db)
        start = dt.datetime.combine(today, dt.time.min, tzinfo=zone)
        statement = (
            select(func.count())
            .select_from(models.RmsBreachLogRow)
            .where(models.RmsBreachLogRow.breach_time >= start)
            .where(models.RmsBreachLogRow.breach_time < start + dt.timedelta(days=1))
        )
        return int((await db.execute(statement)).scalar_one())

    @router.get("/effective")
    async def effective(
        db: AsyncSession = Depends(session),
        segmentType: str | None = Query(default=None),  # noqa: N803 -- the Console's names
        exchange: str | None = Query(default=None),
        symbol: str | None = Query(default=None),
        tradingClientId: str | None = Query(default=None),  # noqa: N803
    ) -> dict[str, Any]:
        """What the gate would enforce on one order, and where each value came from."""
        segment = _segment(segmentType)
        client = (tradingClientId or "").strip() or None
        wanted = {
            "exchange": (exchange or "").strip().upper() or None,
            "client": client,
            "symbol": (symbol or "").strip().upper() or None,
            "segment": segment,
        }
        labels = await _labels(db)
        rows = [
            r
            for r in await RmsConfigRepository(db).all()
            if r.is_active is not False and _applies(r, **wanted)
        ]
        values, sources, layers = _effective(rows, labels)
        return ok(
            {
                "segmentType": segment,
                "exchange": wanted["exchange"],
                "symbol": wanted["symbol"],
                "tradingClientId": client,
                "config": values,
                "sources": sources,
                "enforced": sorted(_camel(n) for n in ENFORCED_COLUMNS),
                "layersInScope": layers,
            }
        )

    @router.get("")
    async def list_rows(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        labels = await _labels(db)
        rows = sorted(
            await RmsConfigRepository(db).all(),
            key=lambda r: (_specificity(r), r.exchange or "", r.symbol or "", r.id),
        )
        return ok([row_wire(r, labels) for r in rows], count=len(rows))

    @router.get("/level/{level}")
    async def by_level(level: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        code = level.strip().upper()
        if code not in LEVELS:
            raise HTTPException(
                status_code=400, detail=f"{level!r} is not a scope; one of " + ", ".join(LEVELS)
            )
        labels = await _labels(db)
        rows = [r for r in await RmsConfigRepository(db).all() if _level(r) == code]
        return ok([row_wire(r, labels) for r in rows], count=len(rows))

    @router.get("/segment/{segment}")
    async def by_segment(segment: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        code = _segment(segment)
        labels = await _labels(db)
        rows = [
            r for r in await RmsConfigRepository(db).all() if (r.segment_type or "").upper() == code
        ]
        return ok([row_wire(r, labels) for r in rows], count=len(rows))

    @router.post("", status_code=201)
    async def create_row(
        body: NewConfig, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        exchange = await _exchange(db, body.exchange)
        client = await _client(db, body.tradingClientId)
        symbol = (body.symbol or "").strip().upper() or None
        segment = _segment(body.segmentType)
        labels = await _labels(db)
        if await _same_scope(db, exchange=exchange, client=client, symbol=symbol, segment=segment):
            scope = scope_label(
                exchange=exchange,
                client=labels.get(client or "", (client, None))[0],
                symbol=symbol,
                segment=segment,
            )
            raise HTTPException(
                status_code=409, detail=f"there is already a {scope} row; edit that one"
            )
        now = clock.now()
        row = models.RmsConfigRow(
            config_level="GLOBAL",
            exchange=exchange,
            trading_client_id=client,
            symbol=symbol,
            segment_type=segment,
            is_active=True,
            created_at=now,
            updated_at=now,
        )
        dropped = _apply(row, body)
        RmsConfigRepository(db).add(row)
        await db.commit()
        await db.refresh(row)
        await _reload(request, "reload_limits")
        message = _saved_message(row, labels, dropped)
        logger.info(message)
        return ok(row_wire(row, labels), message=message)

    @router.put("/{config_id}")
    async def update_row(
        config_id: int, body: ConfigEdit, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """The scope is fixed; the limits change. A different scope is a new row."""
        row = await _row(db, config_id)
        dropped = _apply(row, body)
        row.updated_at = clock.now()
        await db.commit()
        await db.refresh(row)
        await _reload(request, "reload_limits")
        labels = await _labels(db)
        return ok(row_wire(row, labels), message=_saved_message(row, labels, dropped))

    @router.delete("/{config_id}")
    async def delete_row(
        config_id: int, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _row(db, config_id)
        labels = await _labels(db)
        scope = row_wire(row, labels)["scope"]
        await db.delete(row)
        await db.commit()
        await _reload(request, "reload_limits")
        return ok(None, message=f"risk limits for {scope} removed")

    # -- breaches -------------------------------------------------------------

    @router.get("/breach-filters")
    async def the_breach_filters() -> dict[str, Any]:
        return ok(breach_filters())

    @router.get("/breaches/today")
    async def breaches_today(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        zone = await _zone(db)
        start = dt.datetime.combine(clock.now().astimezone(zone).date(), dt.time.min, tzinfo=zone)
        statement = (
            select(models.RmsBreachLogRow)
            .where(models.RmsBreachLogRow.breach_time >= start)
            .where(models.RmsBreachLogRow.breach_time < start + dt.timedelta(days=1))
            .order_by(models.RmsBreachLogRow.breach_time.desc(), models.RmsBreachLogRow.id.desc())
        )
        rows = list((await db.execute(statement)).scalars())
        labels = await _labels(db)
        return ok([breach_wire(r, labels) for r in rows], count=len(rows))

    @router.get("/breaches")
    async def breaches(
        db: AsyncSession = Depends(session),
        page: int | None = Query(default=None, ge=1),
        pageSize: int | None = Query(default=None, ge=1, le=500),  # noqa: N803
        limit: int = Query(default=100, ge=1, le=1000),
        tradingClientId: str | None = Query(default=None),  # noqa: N803
        type: str | None = Query(default=None),
        category: str | None = Query(default=None),
        severity: int | None = Query(default=None),
        startDate: dt.date | None = Query(default=None),  # noqa: N803
        endDate: dt.date | None = Query(default=None),  # noqa: N803
        search: str | None = Query(default=None),
    ) -> dict[str, Any]:
        """The log, filtered in SQL so the count and the cards agree with the page.

        Severity buckets as the reference draws them: 1 is low (under 2),
        2 is medium (2 but under 3), 3 is high (3 and up).
        """
        log = models.RmsBreachLogRow
        labels = await _labels(db)
        zone = await _zone(db)
        conditions: list[Any] = []
        if tradingClientId:
            conditions.append(log.trading_client_id == tradingClientId.strip())
        if type:
            conditions.append(log.breach_type == type.strip().upper())
        if category:
            conditions.append(log.breach_category == category.strip().upper())
        if severity is not None:
            if severity >= 3:
                conditions.append(log.severity >= 3)
            elif severity == 2:
                conditions.append((log.severity >= 2) & (log.severity < 3))
            else:
                conditions.append(or_(log.severity < 2, log.severity.is_(None)))
        if startDate is not None:
            conditions.append(
                log.breach_time >= dt.datetime.combine(startDate, dt.time.min, tzinfo=zone)
            )
        if endDate is not None:
            conditions.append(
                log.breach_time
                < dt.datetime.combine(endDate + dt.timedelta(days=1), dt.time.min, tzinfo=zone)
            )
        if search and search.strip():
            like = f"%{search.strip()}%"
            matching_clients = [
                client_id
                for client_id, (name, broker) in labels.items()
                if search.strip().lower() in (name or "").lower()
                or search.strip().lower() in (broker or "").lower()
            ]
            alternatives = [
                log.breach_details.ilike(like),
                log.trading_symbol.ilike(like),
                log.breach_type.ilike(like),
                log.strategy_name.ilike(like),
            ]
            if matching_clients:
                alternatives.append(log.trading_client_id.in_(matching_clients))
            conditions.append(or_(*alternatives))

        ordered = select(log).where(*conditions).order_by(log.breach_time.desc(), log.id.desc())
        if page is None and pageSize is None:
            rows = list((await db.execute(ordered.limit(limit))).scalars())
            return ok([breach_wire(r, labels) for r in rows], count=len(rows))

        page = page or 1
        size = pageSize or 20
        total = int(
            (
                await db.execute(select(func.count()).select_from(log).where(*conditions))
            ).scalar_one()
        )
        high, clients = (
            await db.execute(
                select(
                    func.coalesce(func.sum(case((log.severity >= 3, 1), else_=0)), 0),
                    func.count(func.distinct(log.trading_client_id)),
                ).where(*conditions)
            )
        ).one()
        rows = list((await db.execute(ordered.offset((page - 1) * size).limit(size))).scalars())
        pages = max(1, -(-total // size))
        return ok(
            {
                "data": [breach_wire(r, labels) for r in rows],
                "pagination": {
                    "page": page,
                    "pageSize": size,
                    "totalCount": total,
                    "totalPages": pages,
                    "hasNext": page < pages,
                    "hasPrev": page > 1,
                },
                "summary": {"highSeverity": int(high), "uniqueClients": int(clients)},
            }
        )

    # -- kill switches --------------------------------------------------------

    async def _todays_switches(db: AsyncSession, today: dt.date) -> list[models.KillSwitchesRow]:
        rows = await KillSwitchesRepository(db).find(created_date=today, order_by="created_at")
        return [r for r in rows if r.removed_at is None]

    async def _type_states(db: AsyncSession) -> dict[str, bool]:
        rows = await KillSwitchTypesRepository(db).all()
        stored = {row.source: bool(row.enabled) for row in rows}
        return {source: stored.get(source, True) for source in AUTOMATIC_SOURCES}

    async def _kill_switch_status(request: Request, db: AsyncSession) -> dict[str, Any]:
        today = await _today(request, db)
        labels = await _labels(db)
        switches = await _todays_switches(db, today)
        return {
            "date": today.isoformat(),
            "switches": [switch_wire(r, labels) for r in switches],
            "activeCount": sum(1 for r in switches if r.active),
            "typeStates": await _type_states(db),
            # The reference raises switches from a daily loss, a rejection
            # rate and a volatility circuit. Garuda refuses at the loss
            # limit through the gate instead, and raises nothing on its own.
            "automaticSourcesBuilt": False,
        }

    @router.get("/kill-switch")
    async def kill_switch_status(
        request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        return ok(await _kill_switch_status(request, db))

    @router.post("/kill-switch")
    async def activate(
        body: KillSwitchRequest, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Stop something. A switch turned off earlier today is turned back on."""
        level = body.level.strip().upper()
        if level not in KILL_LEVELS:
            raise HTTPException(
                status_code=400,
                detail=f"{body.level!r} is not a kill switch level; one of "
                + ", ".join(KILL_LEVELS),
            )
        exchange = await _exchange(db, body.exchange) if level == "EXCHANGE" else None
        symbol = (body.symbol or "").strip().upper() or None if level == "SYMBOL" else None
        client = await _client(db, body.tradingClientId) if level == "CLIENT" else None
        if level == "EXCHANGE" and not exchange:
            raise HTTPException(
                status_code=400, detail="an exchange-level switch needs an exchange"
            )
        if level == "SYMBOL" and not symbol:
            raise HTTPException(status_code=400, detail="a symbol-level switch needs a symbol")
        if level == "CLIENT" and not client:
            raise HTTPException(
                status_code=400, detail="a client-level switch needs a trading client"
            )
        key = switch_key(level, exchange=exchange, symbol=symbol, trading_client=client)
        reason = (body.reason or "").strip() or "Manual activation via the Console"
        now = clock.now()
        today = await _today(request, db)
        existing = next(
            (
                r
                for r in await KillSwitchesRepository(db).find(created_date=today)
                if r.key_name == key
            ),
            None,
        )
        if existing is not None:
            existing.active = True
            existing.reason = reason
            existing.source = MANUAL
            existing.removed_at = None
            existing.clear_time_abs_loss = None
            existing.updated_at = now
            existing.updated_by = OPERATOR
            row = existing
        else:
            row = models.KillSwitchesRow(
                created_date=today,
                key_name=key,
                level=level,
                exchange=exchange,
                symbol=symbol,
                trading_client_id=client,
                reason=reason,
                active=True,
                source=MANUAL,
                created_at=now,
                updated_at=now,
                updated_by=OPERATOR,
            )
            KillSwitchesRepository(db).add(row)
        await db.commit()
        await db.refresh(row)
        await _reload(request, "reload_kill_switches")
        labels = await _labels(db)
        wire = switch_wire(row, labels)
        logger.warning("kill switch ACTIVATED [%s]: %s", key, reason)
        return ok(wire, message=f"kill switch on {_describe(wire)} activated")

    def _describe(wire: dict[str, Any]) -> str:
        if wire["level"] == "GLOBAL":
            return "everything"
        if wire["level"] == "EXCHANGE":
            return f"exchange {wire['exchange']}"
        if wire["level"] == "SYMBOL":
            return f"symbol {wire['symbol']}"
        return f"client {wire['tradingClient'] or wire['tradingClientId']}"

    async def _by_keys(
        request: Request, db: AsyncSession, keys: list[str]
    ) -> tuple[list[models.KillSwitchesRow], list[str]]:
        wanted = [k.strip() for k in keys if k and k.strip()]
        if not wanted:
            raise HTTPException(status_code=400, detail="keys list is required")
        today = await _today(request, db)
        live = {r.key_name: r for r in await _todays_switches(db, today)}
        found = [live[k] for k in wanted if k in live]
        unknown = [k for k in wanted if k not in live]
        return found, unknown

    @router.post("/kill-switch/deactivate")
    async def deactivate(
        body: KeysRequest, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Turn switches off and keep them listed: an audit trail, and the
        tombstone that will suppress an automatic re-fire once those exist."""
        rows, unknown = await _by_keys(request, db, body.keys)
        now = clock.now()
        turned_off = []
        for row in rows:
            if row.active:
                row.active = False
                row.updated_at = now
                row.updated_by = OPERATOR
                turned_off.append(row.key_name)
        await db.commit()
        await _reload(request, "reload_kill_switches")
        return ok(
            {"deactivated": turned_off, "unknown": unknown},
            message=f"{len(turned_off)} kill switch(es) turned off",
        )

    @router.post("/kill-switch/remove")
    async def remove(
        body: KeysRequest, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Take switches off today's list. The row stays, with when it went."""
        rows, unknown = await _by_keys(request, db, body.keys)
        now = clock.now()
        for row in rows:
            row.removed_at = now
            row.updated_at = now
            row.updated_by = OPERATOR
        await db.commit()
        await _reload(request, "reload_kill_switches")
        return ok(
            {"removed": [r.key_name for r in rows], "unknown": unknown},
            message=f"{len(rows)} kill switch(es) removed",
        )

    @router.post("/kill-switch/remove-all")
    async def remove_all(request: Request, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        today = await _today(request, db)
        rows = await _todays_switches(db, today)
        now = clock.now()
        for row in rows:
            row.removed_at = now
            row.updated_at = now
            row.updated_by = OPERATOR
        await db.commit()
        await _reload(request, "reload_kill_switches")
        return ok({"removed": [r.key_name for r in rows]}, message="all kill switches removed")

    @router.post("/kill-switch-type")
    async def set_type(
        body: KillSwitchTypeRequest, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Arm or disarm a source. Persisted, as the reference does since V251:
        an operator should not have to disarm the loss stop every morning."""
        source = body.source.strip().upper()
        if source == MANUAL:
            raise HTTPException(
                status_code=400, detail="the manual source cannot be disarmed; operators always may"
            )
        if source not in AUTOMATIC_SOURCES:
            raise HTTPException(
                status_code=400,
                detail=f"{body.source!r} is not a kill switch source; one of "
                + ", ".join(AUTOMATIC_SOURCES),
            )
        now = clock.now()
        types = KillSwitchTypesRepository(db)
        row = await types.get(source)
        if row is None:
            types.add(
                models.KillSwitchTypesRow(
                    source=source, enabled=body.enabled, updated_at=now, updated_by=OPERATOR
                )
            )
        else:
            row.enabled = body.enabled
            row.updated_at = now
            row.updated_by = OPERATOR
        removed = 0
        if not body.enabled and body.alsoRemoveInstances:
            for switch in await _todays_switches(db, await _today(request, db)):
                if switch.source == source:
                    switch.removed_at = now
                    switch.updated_at = now
                    switch.updated_by = OPERATOR
                    removed += 1
        await db.commit()
        await _reload(request, "reload_kill_switches")
        return ok(
            {"source": source, "enabled": body.enabled, "instancesRemoved": removed},
            message=f"{source} {'armed' if body.enabled else 'disarmed'}",
        )

    # Last, so a literal path above is never read as a row id.
    @router.get("/{config_id}")
    async def get_row(config_id: int, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        return ok(row_wire(await _row(db, config_id), await _labels(db)))

    return router
