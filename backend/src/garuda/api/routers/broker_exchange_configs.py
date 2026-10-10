"""Broker exchange configs: how an order is protected, per broker and venue.

`BROKER_EXCHANGE_CONFIG` in the reference engine. One row per (broker,
venue) says whether raw market orders may go out and how far from the live
price a protected order sits in each segment; the order path reads it on
every placement (`composition.protection`).

**A row written here is read by the next order.** The engine re-reads the
table into its book after every write, so nothing waits for a restart.

Three of the reference's columns are served and read by nothing: the login
and square-off minutes. Garuda takes the venue's day from the Exchanges
page, where those offsets are edited; they stay on this row because the
reference's did and the page shows them. `POSITIONAL_SQUAREOFF_MINUTES` is
not on the row at all -- when a carry-forward position exits is the
strategy's business -- and is served as null.

**A zero is unset.** The engine then uses the segment's code default, and
the page shows that default dimmed, so what the operator sees is what runs.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    BrokerExchangeConfigRepository,
    BrokersRepository,
    ExchangesRepository,
)

logger = logging.getLogger(__name__)


def _number(value: Decimal | None) -> float:
    return float(value) if value is not None else 0.0


def wire(row: models.BrokerExchangeConfigRow) -> dict[str, Any]:
    return {
        "brokerName": row.broker_name,
        "exchangeCode": row.exchange_code,
        "loginMinutesBeforeMarketOpen": row.login_minutes_before_market_open,
        "intradaySquareOffMinutesBeforeClose": row.intraday_squareoff_minutes_before_close,
        "intradaySquareOffBlockMinutesBeforeClose": (
            row.intraday_squareoff_block_minutes_before_close
        ),
        "positionalSquareOffMinutesBeforeClose": None,
        "marketOrdersAllowed": bool(row.market_orders_allowed),
        "limitOrderBufferPercentageEquity": _number(row.limit_order_buffer_equity),
        "limitOrderBufferPercentageFutures": _number(row.limit_order_buffer_futures),
        "limitOrderBufferPercentageOptions": _number(row.limit_order_buffer_options),
        "slTriggerToLimitGapPercentageEquity": _number(row.sl_trigger_to_limit_gap_equity),
        "slTriggerToLimitGapPercentageFutures": _number(row.sl_trigger_to_limit_gap_futures),
        "slTriggerToLimitGapPercentageOptions": _number(row.sl_trigger_to_limit_gap_options),
        "naicCode": row.naic_code,
        "algoId": row.algo_id,
    }


class ConfigEdit(BaseModel):
    loginMinutesBeforeMarketOpen: int | None = None  # noqa: N815 -- the Console's names
    intradaySquareOffMinutesBeforeClose: int | None = None  # noqa: N815
    intradaySquareOffBlockMinutesBeforeClose: int | None = None  # noqa: N815
    positionalSquareOffMinutesBeforeClose: int | None = None  # noqa: N815
    marketOrdersAllowed: bool | None = None  # noqa: N815
    limitOrderBufferPercentageEquity: float | None = None  # noqa: N815
    limitOrderBufferPercentageFutures: float | None = None  # noqa: N815
    limitOrderBufferPercentageOptions: float | None = None  # noqa: N815
    slTriggerToLimitGapPercentageEquity: float | None = None  # noqa: N815
    slTriggerToLimitGapPercentageFutures: float | None = None  # noqa: N815
    slTriggerToLimitGapPercentageOptions: float | None = None  # noqa: N815
    naicCode: str | None = None  # noqa: N815
    algoId: str | None = None  # noqa: N815


class NewConfig(ConfigEdit):
    brokerName: str = Field(min_length=1, max_length=30)  # noqa: N815
    exchangeCode: str = Field(min_length=1, max_length=10)  # noqa: N815


#: Wire name -> column, for the numbers protection reads.
_PERCENTS = {
    "limitOrderBufferPercentageEquity": "limit_order_buffer_equity",
    "limitOrderBufferPercentageFutures": "limit_order_buffer_futures",
    "limitOrderBufferPercentageOptions": "limit_order_buffer_options",
    "slTriggerToLimitGapPercentageEquity": "sl_trigger_to_limit_gap_equity",
    "slTriggerToLimitGapPercentageFutures": "sl_trigger_to_limit_gap_futures",
    "slTriggerToLimitGapPercentageOptions": "sl_trigger_to_limit_gap_options",
}

_MINUTES = {
    "loginMinutesBeforeMarketOpen": "login_minutes_before_market_open",
    "intradaySquareOffMinutesBeforeClose": "intraday_squareoff_minutes_before_close",
    "intradaySquareOffBlockMinutesBeforeClose": "intraday_squareoff_block_minutes_before_close",
}


def _percent(value: Any, field: str) -> Decimal:
    """A percentage at or above zero. Zero means unset."""
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not a number") from None
    if parsed < 0:
        raise HTTPException(status_code=400, detail=f"{field} cannot be negative")
    if parsed > 100:
        raise HTTPException(
            status_code=400, detail=f"{field}: {value} is more than the whole price"
        )
    return parsed


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/broker-exchange-configs", tags=["broker-exchange-configs"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _row(db: AsyncSession, broker: str, exchange: str) -> models.BrokerExchangeConfigRow:
        row = await BrokerExchangeConfigRepository(db).get(
            broker.strip().lower(), exchange.strip().upper()
        )
        if row is None:
            raise HTTPException(
                status_code=404, detail=f"{broker}:{exchange} has no broker exchange config"
            )
        return row

    def _apply(row: models.BrokerExchangeConfigRow, edit: ConfigEdit) -> None:
        given = edit.model_dump(exclude_unset=True)
        for field, column in _MINUTES.items():
            if field in given:
                value = given[field]
                if value is not None and value < 0:
                    raise HTTPException(status_code=400, detail=f"{field} cannot be negative")
                setattr(row, column, value)
        if "marketOrdersAllowed" in given:
            row.market_orders_allowed = bool(given["marketOrdersAllowed"])
        for field, column in _PERCENTS.items():
            if field in given:
                setattr(row, column, _percent(given[field] or 0, field))
        if "naicCode" in given:
            row.naic_code = (given["naicCode"] or "").strip() or None
        if "algoId" in given:
            row.algo_id = (given["algoId"] or "").strip() or None

    async def _reload(request: Request) -> None:
        """Tell the running engine. Never raises: the row is already saved."""
        reload = getattr(request.app.state, "reload_protection", None)
        if reload is None:
            return
        try:
            await reload()
        except Exception:
            logger.exception("the engine could not re-read the broker exchange configs")

    @router.get("")
    async def list_configs(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await BrokerExchangeConfigRepository(db).all(order_by="broker_name")
        ordered = sorted(rows, key=lambda r: (r.broker_name, r.exchange_code))
        return ok([wire(row) for row in ordered], count=len(ordered))

    @router.get("/{broker}")
    async def by_broker(broker: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await BrokerExchangeConfigRepository(db).find(
            broker_name=broker.strip().lower(), order_by="exchange_code"
        )
        return ok([wire(row) for row in rows], count=len(rows))

    @router.get("/{broker}/{exchange}")
    async def get_config(
        broker: str, exchange: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        return ok(wire(await _row(db, broker, exchange)))

    @router.post("", status_code=201)
    async def create_config(
        body: NewConfig, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        broker = body.brokerName.strip().lower()
        exchange = body.exchangeCode.strip().upper()
        if await BrokersRepository(db).get(broker) is None:
            raise HTTPException(status_code=404, detail=f"{broker!r} is not a broker garuda knows")
        if await ExchangesRepository(db).get(exchange) is None:
            raise HTTPException(
                status_code=404, detail=f"{exchange!r} is not a configured exchange"
            )
        if await BrokerExchangeConfigRepository(db).get(broker, exchange) is not None:
            raise HTTPException(
                status_code=409, detail=f"{broker}:{exchange} already has a config; edit it"
            )
        row = models.BrokerExchangeConfigRow(
            broker_name=broker,
            exchange_code=exchange,
            market_orders_allowed=False,
            limit_order_buffer_equity=Decimal(0),
            limit_order_buffer_futures=Decimal(0),
            limit_order_buffer_options=Decimal(0),
            sl_trigger_to_limit_gap_equity=Decimal(0),
            sl_trigger_to_limit_gap_futures=Decimal(0),
            sl_trigger_to_limit_gap_options=Decimal(0),
        )
        _apply(row, body)
        BrokerExchangeConfigRepository(db).add(row)
        await db.commit()
        await _reload(request)
        logger.info("broker exchange config added: %s:%s", broker, exchange)
        return ok(wire(row), message=f"{broker}:{exchange} configured")

    @router.put("/{broker}/{exchange}")
    async def update_config(
        broker: str,
        exchange: str,
        body: ConfigEdit,
        request: Request,
        db: AsyncSession = Depends(session),
    ) -> dict[str, Any]:
        row = await _row(db, broker, exchange)
        _apply(row, body)
        await db.commit()
        await _reload(request)
        if row.market_orders_allowed:
            logger.warning(
                "raw market orders are now allowed on %s:%s", row.broker_name, row.exchange_code
            )
        return ok(wire(row), message=f"{row.broker_name}:{row.exchange_code} saved")

    @router.delete("/{broker}/{exchange}")
    async def delete_config(
        broker: str, exchange: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Back to the default, which protects."""
        row = await _row(db, broker, exchange)
        await BrokerExchangeConfigRepository(db).delete(row.broker_name, row.exchange_code)
        await db.commit()
        await _reload(request)
        return ok(None, message=f"{row.broker_name}:{row.exchange_code} removed; it now protects")

    return router
