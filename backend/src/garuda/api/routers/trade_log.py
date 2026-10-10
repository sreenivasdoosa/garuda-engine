"""The trade log: what the engine did with each trade, in order.

`TRADE_LOG` and `TradeLogServletV2` in the reference engine. Three reads:
the log across trades, freshest first, filtered and paginated in SQL; one
trade's timeline, oldest first, so the Console draws it top to bottom; and
the filter choices -- the accounts, strategies and symbols the log actually
has, and the full event vocabulary.

The reference's user and broker filters are one filter here, the trading
client, as everywhere in garuda. Its free-text search covers the message,
the symbol, the order id and the strategy; garuda's adds the account's
display name, since that is what the operator types.

Times go out with their offset and come in as the operator wrote them: an
instant with an offset is taken as it is, and a bare date or local time is
read on the venue's clock, which is the only clock a trading day has.
"""

from __future__ import annotations

import datetime as dt
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.trade_log import TradeLogEventCategory, TradeLogEventType
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository, TradingClientsRepository
from garuda.protocols.clock import Clock

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500

type Labels = dict[str, tuple[str, str]]


def _iso(value: dt.datetime | None) -> str | None:
    return value.isoformat() if value else None


def _money(value: object) -> str | None:
    return str(value) if value is not None else None


def entry_wire(row: models.TradeLogRow, labels: Labels) -> dict[str, Any]:
    name, broker = labels.get(row.trading_client_id, (None, None))
    return {
        "id": row.id,
        "tradeId": row.trade_id,
        "tradingClientId": row.trading_client_id,
        "tradingClient": name,
        "broker": broker,
        "strategy": row.strategy,
        "tradingSymbol": row.trading_symbol,
        "hedgeCorrelationId": row.hedge_correlation_id,
        "eventCategory": row.event_category,
        "eventType": row.event_type,
        "eventTimestamp": _iso(row.event_timestamp),
        "orderId": row.order_id,
        "orderStatus": row.order_status,
        "orderType": row.order_type,
        "price": _money(row.price),
        "quantity": row.quantity,
        "filledQuantity": row.filled_quantity,
        "slPrice": _money(row.sl_price),
        "targetPrice": _money(row.target_price),
        "message": row.message,
        "details": row.details,
        "errorMessage": row.error_message,
        "createdAt": _iso(row.created_at),
    }


def _moment(
    value: str | None, zone: dt.tzinfo, *, name: str, end: bool = False
) -> dt.datetime | None:
    """Read a bound the way the operator meant it.

    A full instant with an offset is kept. A bare date is the start of that
    day on the venue's clock -- or, for the end bound, the start of the next,
    so "to 2026-10-10" includes the whole of the tenth. A local time without
    an offset is on the venue's clock too.
    """
    if value is None or not value.strip():
        return None
    text = value.strip().replace(" ", "T", 1)
    try:
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
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    return parsed


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    del clock  # the log is read, never dated, here
    router = APIRouter(prefix="/api/trade-log", tags=["trade-log"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _labels(db: AsyncSession) -> Labels:
        return {
            row.id: (row.display_name, row.broker)
            for row in await TradingClientsRepository(db).all()
        }

    async def _zone(db: AsyncSession) -> dt.tzinfo:
        """The venue's clock. UTC when no exchange names one."""
        for row in await ExchangesRepository(db).all(order_by="exchange_code"):
            if row.timezone:
                try:
                    return ZoneInfo(row.timezone)
                except ZoneInfoNotFoundError:
                    continue
        return dt.UTC

    @router.get("/filters")
    async def filters(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """What the dropdowns offer: what the log has, and every event there is."""
        log = models.TradeLogRow
        labels = await _labels(db)
        clients = list(
            (
                await db.execute(
                    select(log.trading_client_id).distinct().order_by(log.trading_client_id)
                )
            ).scalars()
        )
        strategies = list(
            (
                await db.execute(
                    select(log.strategy)
                    .where(log.strategy.is_not(None))
                    .distinct()
                    .order_by(log.strategy)
                )
            ).scalars()
        )
        symbols = list(
            (
                await db.execute(
                    select(log.trading_symbol)
                    .where(log.trading_symbol.is_not(None))
                    .distinct()
                    .order_by(log.trading_symbol)
                )
            ).scalars()
        )
        return ok(
            {
                "tradingClients": [
                    {
                        "id": client_id,
                        "displayName": labels.get(client_id, (client_id, None))[0],
                        "broker": labels.get(client_id, (None, None))[1],
                    }
                    for client_id in clients
                ],
                "strategies": strategies,
                "tradingSymbols": symbols,
                "eventCategories": [c.value for c in TradeLogEventCategory],
                "eventTypes": [t.value for t in TradeLogEventType],
                "typesByCategory": {
                    c.value: [t.value for t in TradeLogEventType if t.category is c]
                    for c in TradeLogEventCategory
                },
            }
        )

    @router.get("/trade/{trade_id}")
    async def timeline(trade_id: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every event of one trade, oldest first."""
        log = models.TradeLogRow
        rows = list(
            (
                await db.execute(
                    select(log)
                    .where(log.trade_id == trade_id.strip())
                    .order_by(log.event_timestamp.asc(), log.id.asc())
                )
            ).scalars()
        )
        labels = await _labels(db)
        return ok([entry_wire(r, labels) for r in rows], count=len(rows))

    @router.get("")
    async def entries(
        db: AsyncSession = Depends(session),
        page: int = Query(default=1, ge=1),
        pageSize: int = Query(default=DEFAULT_PAGE_SIZE, ge=1, le=MAX_PAGE_SIZE),  # noqa: N803
        tradeId: str | None = Query(default=None),  # noqa: N803
        tradingClientId: str | None = Query(default=None),  # noqa: N803
        strategy: str | None = Query(default=None),
        tradingSymbol: str | None = Query(default=None),  # noqa: N803
        eventCategory: str | None = Query(default=None),  # noqa: N803
        eventType: str | None = Query(default=None),  # noqa: N803
        startTime: str | None = Query(default=None),  # noqa: N803
        endTime: str | None = Query(default=None),  # noqa: N803
        search: str | None = Query(default=None),
    ) -> dict[str, Any]:
        """The log across trades, freshest first, filtered in SQL."""
        log = models.TradeLogRow
        labels = await _labels(db)
        zone = await _zone(db)
        conditions: list[Any] = []
        if tradeId and tradeId.strip():
            conditions.append(log.trade_id == tradeId.strip())
        if tradingClientId and tradingClientId.strip():
            conditions.append(log.trading_client_id == tradingClientId.strip())
        if strategy and strategy.strip():
            conditions.append(log.strategy == strategy.strip())
        if tradingSymbol and tradingSymbol.strip():
            conditions.append(log.trading_symbol == tradingSymbol.strip().upper())
        if eventCategory and eventCategory.strip():
            conditions.append(log.event_category == eventCategory.strip().upper())
        if eventType and eventType.strip():
            conditions.append(log.event_type == eventType.strip().upper())
        since = _moment(startTime, zone, name="startTime")
        until = _moment(endTime, zone, name="endTime", end=True)
        if since is not None:
            conditions.append(log.event_timestamp >= since)
        if until is not None:
            # A date bound excludes the next day's start; an instant is
            # inclusive, as the reference's was.
            comparison = (
                log.event_timestamp < until
                if endTime and len(endTime.strip()) == 10
                else log.event_timestamp <= until
            )
            conditions.append(comparison)
        if search and search.strip():
            needle = search.strip()
            like = f"%{needle}%"
            matching_clients = [
                client_id
                for client_id, (name, _broker) in labels.items()
                if needle.lower() in (name or "").lower()
            ]
            alternatives = [
                log.message.ilike(like),
                log.trading_symbol.ilike(like),
                log.order_id.ilike(like),
                log.strategy.ilike(like),
            ]
            if matching_clients:
                alternatives.append(log.trading_client_id.in_(matching_clients))
            conditions.append(or_(*alternatives))

        total = int(
            (
                await db.execute(select(func.count()).select_from(log).where(*conditions))
            ).scalar_one()
        )
        rows = list(
            (
                await db.execute(
                    select(log)
                    .where(*conditions)
                    .order_by(log.event_timestamp.desc(), log.id.desc())
                    .offset((page - 1) * pageSize)
                    .limit(pageSize)
                )
            ).scalars()
        )
        pages = max(1, -(-total // pageSize))
        return ok(
            {
                "entries": [entry_wire(r, labels) for r in rows],
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
