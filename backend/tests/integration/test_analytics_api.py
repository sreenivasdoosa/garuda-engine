"""Analytics, from the Console's side: one question, any inputs, one answer."""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import analytics
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason
from garuda.persistence import models
from garuda.persistence.uow import UnitOfWork

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 15, 4, 0, tzinfo=dt.UTC)
MONDAY = dt.datetime(2026, 10, 12, 4, 30, tzinfo=dt.UTC)
APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def closed(
    trade_id: str,
    entry: str,
    exit_price: str,
    *,
    client: TradingClientId = APPA,
    strategy: str = "straddle",
    at: dt.datetime = MONDAY,
    is_paper: bool = False,
) -> Trade:
    trade = Trade(
        id=TradeId(trade_id),
        trading_client=client,
        instrument=InstrumentId("NSE:NIFTY26OCT25000CE"),
        strategy=strategy,
        direction=Direction.SHORT,
        product=ProductType.MIS,
        quantity=75,
        is_paper=is_paper,
    )
    return trade.with_entry_fill(75, rupees(entry), at).closed(
        rupees(exit_price), TradeExitReason.TARGET, at
    )


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(
            models.ExchangesRow(
                exchange_code="NSE",
                exchange_name="NSE",
                timezone="Asia/Kolkata",
                currency="INR",
                segments="EQUITY,FNO",
                market_open=dt.time(9, 15),
                market_close=dt.time(15, 30),
            )
        )
        for client_id, name, broker in (
            (APPA.value, "Appa", "ZERODHA"),
            (AMMA.value, "Amma", "DHAN"),
        ):
            session.add(
                models.TradingClientRow(
                    id=client_id,
                    display_name=name,
                    broker=broker,
                    client_id=client_id.upper(),
                    enabled=True,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
        await session.commit()
    day = dt.timedelta(days=1)
    async with UnitOfWork(session_factory) as uow:
        for trade in (
            closed("1", "120", "100"),
            closed("2", "100", "110", strategy="strangle"),
            closed("3", "120", "110", client=AMMA, at=MONDAY + day),
            closed("4", "100", "140", at=MONDAY + 2 * day),
            closed("p", "120", "100", is_paper=True),
        ):
            await uow.repositories.live_trades.upsert_trade(trade, NOW)
        await uow.session.commit()
    app = FastAPI()
    envelope.install(app)
    app.include_router(analytics.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def ask(http: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await http.get(
        "/api/analytics/query", params={"fromDate": "2026-10-12", "paper": "live", **params}
    )
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


async def test_the_options_say_how_to_ask(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/analytics/options")).json()["data"]
    assert "strategy" in body["groupBy"]
    assert [c["id"] for c in body["tradingClients"]] == ["amma", "appa"]
    assert body["brokers"] == ["dhan", "zerodha"]


async def test_one_question_one_answer(client: httpx.AsyncClient) -> None:
    body = await ask(client, groupBy="strategy")
    assert body["overall"]["trades"] == 4
    assert body["overall"]["grossPnl"] == "-1500"
    assert {g["label"]: g["grossPnl"] for g in body["groups"]} == {
        "straddle": "-750",
        "strangle": "-750",
    }
    assert [p["cumulative"] for p in body["curve"]] == ["750", "1500", "-1500"]


async def test_any_combination_of_inputs(client: httpx.AsyncClient) -> None:
    only_amma = await ask(client, tradingClientIds="amma", groupBy="account")
    assert [(g["label"], g["trades"]) for g in only_amma["groups"]] == [("Amma", 1)]
    by_broker = await ask(client, groupBy="broker")
    assert {g["key"]: g["trades"] for g in by_broker["groups"]} == {"zerodha": 3, "dhan": 1}
    dhan_only = await ask(client, brokers="dhan", groupBy="day")
    assert dhan_only["overall"]["trades"] == 1
    both = await ask(client, strategies="straddle,strangle", products="MIS", groupBy="month")
    assert both["groups"][0]["key"] == "2026-10"
    paper = await ask(client, paper="paper", groupBy="day")
    assert paper["overall"]["trades"] == 1
    nothing = await ask(client, brokers="kotak", groupBy="day")
    assert nothing["overall"]["trades"] == 0
    assert (
        await client.get("/api/analytics/query", params={"groupBy": "colour"})
    ).status_code == 400
