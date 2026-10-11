"""Analytics: one question, any combination of inputs, one answer.

The reference's four pages and twenty routes become one: the operator
picks accounts, strategies, products, live or paper and a range, chooses
what to group by, and presses Submit. The answer is the groups measured,
the whole measured, and the cumulative line. Everything reads the same
trade rows the reports do, so the two never disagree.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.api.routers.reports import _split, account_labels, select_trades
from garuda.domain.money import Money
from garuda.protocols.clock import Clock
from garuda.reports.analytics import Analysis, Bucket, GroupBy, Point, analyse


def _money(value: Money | None) -> str | None:
    return None if value is None else str(value.amount)


def bucket_wire(
    bucket: Bucket, labels: dict[str, tuple[str, str]], group_by: GroupBy
) -> dict[str, Any]:
    label = bucket.key
    if group_by is GroupBy.ACCOUNT and bucket.key in labels:
        label = labels[bucket.key][0]
    return {
        "key": bucket.key,
        "label": label,
        "trades": bucket.trades,
        "wins": bucket.wins,
        "losses": bucket.losses,
        "flat": bucket.flat,
        "winRate": None if bucket.win_rate is None else str(bucket.win_rate),
        "grossPnl": str(bucket.gross_pnl.amount),
        "averageTrade": _money(bucket.average_trade),
        "averageWin": _money(bucket.average_win),
        "averageLoss": _money(bucket.average_loss),
        "best": _money(bucket.best),
        "worst": _money(bucket.worst),
        "maxDrawdown": str(bucket.max_drawdown.amount),
        "profitFactor": None if bucket.profit_factor is None else str(bucket.profit_factor),
    }


def point_wire(point: Point) -> dict[str, Any]:
    return {
        "tradingDay": point.trading_day.isoformat(),
        "dayPnl": str(point.day_pnl.amount),
        "cumulative": str(point.cumulative.amount),
        "trades": point.trades,
    }


def analysis_wire(
    analysis: Analysis, labels: dict[str, tuple[str, str]], *, start: dt.date, end: dt.date
) -> dict[str, Any]:
    return {
        "fromDate": start.isoformat(),
        "toDate": end.isoformat(),
        "groupBy": analysis.group_by.value,
        "overall": bucket_wire(analysis.overall, labels, analysis.group_by),
        "groups": [bucket_wire(g, labels, analysis.group_by) for g in analysis.groups],
        "curve": [point_wire(p) for p in analysis.curve],
    }


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/analytics", tags=["analytics"])

    async def session() -> Any:
        async with sessions() as db:
            yield db

    @router.get("/options")
    async def options(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """What the page may choose from, and how it may group."""
        labels = await account_labels(db)
        return ok(
            {
                "groupBy": [g.value for g in GroupBy],
                "tradingClients": [
                    {"id": client_id, "displayName": name, "broker": broker}
                    for client_id, (name, broker) in sorted(
                        labels.items(), key=lambda item: item[1][0].lower()
                    )
                ],
                "brokers": sorted({broker.lower() for _n, broker in labels.values()}),
            }
        )

    @router.get("/query")
    async def query(
        fromDate: str | None = None,  # noqa: N803
        toDate: str | None = None,  # noqa: N803
        tradingClientIds: str | None = None,  # noqa: N803
        brokers: str | None = None,
        strategies: str | None = None,
        products: str | None = None,
        paper: str | None = None,
        groupBy: str = "day",  # noqa: N803
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        """The question, as the page asked it. Lists are comma-separated, any of."""
        try:
            grouping = GroupBy(groupBy.strip().lower())
        except ValueError:
            choices = ", ".join(g.value for g in GroupBy)
            raise HTTPException(
                status_code=400, detail=f"{groupBy!r} is not a grouping; one of {choices}"
            ) from None
        labels = await account_labels(db)
        accounts = _split(tradingClientIds)
        wanted_brokers = {b.lower() for b in _split(brokers)}
        if wanted_brokers:
            # A broker is a property of its accounts; the filter is those accounts.
            of_broker = [
                client_id
                for client_id, (_n, broker) in labels.items()
                if broker.lower() in wanted_brokers
            ]
            accounts = [a for a in accounts if a in of_broker] if accounts else of_broker
            if not accounts:
                accounts = ["--none--"]
        chosen = await select_trades(
            db,
            clock,
            from_date=fromDate,
            to_date=toDate,
            trading_client_ids=accounts,
            strategies=_split(strategies),
            products=_split(products),
            paper=paper,
            state="COMPLETED",
        )
        broker_of = {client_id: broker.lower() for client_id, (_n, broker) in labels.items()}
        analysis = analyse(chosen.rows, grouping, brokers=broker_of)
        return ok(analysis_wire(analysis, labels, start=chosen.start, end=chosen.end))

    return router
