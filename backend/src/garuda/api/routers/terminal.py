"""The Terminal: what each account holds, what it made, and the brake.

The first page where an operator sees what the engine did rather than reads
the log. Everything here reads the engine's own book through the terminal
view the composition root hands the app; nothing asks the broker unless the
operator presses the button for it.

**Money crosses as strings.** The engine's P&L is an exact decimal and JSON
has only floats; a total that arrives as 1234.5699999999999 has been
corrupted at the last possible moment. The page formats, never computes.

**Square-off is the operator's hand on the brake**, and it goes through the
same square-off service the day model uses at the close, so an operator's
exit is placed, retried and alerted exactly as a scheduled one is.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from garuda.api.envelope import ok
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.money import Money
from garuda.domain.trade import Trade
from garuda.protocols.broker import BrokerPosition, Funds

logger = logging.getLogger(__name__)


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _money(value: Money | None) -> str | None:
    return None if value is None else str(value.amount)


def summary_wire(row: Any) -> dict[str, Any]:
    def counts(c: Any) -> dict[str, int]:
        return {
            "open": c.open,
            "active": c.active,
            "completed": c.completed,
            "cancelled": c.cancelled,
            "failed": c.failed,
        }

    def pnl(p: Any) -> dict[str, Any]:
        return {
            "realised": _money(p.realised),
            "unrealised": _money(p.unrealised),
            "total": _money(p.total),
            "unpriced": p.unpriced,
        }

    return {
        "tradingClientId": row.trading_client_id.value,
        "displayName": row.display_name,
        "broker": row.broker,
        "clientId": row.client_id,
        "isTrading": row.is_trading,
        "unavailableBecause": row.unavailable_because,
        "counts": counts(row.counts),
        "paperCounts": counts(row.paper_counts),
        "pnl": pnl(row.pnl),
        "paperPnl": pnl(row.paper_pnl),
        "positions": row.positions,
        "paperPositions": row.paper_positions,
        "asOf": _iso(row.as_of),
    }


def trade_wire(trade: Trade) -> dict[str, Any]:
    return {
        "tradeId": trade.id.value,
        "instrument": trade.instrument.value,
        "tradingSymbol": trade.instrument.value.split(":", 1)[-1],
        "strategy": trade.strategy,
        "group": trade.group,
        "direction": trade.direction.value,
        "product": trade.product.value,
        "state": trade.state.value,
        "quantity": trade.quantity,
        "filledQuantity": trade.filled_quantity,
        "entry": _money(trade.entry),
        "exit": _money(trade.exit),
        "exitReason": trade.exit_reason.value if trade.exit_reason else None,
        "exitingFor": trade.exiting_for.value if trade.exiting_for else None,
        "failureReason": trade.failure_reason,
        "realisedPnl": _money(trade.realised_pnl),
        "stopLoss": _money(trade.protection.stop_loss),
        "target": _money(trade.protection.target),
        "isPaper": trade.is_paper,
        "isHedge": trade.relationships.is_hedge,
        "startedAt": _iso(trade.started_at),
        "endedAt": _iso(trade.ended_at),
        "remarks": trade.remarks,
    }


def position_wire(row: Any) -> dict[str, Any]:
    return {
        "instrument": row.instrument.value,
        "tradingSymbol": row.instrument.value.split(":", 1)[-1],
        "exchange": row.instrument.value.split(":", 1)[0],
        "product": row.product.value,
        "isPaper": row.is_paper,
        "buyQuantity": row.buy_quantity,
        "sellQuantity": row.sell_quantity,
        "netQuantity": row.net_quantity,
        "buyAverage": _money(row.buy_average),
        "sellAverage": _money(row.sell_average),
        "lastPrice": _money(row.last_price),
        "realised": _money(row.realised),
        "unrealised": _money(row.unrealised),
        "tradeIds": list(row.trade_ids),
    }


def broker_position_wire(position: BrokerPosition) -> dict[str, Any]:
    return {
        "instrument": position.instrument.value,
        "tradingSymbol": position.instrument.value.split(":", 1)[-1],
        "exchange": position.instrument.value.split(":", 1)[0],
        "quantity": position.quantity,
        "averagePrice": _money(position.average_price),
        "product": position.product.value,
        "multiplier": str(position.multiplier),
    }


def funds_wire(funds: Funds) -> dict[str, Any]:
    return {
        "available": _money(funds.available),
        "used": _money(funds.used),
        "total": _money(funds.total),
    }


def alert_wire(alert: Alert) -> dict[str, Any]:
    return {
        "timestamp": alert.raised_at.isoformat(),
        "alertLevel": alert.level.value,
        "entityType": alert.entity_type.value,
        "entityName": alert.entity,
        "operation": alert.operation,
        "alertMessage": alert.message,
        "occurrences": alert.occurrences,
        "key": alert.key,
    }


class SquareOffBody(BaseModel):
    #: ALL, INTRADAY or POSITIONAL.
    product: str = "ALL"
    strategies: list[str] | None = None


def _view(request: Request) -> Any:
    engine = request.app.state.engine
    if engine is None:
        raise HTTPException(
            status_code=503,
            detail="the API is running without an engine, so there is nothing to show",
        )
    view = getattr(request.app.state, "terminal", None)
    if view is None:
        raise HTTPException(status_code=503, detail="the engine has not attached a terminal view")
    return view


def _client_id(value: str) -> TradingClientId:
    try:
        return TradingClientId(value.strip())
    except DomainError as error:
        raise HTTPException(status_code=400, detail=str(error)) from None


def _refuse(error: Exception) -> HTTPException:
    """The view's refusals, as the Console should see them."""
    name = type(error).__name__
    if name == "UnknownAccountError":
        return HTTPException(status_code=404, detail=str(error))
    if name == "AccountNotTradingError":
        return HTTPException(status_code=409, detail=str(error))
    if isinstance(error, ValueError):
        return HTTPException(status_code=400, detail=str(error))
    raise error


def build() -> APIRouter:
    router = APIRouter(prefix="/api/terminal", tags=["terminal"])

    @router.get("/summaries")
    async def summaries(request: Request) -> dict[str, Any]:
        rows = _view(request).summaries()
        return ok([summary_wire(row) for row in rows], count=len(rows))

    @router.get("/alerts")
    async def alerts(request: Request) -> dict[str, Any]:
        """Today's open alerts, newest first."""
        engine = request.app.state.engine
        if engine is None:
            raise HTTPException(status_code=503, detail="no engine, so no alerts")
        parts = engine.parts
        now = parts.clock.now()
        venues = parts.exchanges
        day = venues[0].trading_day_for(now) if venues else now.date()
        raised = sorted(parts.alerts.open_alerts(day), key=lambda a: a.raised_at, reverse=True)
        return ok([alert_wire(alert) for alert in raised], count=len(raised))

    @router.get("/clients/{trading_client_id}")
    async def details(trading_client_id: str, request: Request) -> dict[str, Any]:
        """The account's trades, grouped, and its positions as the engine sees them."""
        view = _view(request)
        client_id = _client_id(trading_client_id)
        try:
            summary = view.summary(client_id)
            if not summary.is_trading:
                return ok(
                    {
                        "summary": summary_wire(summary),
                        "trades": None,
                        "positions": [],
                    },
                    message=summary.unavailable_because,
                )
            trades = view.trades(client_id)
            positions = view.positions(client_id)
        except (LookupError, RuntimeError, ValueError) as error:
            raise _refuse(error) from None
        return ok(
            {
                "summary": summary_wire(summary),
                "trades": {
                    "open": [trade_wire(t) for t in trades.open],
                    "active": [trade_wire(t) for t in trades.active],
                    "completed": [trade_wire(t) for t in trades.completed],
                    "cancelled": [trade_wire(t) for t in trades.cancelled],
                    "failed": [trade_wire(t) for t in trades.failed],
                },
                "positions": [position_wire(p) for p in positions],
            }
        )

    @router.get("/clients/{trading_client_id}/broker-positions")
    async def broker_positions(trading_client_id: str, request: Request) -> dict[str, Any]:
        """The broker's own view, fetched now. On demand only."""
        view = _view(request)
        try:
            positions = await view.broker_positions(_client_id(trading_client_id))
        except (LookupError, RuntimeError, ValueError) as error:
            raise _refuse(error) from None
        except Exception as error:
            raise HTTPException(
                status_code=502,
                detail=f"the broker did not answer: {type(error).__name__}: {error}",
            ) from None
        return ok([broker_position_wire(p) for p in positions], count=len(positions))

    @router.get("/clients/{trading_client_id}/margins")
    async def margins(trading_client_id: str, request: Request) -> dict[str, Any]:
        view = _view(request)
        try:
            funds = await view.margins(_client_id(trading_client_id))
        except (LookupError, RuntimeError, ValueError) as error:
            raise _refuse(error) from None
        except Exception as error:
            raise HTTPException(
                status_code=502,
                detail=f"the broker did not answer: {type(error).__name__}: {error}",
            ) from None
        return ok(funds_wire(funds))

    @router.post("/clients/{trading_client_id}/square-off")
    async def square_off(
        trading_client_id: str, body: SquareOffBody, request: Request
    ) -> dict[str, Any]:
        view = _view(request)
        try:
            report = await view.square_off(
                _client_id(trading_client_id),
                product=body.product,
                strategies=body.strategies,
            )
        except (LookupError, RuntimeError, ValueError) as error:
            raise _refuse(error) from None
        logger.warning(
            "operator square-off on %s (%s): %d requested",
            trading_client_id,
            body.product,
            len(report.requested),
        )
        return ok(
            {"requested": list(report.requested), "skipped": report.skipped},
            message=f"{len(report.requested)} exit(s) requested",
        )

    @router.post("/clients/{trading_client_id}/trades/{trade_id}/square-off")
    async def square_off_trade(
        trading_client_id: str, trade_id: str, request: Request
    ) -> dict[str, Any]:
        view = _view(request)
        try:
            report = await view.square_off(_client_id(trading_client_id), trade_id=trade_id)
        except (LookupError, RuntimeError, ValueError) as error:
            raise _refuse(error) from None
        if trade_id in report.skipped:
            raise HTTPException(status_code=409, detail=f"{trade_id}: {report.skipped[trade_id]}")
        return ok(
            {"requested": list(report.requested), "skipped": report.skipped},
            message=f"exit requested for {trade_id}",
        )

    return router
