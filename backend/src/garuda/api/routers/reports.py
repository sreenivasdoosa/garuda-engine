"""Reports: the trades, and the day's P&L.

Two reports over one source, the trades table, which the engine writes as
it goes: one row per trade, and the same rows summed by the day each
trade ended. The reference reads its daily report from an end-of-day
table it writes; garuda writes that table too, at the REPORTS phase, but
the page reads the trades themselves so a report is right the minute a
trade closes, not after the day's job.

The filters are applied before any grouping, the reference's rule: a
daily row means "this day, for whatever was selected", and the owner's
strategy-wise view only splits a day further. CSV and Excel exports carry
the same rows.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.api.exports import file_response
from garuda.domain.enums import ProductType
from garuda.domain.money import Money
from garuda.domain.trade import Trade
from garuda.domain.trade_serde import decode_trade
from garuda.domain.trade_state import TradeState
from garuda.persistence import models
from garuda.persistence.repositories import ExchangesRepository, TradingClientsRepository
from garuda.protocols.clock import Clock
from garuda.reports.trades import DailyRow, Totals, TradeRow, daily_rows, totals_of, trade_row

logger = logging.getLogger(__name__)

#: A report, not a page: everything that matches, up to a bound.
MAX_TRADES = 5000
DEFAULT_SPAN = dt.timedelta(days=30)

type Labels = dict[str, tuple[str, str]]


def _money(value: Money | None) -> str | None:
    return None if value is None else str(value.amount)


def _iso(moment: dt.datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def trade_wire(row: TradeRow, labels: Labels) -> dict[str, Any]:
    name, broker = labels.get(row.trading_client_id, (None, None))
    return {
        "tradeId": row.trade_id,
        "tradingClientId": row.trading_client_id,
        "tradingClient": name,
        "broker": broker,
        "strategy": row.strategy,
        "instrumentId": row.instrument_id,
        "tradingSymbol": row.instrument_id.split(":", 1)[-1],
        "product": row.product,
        "direction": row.direction,
        "isPaper": row.is_paper,
        "state": row.state,
        "quantity": row.quantity,
        "filledQuantity": row.filled_quantity,
        "entry": _money(row.entry),
        "exit": _money(row.exit),
        "startedAt": _iso(row.started_at),
        "endedAt": _iso(row.ended_at),
        "tradingDay": row.trading_day.isoformat() if row.trading_day else None,
        "exitReason": row.exit_reason,
        "failureReason": row.failure_reason,
        "grossPnl": _money(row.gross_pnl),
        # Not computed until the charges phase; null, never a zero.
        "charges": None,
        "netPnl": _money(row.gross_pnl),
        "group": row.group,
        "tranche": row.tranche,
    }


def totals_wire(totals: Totals) -> dict[str, Any]:
    return {
        "trades": totals.trades,
        "closed": totals.closed,
        "wins": totals.wins,
        "losses": totals.losses,
        "flat": totals.flat,
        "winRate": None if totals.win_rate is None else str(totals.win_rate),
        "grossPnl": _money(totals.gross_pnl),
        "charges": None,
        "netPnl": _money(totals.gross_pnl),
        "best": _money(totals.best),
        "worst": _money(totals.worst),
    }


def daily_wire(row: DailyRow, labels: Labels) -> dict[str, Any]:
    name, broker = labels.get(row.trading_client_id or "", (None, None))
    return {
        "tradingDay": row.trading_day.isoformat(),
        "tradingClientId": row.trading_client_id,
        "tradingClient": name,
        "broker": broker,
        "strategy": row.strategy,
        "product": row.product,
        "isPaper": row.is_paper,
        "trades": row.trades,
        "wins": row.wins,
        "losses": row.losses,
        "grossPnl": str(row.gross_pnl.amount),
        "charges": _money(row.charges),
        "netPnl": str(row.net_pnl.amount),
    }


def _day(value: str | None, *, name: str) -> dt.date | None:
    if value is None or not value.strip():
        return None
    try:
        return dt.date.fromisoformat(value.strip())
    except ValueError:
        raise HTTPException(
            status_code=400, detail=f"{name}: {value!r} is not a date (YYYY-MM-DD)"
        ) from None


def _flag(value: str | None, *, name: str) -> bool | None:
    """``paper`` or ``live``; anything else is everything."""
    if value is None or not value.strip() or value.strip().lower() == "all":
        return None
    lowered = value.strip().lower()
    if lowered in ("paper", "true", "1"):
        return True
    if lowered in ("live", "false", "0"):
        return False
    raise HTTPException(status_code=400, detail=f"{name}: {value!r} is not paper, live or all")


def _split(value: str | None) -> list[str]:
    """A comma-separated list, or nothing. ``all`` is nothing too."""
    if value is None:
        return []
    parts = [part.strip() for part in value.split(",") if part.strip()]
    return [] if any(part.lower() == "all" for part in parts) else parts


@dataclass(frozen=True, slots=True)
class TradeSelection:
    """What the filters chose, and the range they cover."""

    rows: list[TradeRow]
    zone: dt.tzinfo
    start: dt.date
    end: dt.date


async def venue_zone(db: AsyncSession) -> dt.tzinfo:
    for row in await ExchangesRepository(db).all(order_by="exchange_code"):
        if row.timezone:
            try:
                return ZoneInfo(row.timezone)
            except ZoneInfoNotFoundError:
                continue
    return dt.UTC


async def select_trades(
    db: AsyncSession,
    clock: Clock,
    *,
    from_date: str | None = None,
    to_date: str | None = None,
    trading_client_ids: Sequence[str] = (),
    strategies: Sequence[str] = (),
    products: Sequence[str] = (),
    paper: str | None = None,
    state: str | None = None,
) -> TradeSelection:
    """The trades the filters select, as rows, with the range they cover.

    A trade is placed in the range by the day it ended, or started if it
    has not ended -- the day it counts on. Every list filter is "any of";
    an empty list is no filter.
    """
    zone = await venue_zone(db)
    today = clock.now().astimezone(zone).date()
    end = _day(to_date, name="toDate") or today
    start = _day(from_date, name="fromDate") or (end - DEFAULT_SPAN)
    if end < start:
        raise HTTPException(status_code=400, detail="toDate is before fromDate")
    lower = dt.datetime.combine(start, dt.time.min, tzinfo=zone)
    upper = dt.datetime.combine(end + dt.timedelta(days=1), dt.time.min, tzinfo=zone)
    table = models.LiveTradesRow
    counted_on = func.coalesce(table.end_timestamp, table.start_timestamp)
    statement = (
        select(table)
        .where(counted_on >= lower)
        .where(counted_on < upper)
        .order_by(counted_on.desc())
        .limit(MAX_TRADES)
    )
    if trading_client_ids:
        statement = statement.where(table.trading_client_id.in_(list(trading_client_ids)))
    if strategies:
        statement = statement.where(table.strategy_name.in_(list(strategies)))
    if products:
        wanted = [p.strip().upper() for p in products]
        known = {p.value for p in ProductType}
        for product in wanted:
            if product not in known:
                raise HTTPException(status_code=400, detail=f"{product!r} is not a product")
        statement = statement.where(table.product.in_(wanted))
    is_paper = _flag(paper, name="paper")
    if is_paper is not None:
        statement = statement.where(table.is_paper_trading.is_(is_paper))
    if state and state.strip().lower() != "all":
        wanted_state = state.strip().upper()
        if wanted_state == "CLOSED":
            statement = statement.where(or_(table.state == "COMPLETED", table.state == "CANCELLED"))
        elif wanted_state in {s.value for s in TradeState}:
            statement = statement.where(table.state == wanted_state)
        else:
            raise HTTPException(status_code=400, detail=f"{state!r} is not a trade state")
    rows: list[TradeRow] = []
    for stored in (await db.execute(statement)).scalars():
        try:
            trade: Trade = decode_trade(stored.payload)
        except Exception:
            logger.exception("trade %s could not be read for the report", stored.trade_id)
            continue
        rows.append(trade_row(trade, zone))
    return TradeSelection(rows=rows, zone=zone, start=start, end=end)


async def account_labels(db: AsyncSession) -> Labels:
    return {
        row.id: (row.display_name, row.broker) for row in await TradingClientsRepository(db).all()
    }


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/reports", tags=["reports"])

    async def session() -> Any:
        async with sessions() as db:
            yield db

    async def _labels(db: AsyncSession) -> Labels:
        return await account_labels(db)

    async def _trades(
        db: AsyncSession,
        *,
        from_date: str | None,
        to_date: str | None,
        trading_client_id: str | None,
        strategy: str | None,
        product: str | None,
        paper: str | None,
        state: str | None,
    ) -> tuple[list[TradeRow], dt.tzinfo, dt.date, dt.date]:
        chosen = await select_trades(
            db,
            clock,
            from_date=from_date,
            to_date=to_date,
            trading_client_ids=_split(trading_client_id),
            strategies=_split(strategy),
            products=_split(product),
            paper=paper,
            state=state,
        )
        return chosen.rows, chosen.zone, chosen.start, chosen.end

    @router.get("/filters")
    async def filters(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """What the dropdowns offer: accounts, and every strategy that traded."""
        table = models.LiveTradesRow
        strategies = sorted(
            s for s in (await db.execute(select(table.strategy_name).distinct())).scalars() if s
        )
        labels = await _labels(db)
        return ok(
            {
                "tradingClients": [
                    {"id": client_id, "displayName": name, "broker": broker}
                    for client_id, (name, broker) in sorted(
                        labels.items(), key=lambda item: item[1][0].lower()
                    )
                ],
                "strategies": strategies,
                "products": [p.value for p in ProductType],
                "states": ["CLOSED", *(s.value for s in TradeState)],
            }
        )

    @router.get("/trades")
    async def trades(
        fromDate: str | None = None,  # noqa: N803
        toDate: str | None = None,  # noqa: N803
        tradingClientId: str | None = None,  # noqa: N803
        strategy: str | None = None,
        product: str | None = None,
        paper: str | None = None,
        state: str | None = None,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """One row per trade, newest first, and what they add up to."""
        rows, _, start, end = await _trades(
            db,
            from_date=fromDate,
            to_date=toDate,
            trading_client_id=tradingClientId,
            strategy=strategy,
            product=product,
            paper=paper,
            state=state,
        )
        labels = await _labels(db)
        return ok(
            {
                "fromDate": start.isoformat(),
                "toDate": end.isoformat(),
                "rows": [trade_wire(r, labels) for r in rows],
                "totals": totals_wire(totals_of(rows)),
                "truncated": len(rows) >= MAX_TRADES,
            }
        )

    @router.get("/daily-pnl")
    async def daily_pnl(
        fromDate: str | None = None,  # noqa: N803
        toDate: str | None = None,  # noqa: N803
        tradingClientId: str | None = None,  # noqa: N803
        strategy: str | None = None,
        product: str | None = None,
        paper: str | None = None,
        byStrategy: bool = False,  # noqa: N803
        byAccount: bool = False,  # noqa: N803
        byProduct: bool = False,  # noqa: N803
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """Closed trades summed by the day they ended, newest first.

        One strategy or all through ``strategy``; a row per strategy within
        each day through ``byStrategy``, the owner's strategy-wise view.
        """
        rows, _, start, end = await _trades(
            db,
            from_date=fromDate,
            to_date=toDate,
            trading_client_id=tradingClientId,
            strategy=strategy,
            product=product,
            paper=paper,
            state="COMPLETED",
        )
        labels = await _labels(db)
        days = daily_rows(rows, by_strategy=byStrategy, by_account=byAccount, by_product=byProduct)
        return ok(
            {
                "fromDate": start.isoformat(),
                "toDate": end.isoformat(),
                "rows": [daily_wire(d, labels) for d in days],
                "totals": totals_wire(totals_of(rows)),
                "tradingDays": len({d.trading_day for d in days}),
            }
        )

    # -- files -------------------------------------------------------------------

    @router.get("/trades/export")
    async def export_trades(
        fromDate: str | None = None,  # noqa: N803
        toDate: str | None = None,  # noqa: N803
        tradingClientId: str | None = None,  # noqa: N803
        strategy: str | None = None,
        product: str | None = None,
        paper: str | None = None,
        state: str | None = None,
        format: str = Query(default="csv"),
        db: AsyncSession = Depends(session),
    ) -> Response:
        rows, _, start, end = await _trades(
            db,
            from_date=fromDate,
            to_date=toDate,
            trading_client_id=tradingClientId,
            strategy=strategy,
            product=product,
            paper=paper,
            state=state,
        )
        labels = await _labels(db)
        header = [
            "Trade",
            "Account",
            "Broker",
            "Strategy",
            "Symbol",
            "Product",
            "Direction",
            "Paper",
            "State",
            "Quantity",
            "Filled",
            "Entry",
            "Exit",
            "Started",
            "Ended",
            "Trading day",
            "Exit reason",
            "Gross P&L",
        ]
        cells: list[Sequence[Any]] = []
        for r in rows:
            name, broker = labels.get(r.trading_client_id, (r.trading_client_id, ""))
            cells.append(
                [
                    r.trade_id,
                    name,
                    broker,
                    r.strategy,
                    r.instrument_id.split(":", 1)[-1],
                    r.product,
                    r.direction,
                    "yes" if r.is_paper else "no",
                    r.state,
                    r.quantity,
                    r.filled_quantity,
                    r.entry.amount if r.entry else None,
                    r.exit.amount if r.exit else None,
                    r.started_at,
                    r.ended_at,
                    r.trading_day,
                    r.exit_reason,
                    r.gross_pnl.amount if r.gross_pnl else None,
                ]
            )
        return file_response(
            format, name=f"trades_{start.isoformat()}_{end.isoformat()}", header=header, rows=cells
        )

    @router.get("/daily-pnl/export")
    async def export_daily(
        fromDate: str | None = None,  # noqa: N803
        toDate: str | None = None,  # noqa: N803
        tradingClientId: str | None = None,  # noqa: N803
        strategy: str | None = None,
        product: str | None = None,
        paper: str | None = None,
        byStrategy: bool = False,  # noqa: N803
        byAccount: bool = False,  # noqa: N803
        byProduct: bool = False,  # noqa: N803
        format: str = Query(default="csv"),
        db: AsyncSession = Depends(session),
    ) -> Response:
        rows, _, start, end = await _trades(
            db,
            from_date=fromDate,
            to_date=toDate,
            trading_client_id=tradingClientId,
            strategy=strategy,
            product=product,
            paper=paper,
            state="COMPLETED",
        )
        labels = await _labels(db)
        days = daily_rows(rows, by_strategy=byStrategy, by_account=byAccount, by_product=byProduct)
        header = [
            "Trading day",
            "Account",
            "Strategy",
            "Product",
            "Paper",
            "Trades",
            "Wins",
            "Losses",
            "Gross P&L",
            "Charges",
            "Net P&L",
        ]
        cells = [
            [
                d.trading_day,
                labels.get(d.trading_client_id or "", (d.trading_client_id or "all", ""))[0],
                d.strategy or "all",
                d.product or "all",
                "yes" if d.is_paper else "no",
                d.trades,
                d.wins,
                d.losses,
                d.gross_pnl.amount,
                d.charges.amount if d.charges else None,
                d.net_pnl.amount,
            ]
            for d in days
        ]
        return file_response(
            format,
            name=f"daily_pnl_{start.isoformat()}_{end.isoformat()}",
            header=header,
            rows=cells,
        )

    return router
