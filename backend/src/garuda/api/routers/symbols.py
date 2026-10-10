"""Symbols: the underlyings a strategy may be configured against.

`SYMBOL_INFO` in the reference engine, and the one page here whose table the
engine already reads. `load_symbols` turns each row into a `SymbolInfo`, and
the domain uses it: `strike_gap` places every strike a strategy picks,
`contract_multiplier` is what a lot of crude oil is worth, `freeze_limit_qty`
is where an entry starts being sliced.

That is why this validates rather than storing what it is given. A row the
domain refuses is skipped at load with a line in the log -- and the visible
consequence is a strategy that never finds its instrument, a long way from the
form that saved it. Everything `SymbolInfo.__post_init__` refuses is refused
here too.

The per-broker override is a sub-resource: `symbol_broker_info` holds one
number, a freeze limit for one broker on one symbol, for when a broker is
stricter than the exchange.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    BrokersRepository,
    ExchangesRepository,
    SymbolBrokerInfoRepository,
    SymbolsRepository,
)

logger = logging.getLogger(__name__)


def _decimal(value: Any, field: str) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not a number") from None


def _number(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def _wire(row: models.SymbolsRow) -> dict[str, Any]:
    return {
        "symbol": row.symbol,
        "exchange": row.exchange,
        "indexSymbol": row.index_symbol,
        "isIndex": bool(row.is_index),
        "strikeGap": row.strike_gap,
        "freezeLimitQty": row.freeze_limit_qty,
        "maxOptionChainLevels": row.max_option_chain_levels,
        "straddleMaxPremiumDiff": _number(row.straddle_max_premium_diff),
        "hedgeStrikeRoundingMultiple": row.hedge_strike_rounding_multiple,
        "hasOptionsWeeklyExpiry": bool(row.has_options_weekly_expiry),
        "hasOptionsMonthlyExpiry": bool(row.has_options_monthly_expiry),
        "hasFuturesWeeklyExpiry": bool(row.has_futures_weekly_expiry),
        "hasFuturesMonthlyExpiry": bool(row.has_futures_monthly_expiry),
        "contractMultiplier": row.contract_multiplier,
        "derivesStraddle": bool(row.derives_straddle),
        "derivesPcr": bool(row.derives_pcr),
        "derivesIv": bool(row.derives_iv),
        "derivesSynthetic": bool(row.derives_synthetic),
        "pcrStrikesEachSide": row.pcr_strikes_each_side,
        "displayOrder": row.display_order,
    }


def _broker_wire(row: models.SymbolBrokerInfoRow) -> dict[str, Any]:
    return {
        "symbol": row.symbol,
        "brokerName": row.broker_name,
        "freezeLimitQty": row.freeze_limit_qty,
    }


class SymbolEdit(BaseModel):
    exchange: str | None = None
    indexSymbol: str | None = None  # noqa: N815 -- the Console's field names
    isIndex: bool | None = None  # noqa: N815
    strikeGap: int | None = None  # noqa: N815
    freezeLimitQty: int | None = None  # noqa: N815
    maxOptionChainLevels: int | None = None  # noqa: N815
    straddleMaxPremiumDiff: float | None = None  # noqa: N815
    hedgeStrikeRoundingMultiple: int | None = None  # noqa: N815
    hasOptionsWeeklyExpiry: bool | None = None  # noqa: N815
    hasOptionsMonthlyExpiry: bool | None = None  # noqa: N815
    hasFuturesWeeklyExpiry: bool | None = None  # noqa: N815
    hasFuturesMonthlyExpiry: bool | None = None  # noqa: N815
    contractMultiplier: int | None = None  # noqa: N815
    derivesStraddle: bool | None = None  # noqa: N815
    derivesPcr: bool | None = None  # noqa: N815
    derivesIv: bool | None = None  # noqa: N815
    derivesSynthetic: bool | None = None  # noqa: N815
    pcrStrikesEachSide: int | None = None  # noqa: N815
    displayOrder: int | None = None  # noqa: N815


class NewSymbol(SymbolEdit):
    symbol: str = Field(min_length=1, max_length=100)


class BrokerLimit(BaseModel):
    freezeLimitQty: int  # noqa: N815


class NewBrokerLimit(BrokerLimit):
    brokerName: str = Field(min_length=1, max_length=30)  # noqa: N815


#: Wire name -> (column, converter). Written once; create and update both read it.
_COLUMNS: dict[str, tuple[str, Any]] = {
    "exchange": ("exchange", lambda v: v.strip().upper() if v else v),
    "indexSymbol": ("index_symbol", lambda v: v or None),
    "isIndex": ("is_index", bool),
    "strikeGap": ("strike_gap", lambda v: v),
    "freezeLimitQty": ("freeze_limit_qty", lambda v: v),
    "maxOptionChainLevels": ("max_option_chain_levels", lambda v: v),
    "straddleMaxPremiumDiff": (
        "straddle_max_premium_diff",
        lambda v: _decimal(v, "straddleMaxPremiumDiff") if v is not None else None,
    ),
    "hedgeStrikeRoundingMultiple": ("hedge_strike_rounding_multiple", lambda v: v),
    "hasOptionsWeeklyExpiry": ("has_options_weekly_expiry", bool),
    "hasOptionsMonthlyExpiry": ("has_options_monthly_expiry", bool),
    "hasFuturesWeeklyExpiry": ("has_futures_weekly_expiry", bool),
    "hasFuturesMonthlyExpiry": ("has_futures_monthly_expiry", bool),
    "contractMultiplier": ("contract_multiplier", lambda v: v),
    "derivesStraddle": ("derives_straddle", bool),
    "derivesPcr": ("derives_pcr", bool),
    "derivesIv": ("derives_iv", bool),
    "derivesSynthetic": ("derives_synthetic", bool),
    "pcrStrikesEachSide": ("pcr_strikes_each_side", lambda v: v),
    "displayOrder": ("display_order", lambda v: v),
}


def _values(body: SymbolEdit) -> dict[str, Any]:
    """Only what was sent, so a form that round-trips part of a row cannot
    blank the rest."""
    sent = body.model_dump(exclude_unset=True)
    return {
        column: convert(sent[wire]) for wire, (column, convert) in _COLUMNS.items() if wire in sent
    }


def _refuse_what_the_loader_would_skip(values: dict[str, Any], symbol: str) -> None:
    """The same rules `SymbolInfo.__post_init__` holds.

    Duplicated on purpose rather than by constructing a `SymbolInfo`: the
    partial update has only the fields that were sent, and building the value
    object would need the whole row read back and merged first. The cost of the
    duplication is this function; the cost of not validating is a row that
    stores cleanly and then never trades.
    """
    positive = {
        "strike_gap": "strikeGap",
        "contract_multiplier": "contractMultiplier",
    }
    for column, wire in positive.items():
        value = values.get(column)
        if value is not None and value <= 0:
            raise HTTPException(
                status_code=400, detail=f"{symbol}: {wire} must be greater than zero"
            )

    freeze = values.get("freeze_limit_qty")
    if freeze is not None and freeze < 1:
        raise HTTPException(
            status_code=400, detail=f"{symbol}: freezeLimitQty must be at least one unit"
        )

    position = values.get("display_order")
    if position is not None and position < 0:
        raise HTTPException(status_code=400, detail=f"{symbol}: displayOrder cannot be negative")

    strikes = values.get("pcr_strikes_each_side")
    if strikes is not None and strikes < 1:
        raise HTTPException(
            status_code=400,
            detail=f"{symbol}: pcrStrikesEachSide must cover at least one strike",
        )

    levels = values.get("max_option_chain_levels")
    if levels is not None and levels < 1:
        raise HTTPException(
            status_code=400, detail=f"{symbol}: maxOptionChainLevels must be at least one"
        )

    rounding = values.get("hedge_strike_rounding_multiple")
    if rounding is not None and rounding < 0:
        raise HTTPException(
            status_code=400,
            detail=f"{symbol}: hedgeStrikeRoundingMultiple cannot be negative",
        )


async def _took_effect(request: Request) -> None:
    """Tell the engine its symbol configuration changed.

    The engine reads the symbols once at startup and hands the snapshot to
    four components, so a saved row used to change nothing until a restart --
    a derived series switched on stayed off, silently. The composition root
    supplies the reload; this only asks for it.

    Never raises. The row is already written and that is what was asked for;
    a reload that fails costs the engine noticing until the next restart, and
    saying so in the log is more use than failing the save.
    """
    reload = getattr(request.app.state, "reload_symbols", None)
    if reload is None:
        return
    try:
        await reload()
    except Exception:
        logger.exception("symbols saved, but the engine could not reload them")


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/symbols", tags=["symbols"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _require_exchange(db: AsyncSession, code: str | None) -> None:
        if code is None:
            return
        if await ExchangesRepository(db).get(code) is None:
            raise HTTPException(status_code=404, detail=f"no exchange {code!r}")

    @router.get("")
    async def list_symbols(
        db: AsyncSession = Depends(session),
        exchange: str | None = Query(default=None),
    ) -> dict[str, Any]:
        """Every curated underlying, or one exchange's, alphabetically."""
        filters: dict[str, Any] = {}
        if exchange:
            filters["exchange"] = exchange.strip().upper()
        rows = await SymbolsRepository(db).find(order_by="symbol", **filters)
        return ok([_wire(row) for row in rows])

    @router.get("/{symbol}")
    async def one_symbol(symbol: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await SymbolsRepository(db).get(symbol)
        if row is None:
            raise HTTPException(status_code=404, detail=f"no symbol {symbol!r}")
        return ok(_wire(row))

    @router.post("")
    async def create_symbol(
        body: NewSymbol, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        name = body.symbol.strip()
        symbols = SymbolsRepository(db)
        if await symbols.get(name) is not None:
            raise HTTPException(status_code=409, detail=f"{name} already exists")

        values = _values(body)
        await _require_exchange(db, values.get("exchange"))
        _refuse_what_the_loader_would_skip(values, name)

        row = models.SymbolsRow(symbol=name, **values)
        symbols.add(row)
        await db.commit()
        await db.refresh(row)
        await _took_effect(request)
        return ok(_wire(row), message=f"{name} added")

    @router.put("/{symbol}")
    async def update_symbol(
        symbol: str, body: SymbolEdit, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        symbols = SymbolsRepository(db)
        if await symbols.get(symbol) is None:
            raise HTTPException(status_code=404, detail=f"no symbol {symbol!r}")

        values = _values(body)
        await _require_exchange(db, values.get("exchange"))
        _refuse_what_the_loader_would_skip(values, symbol)
        if values:
            await symbols.update(symbol, **values)
            await db.commit()
            await _took_effect(request)
        return ok(_wire(await symbols.require(symbol)), message=f"{symbol} saved")

    @router.delete("/{symbol}")
    async def delete_symbol(
        symbol: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        # The per-broker overrides go with it: they are keyed by symbol and
        # would otherwise describe something that no longer exists.
        await SymbolBrokerInfoRepository(db).delete_where(symbol=symbol)
        if not await SymbolsRepository(db).delete(symbol):
            raise HTTPException(status_code=404, detail=f"no symbol {symbol!r}")
        await db.commit()
        await _took_effect(request)
        return ok(None, message=f"{symbol} removed")

    # -- one broker's freeze limit for this symbol ---------------------------

    @router.get("/{symbol}/brokers")
    async def list_broker_limits(
        symbol: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        rows = await SymbolBrokerInfoRepository(db).find(symbol=symbol, order_by="broker_name")
        return ok([_broker_wire(row) for row in rows])

    @router.post("/{symbol}/brokers")
    async def set_broker_limit(
        symbol: str, body: NewBrokerLimit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        broker = body.brokerName.strip().upper()
        if body.freezeLimitQty < 1:
            raise HTTPException(status_code=400, detail="freezeLimitQty must be at least one unit")
        if await SymbolsRepository(db).get(symbol) is None:
            raise HTTPException(status_code=404, detail=f"no symbol {symbol!r}")
        if await BrokersRepository(db).get(broker) is None:
            raise HTTPException(status_code=404, detail=f"no broker {body.brokerName!r}")

        limits = SymbolBrokerInfoRepository(db)
        if await limits.get(symbol, broker) is not None:
            raise HTTPException(
                status_code=409, detail=f"{broker} already has a limit for {symbol}"
            )
        row = models.SymbolBrokerInfoRow(
            symbol=symbol, broker_name=broker, freeze_limit_qty=body.freezeLimitQty
        )
        limits.add(row)
        await db.commit()
        return ok(_broker_wire(row), message=f"{broker} limited to {body.freezeLimitQty}")

    @router.put("/{symbol}/brokers/{broker}")
    async def update_broker_limit(
        symbol: str, broker: str, body: BrokerLimit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        if body.freezeLimitQty < 1:
            raise HTTPException(status_code=400, detail="freezeLimitQty must be at least one unit")
        limits = SymbolBrokerInfoRepository(db)
        key = (symbol, broker.strip().upper())
        if await limits.get(*key) is None:
            raise HTTPException(status_code=404, detail=f"{key[1]} has no limit for {symbol}")
        await limits.update(*key, freeze_limit_qty=body.freezeLimitQty)
        await db.commit()
        return ok(_broker_wire(await limits.require(*key)), message="limit saved")

    @router.delete("/{symbol}/brokers/{broker}")
    async def delete_broker_limit(
        symbol: str, broker: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        code = broker.strip().upper()
        if not await SymbolBrokerInfoRepository(db).delete(symbol, code):
            raise HTTPException(status_code=404, detail=f"{code} has no limit for {symbol}")
        await db.commit()
        return ok(None, message=f"{code} follows the exchange limit for {symbol} again")

    return router
