"""Alerts, as the engine stores them and the Console reads them.

Behavioural: alerts go in through the repository the manager writes to,
and the claims are about what the bell and the page get back -- newest
first, coalesced, filtered and paged -- and about a bad bound refused.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import alerts
from garuda.core.clock import ReplayClock
from garuda.domain.alert import Alert, AlertLevel, EntityType
from garuda.persistence import models
from garuda.persistence.uow import UnitOfWork

pytestmark = pytest.mark.integration

#: 09:30 in Kolkata on Monday the 12th.
NOW = dt.datetime(2026, 10, 12, 4, 0, tzinfo=dt.UTC)
MONDAY = dt.date(2026, 10, 12)


def an_alert(
    message: str,
    *,
    level: AlertLevel = AlertLevel.WARNING,
    entity_type: EntityType = EntityType.FEED,
    entity: str = "zerodha",
    operation: str = "reconnect",
    at: dt.datetime = NOW,
    key: str | None = None,
) -> Alert:
    return Alert(
        level=level,
        entity_type=entity_type,
        entity=entity,
        operation=operation,
        message=message,
        raised_at=at,
        trading_day=at.astimezone(dt.timezone(dt.timedelta(hours=5, minutes=30))).date(),
        key=key,
    )


async def seed(sessions: async_sessionmaker[AsyncSession]) -> None:
    async with sessions() as session:
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
        await session.commit()
    minute = dt.timedelta(minutes=1)
    async with UnitOfWork(sessions) as uow:
        store = uow.repositories.alerts
        await store.record(an_alert("the feed reconnected", at=NOW))
        await store.record(
            an_alert(
                "Appa has no broker session",
                level=AlertLevel.CRITICAL,
                entity_type=EntityType.BROKER,
                entity="Appa",
                operation="login",
                at=NOW + minute,
            )
        )
        # The same keyed problem twice: one row, two occurrences.
        await store.record(
            an_alert(
                "stop could not be placed",
                level=AlertLevel.CRITICAL,
                entity_type=EntityType.ORDER,
                entity="Appa",
                operation="stop",
                at=NOW + 2 * minute,
                key="stop-appa",
            )
        )
        await store.record(
            an_alert(
                "stop could not be placed, again",
                level=AlertLevel.CRITICAL,
                entity_type=EntityType.ORDER,
                entity="Appa",
                operation="stop",
                at=NOW + 3 * minute,
                key="stop-appa",
            )
        )
        # Yesterday, on the venue's clock.
        await store.record(
            an_alert(
                "the day started",
                level=AlertLevel.INFO,
                entity_type=EntityType.SYSTEM,
                entity="NSE",
                operation="day-init",
                at=NOW - dt.timedelta(days=1),
            )
        )
        await uow.session.commit()


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    await seed(session_factory)
    app = FastAPI()
    envelope.install(app)
    app.include_router(alerts.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def page(http: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await http.get("/api/alerts", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


class TestTheBell:
    async def test_recent_is_newest_first_and_coalesced(self, client: httpx.AsyncClient) -> None:
        rows = (await client.get("/api/alerts/recent", params={"limit": 3})).json()["data"]
        assert [r["operation"] for r in rows] == ["stop", "login", "reconnect"]
        stop = rows[0]
        assert stop["occurrenceCount"] == 2
        assert stop["alertMessage"] == "stop could not be placed, again", "the latest wording"
        assert stop["uniqueKey"] == "stop-appa"
        assert stop["firstOccurrenceTime"] is not None
        critical = (
            await client.get("/api/alerts/recent", params={"alertLevel": "critical"})
        ).json()["data"]
        assert [r["operation"] for r in critical] == ["stop", "login"]

    async def test_since_an_instant(self, client: httpx.AsyncClient) -> None:
        rows = (
            await client.get(
                "/api/alerts/since",
                params={"timestamp": (NOW + dt.timedelta(minutes=1)).isoformat()},
            )
        ).json()["data"]
        assert [r["operation"] for r in rows] == ["stop"]
        assert (await client.get("/api/alerts/since")).status_code == 400


class TestThePage:
    async def test_paged_newest_first_with_its_count(self, client: httpx.AsyncClient) -> None:
        body = await page(client, page=1, pageSize=2)
        assert body["pagination"] == {
            "page": 1,
            "pageSize": 2,
            "totalCount": 4,
            "totalPages": 2,
            "hasNext": True,
            "hasPrev": False,
        }
        assert [a["operation"] for a in body["alerts"]] == ["stop", "login"]

    async def test_the_filters(self, client: httpx.AsyncClient) -> None:
        assert [a["operation"] for a in (await page(client, alertLevel="INFO"))["alerts"]] == [
            "day-init"
        ]
        assert len((await page(client, entityType="order"))["alerts"]) == 1
        assert len((await page(client, entityName="Appa"))["alerts"]) == 2
        assert len((await page(client, operation="reconnect"))["alerts"]) == 1
        assert len((await page(client, search="session"))["alerts"]) == 1
        assert (
            len((await page(client, startTime="2026-10-12", endTime="2026-10-12"))["alerts"]) == 3
        ), "the venue's day"
        assert len((await page(client, audience="important"))["alerts"]) == 4, "accepted, ignored"
        assert (await client.get("/api/alerts", params={"alertLevel": "LOUD"})).status_code == 400
        assert (await client.get("/api/alerts", params={"startTime": "soon"})).status_code == 400

    async def test_the_filter_choices(self, client: httpx.AsyncClient) -> None:
        body = (await client.get("/api/alerts/filters")).json()["data"]
        assert body["operations"] == ["day-init", "login", "reconnect", "stop"]
        assert body["entityNames"] == ["Appa", "NSE", "zerodha"]
        assert body["alertLevels"] == ["INFO", "WARNING", "CRITICAL"]
        assert "RISK" in body["entityTypes"], "the vocabulary, not just what is stored"
