"""The trade log, as it is stored and as the Console reads it.

Behavioural: entries go in through the store the engine uses, and the claims
are about what the three reads give back -- one trade's timeline in order,
the log across trades filtered and paged in SQL, and the filter choices --
and about the two things that must hold at the edges: a store that is down
costs nothing but the row, and a date bound means the venue's day.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import trade_log
from garuda.core.clock import ReplayClock
from garuda.domain.client import TradingClientId
from garuda.domain.trade_log import TradeLogEntry, TradeLogEventType
from garuda.persistence import models
from garuda.persistence.trade_log_store import TradeLogStore

pytestmark = pytest.mark.integration

#: 09:30 in Kolkata on Saturday the 10th.
NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)
APPA = "appa-zerodha"
AMMA = "amma-zerodha"


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
        for client_id, name in ((APPA, "Appa"), (AMMA, "Amma")):
            session.add(
                models.TradingClientRow(
                    id=client_id,
                    display_name=name,
                    broker="ZERODHA",
                    client_id=client_id.upper(),
                    enabled=True,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.include_router(trade_log.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


def an_entry(
    trade_id: str,
    event: TradeLogEventType,
    *,
    at: dt.datetime = NOW,
    client: str = APPA,
    strategy: str = "straddle",
    symbol: str = "NIFTY26OCT25000CE",
    message: str = "",
    order_id: str | None = None,
    price: str | None = None,
    error: str | None = None,
) -> TradeLogEntry:
    return TradeLogEntry(
        trade_id=trade_id,
        trading_client=TradingClientId(client),
        event_type=event,
        at=at,
        message=message or f"{event} on {symbol}",
        strategy=strategy,
        trading_symbol=symbol,
        order_id=order_id,
        price=Decimal(price) if price else None,
        error_message=error,
    )


async def seed(sessions: async_sessionmaker[AsyncSession], *entries: TradeLogEntry) -> None:
    store = TradeLogStore(sessions, label="test")
    for entry in entries:
        await store.write(entry)


async def page(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/trade-log", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


# -- the store ----------------------------------------------------------------


class TestTheStore:
    async def test_an_entry_is_written_with_its_money_exact(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        await seed(
            session_factory,
            an_entry(
                "t-1",
                TradeLogEventType.ENTRY_ORDER_PLACED,
                order_id="26101000001",
                price="120.05",
            ),
        )

        body = await page(client)
        [entry] = body["entries"]
        assert entry["tradeId"] == "t-1"
        assert entry["eventCategory"] == "ENTRY"
        assert entry["price"] == "120.0500", "a string, never a float"
        assert entry["orderId"] == "26101000001"
        assert entry["tradingClient"] == "Appa"
        assert entry["broker"] == "ZERODHA"
        assert entry["eventTimestamp"].startswith("2026-10-10T")

    async def test_a_store_that_is_down_costs_the_row_and_nothing_else(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        """An account the table does not know fails the foreign key; the
        write reports it and returns, as the order path needs it to."""
        await seed(session_factory, an_entry("t-1", TradeLogEventType.ENTRY_FAILED, client="ghost"))

        assert (await page(client))["pagination"]["totalCount"] == 0


# -- one trade ----------------------------------------------------------------


class TestTheTimeline:
    async def test_a_trades_events_come_back_oldest_first(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        minute = dt.timedelta(minutes=1)
        await seed(
            session_factory,
            an_entry("t-1", TradeLogEventType.TRADE_COMPLETED, at=NOW + 3 * minute),
            an_entry("t-1", TradeLogEventType.ENTRY_ORDER_PLACED, at=NOW),
            an_entry("t-2", TradeLogEventType.ENTRY_ORDER_PLACED, at=NOW + minute),
            an_entry("t-1", TradeLogEventType.SL_ORDER_PLACED, at=NOW + 2 * minute),
            an_entry("t-1", TradeLogEventType.ENTRY_FILLED, at=NOW + minute),
        )

        response = await client.get("/api/trade-log/trade/t-1")
        assert response.status_code == 200
        body = response.json()
        assert body["count"] == 4
        assert [e["eventType"] for e in body["data"]] == [
            "ENTRY_ORDER_PLACED",
            "ENTRY_FILLED",
            "SL_ORDER_PLACED",
            "TRADE_COMPLETED",
        ]

    async def test_an_unknown_trade_has_an_empty_timeline(self, client: httpx.AsyncClient) -> None:
        response = await client.get("/api/trade-log/trade/never")
        assert response.status_code == 200
        assert response.json()["data"] == []


# -- the log ------------------------------------------------------------------


class TestTheLog:
    async def test_freshest_first_and_paged(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        await seed(
            session_factory,
            *(
                an_entry(
                    f"t-{i}", TradeLogEventType.ENTRY_ORDER_PLACED, at=NOW + dt.timedelta(minutes=i)
                )
                for i in range(5)
            ),
        )

        first = await page(client, page=1, pageSize=2)
        assert [e["tradeId"] for e in first["entries"]] == ["t-4", "t-3"]
        assert first["pagination"] == {
            "page": 1,
            "pageSize": 2,
            "totalCount": 5,
            "totalPages": 3,
            "hasNext": True,
            "hasPrev": False,
        }
        last = await page(client, page=3, pageSize=2)
        assert [e["tradeId"] for e in last["entries"]] == ["t-0"]
        assert last["pagination"]["hasNext"] is False

    async def test_each_filter_narrows_in_sql(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        await seed(
            session_factory,
            an_entry("t-1", TradeLogEventType.ENTRY_ORDER_PLACED, client=APPA, strategy="straddle"),
            an_entry("t-2", TradeLogEventType.SL_TRAIL_UPDATED, client=AMMA, strategy="breakout"),
            an_entry(
                "t-3",
                TradeLogEventType.TRADE_COMPLETED,
                client=APPA,
                strategy="breakout",
                symbol="RELIANCE",
            ),
        )

        async def ids(**params: Any) -> list[str]:
            return [e["tradeId"] for e in (await page(client, **params))["entries"]]

        assert await ids(tradingClientId=APPA) == ["t-3", "t-1"]
        assert await ids(strategy="breakout") == ["t-3", "t-2"]
        assert await ids(tradingSymbol="reliance") == ["t-3"]
        assert await ids(eventCategory="sl") == ["t-2"]
        assert await ids(eventType="TRADE_COMPLETED") == ["t-3"]
        assert await ids(tradeId="t-2") == ["t-2"]
        assert await ids(tradingClientId=APPA, strategy="breakout") == ["t-3"]
        assert (await page(client, tradingClientId=AMMA))["pagination"]["totalCount"] == 1

    async def test_search_reads_what_the_operator_types(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        await seed(
            session_factory,
            an_entry("t-1", TradeLogEventType.ENTRY_REJECTED, message="Entry rejected: margin"),
            an_entry("t-2", TradeLogEventType.SL_ORDER_PLACED, order_id="26101000777"),
            an_entry("t-3", TradeLogEventType.ENTRY_FILLED, client=AMMA),
        )

        async def ids(search: str) -> list[str]:
            return [e["tradeId"] for e in (await page(client, search=search))["entries"]]

        assert await ids("MARGIN") == ["t-1"], "the message, case blind"
        assert await ids("000777") == ["t-2"], "part of an order id"
        assert await ids("amma") == ["t-3"], "the account's display name"
        assert await ids("nothing like it") == []

    async def test_a_date_bound_is_the_venues_day(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        """23:30 UTC on the 9th is 05:00 on the 10th in Kolkata: the 10th's."""
        late_ninth_utc = dt.datetime(2026, 10, 9, 23, 30, tzinfo=dt.UTC)
        await seed(
            session_factory,
            an_entry(
                "t-9",
                TradeLogEventType.ENTRY_ORDER_PLACED,
                at=late_ninth_utc - dt.timedelta(hours=12),
            ),
            an_entry("t-10", TradeLogEventType.ENTRY_ORDER_PLACED, at=late_ninth_utc),
            an_entry(
                "t-11",
                TradeLogEventType.ENTRY_ORDER_PLACED,
                at=dt.datetime(2026, 10, 10, 18, 31, tzinfo=dt.UTC),
            ),
        )

        tenth = await page(client, startTime="2026-10-10", endTime="2026-10-10")
        assert [e["tradeId"] for e in tenth["entries"]] == ["t-10"]
        from_tenth = await page(client, startTime="2026-10-10")
        assert [e["tradeId"] for e in from_tenth["entries"]] == ["t-11", "t-10"]
        instant = await page(
            client, startTime="2026-10-10T05:00:00+05:30", endTime="2026-10-10T05:00:00+05:30"
        )
        assert [e["tradeId"] for e in instant["entries"]] == ["t-10"], "an instant is inclusive"

    async def test_a_bound_that_is_not_a_date_is_refused(self, client: httpx.AsyncClient) -> None:
        response = await client.get("/api/trade-log", params={"startTime": "yesterday"})
        assert response.status_code == 400
        assert "startTime" in response.json()["message"]

    async def test_the_page_size_is_capped_as_the_reference_capped_it(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.get("/api/trade-log", params={"pageSize": 501})
        assert response.status_code == 400, "the envelope turns a validation failure into a refusal"


# -- the filter choices -------------------------------------------------------


class TestTheFilters:
    async def test_the_choices_are_what_the_log_has_and_every_event_there_is(
        self, session_factory: async_sessionmaker[AsyncSession], client: httpx.AsyncClient
    ) -> None:
        await seed(
            session_factory,
            an_entry("t-1", TradeLogEventType.ENTRY_ORDER_PLACED, client=AMMA, strategy="breakout"),
            an_entry("t-2", TradeLogEventType.ENTRY_ORDER_PLACED, client=AMMA, symbol="RELIANCE"),
        )

        response = await client.get("/api/trade-log/filters")
        assert response.status_code == 200
        body = response.json()["data"]
        assert body["tradingClients"] == [{"id": AMMA, "displayName": "Amma", "broker": "ZERODHA"}]
        assert body["strategies"] == ["breakout", "straddle"]
        assert body["tradingSymbols"] == ["NIFTY26OCT25000CE", "RELIANCE"]
        assert body["eventCategories"] == [
            "ENTRY",
            "SL",
            "TARGET",
            "HEDGE",
            "EXIT",
            "ERROR",
            "MODIFY",
        ]
        assert len(body["eventTypes"]) == len(TradeLogEventType)
        assert "SL_TRAIL_UPDATED" in body["typesByCategory"]["SL"]
