"""Strategy configuration, as the Console edits the layers.

Behavioural: rows go in at four scopes, and the claims are about what the
engine would resolve for a tranche on a day -- merged per column, most
specific winning, with where each value came from -- and about the rules
the reference enforces at the edge: one row per scope, max_tranches base
only, a tranche timing never before the strategy's start.
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
from garuda.api.routers import strategy_config
from garuda.composition.strategies import validate_strategy
from garuda.core.clock import ReplayClock
from garuda.persistence import models

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)
LEGS = (
    '{"legs": [{"role": "PRIMARY", "instrument": "FUTURE", "direction": "LONG"}, '
    '{"role": "PRIMARY", "instrument": "OPTION", "direction": "SHORT"}]}'
)


class Reloads:
    def __init__(self) -> None:
        self.count = 0

    async def __call__(self) -> None:
        self.count += 1


@pytest.fixture
def reloads() -> Reloads:
    return Reloads()


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession], reloads: Reloads
) -> AsyncIterator[httpx.AsyncClient]:
    async with session_factory() as session:
        session.add(
            models.StrategyDefinitionsRow(
                strategy_name="straddle",
                underlying_symbol="NIFTY",
                exchange="NSE",
                product="INTRADAY",
                trade_mode="OPTION_SELLING",
                status="ACTIVE",
                start_time="09:20:00",
                combo_spec_json=LEGS,
                exclude_monthly_expiry=False,
                use_premium_balancing=True,
                catch_up_missed_tranches=True,
                adaptive_tranches_enabled=False,
                use_indicator_entry=False,
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.state.reload_strategies = reloads
    app.state.validate_strategy = validate_strategy
    app.include_router(strategy_config.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def add(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    payload = {"strategyName": "straddle", **body}
    response = await client.post("/api/strategy-config-tree", json=payload)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()["data"]
    return created


async def effective(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    query = {"strategyName": "straddle", **params}
    response = await client.get("/api/strategy-config-tree/effective", params=query)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


class TestTheScopes:
    async def test_a_base_row_has_priority_zero_and_tranche_and_day_climb(
        self, client: httpx.AsyncClient
    ) -> None:
        base = await add(client, slPercentage=30)
        day = await add(client, dayCondition="E", slPercentage=20)
        tranche = await add(client, tranchNumber=1, slPercentage=25)
        both = await add(client, tranchNumber=1, dayCondition="E", slPercentage=15)
        assert [r["priority"] for r in (base, day, tranche, both)] == [0, 1, 2, 3]
        assert base["scope"] == "base"
        assert both["scope"] == "tranche 1 on E"

    async def test_one_row_per_scope(self, client: httpx.AsyncClient) -> None:
        """A second base row would be two opinions about the same thing."""
        await add(client, slPercentage=30)
        response = await client.post(
            "/api/strategy-config-tree", json={"strategyName": "straddle", "slPercentage": 40}
        )
        assert response.status_code == 409
        assert "base row" in response.json()["message"]

    async def test_exists_answers_the_form_while_it_is_being_filled(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await add(client, tranchNumber=2, dayCondition="dt1")
        found = (
            await client.get(
                "/api/strategy-config-tree/exists",
                params={"strategyName": "straddle", "tranchNumber": 2, "dayCondition": "DT1"},
            )
        ).json()["data"]
        assert found == {"exists": True, "id": created["id"]}
        missing = (
            await client.get(
                "/api/strategy-config-tree/exists", params={"strategyName": "straddle"}
            )
        ).json()["data"]
        assert missing["exists"] is False

    async def test_a_day_condition_the_engine_does_not_know_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/strategy-config-tree",
            json={"strategyName": "straddle", "dayCondition": "SAT"},
        )
        assert response.status_code == 400
        assert "DT1" in response.json()["message"]

    async def test_an_unknown_strategy_is_refused(self, client: httpx.AsyncClient) -> None:
        response = await client.post("/api/strategy-config-tree", json={"strategyName": "nope"})
        assert response.status_code == 404


class TestWhatTheEngineResolves:
    async def test_the_most_specific_value_wins_per_column(self, client: httpx.AsyncClient) -> None:
        """The base row's target survives a tranche row that sets only the stop."""
        await add(client, slPercentage=30, targetPercentage=50)
        await add(client, tranchNumber=1, slPercentage=20)

        resolved = await effective(client, tranchNumber=1)

        assert resolved["values"]["slPercentage"] == 20.0
        assert resolved["values"]["targetPercentage"] == 50.0
        assert resolved["sources"]["slPercentage"]["scope"] == "tranche 1"
        assert resolved["sources"]["targetPercentage"]["scope"] == "base"
        assert resolved["layersInScope"] == 2

    async def test_a_day_row_applies_only_on_that_day(self, client: httpx.AsyncClient) -> None:
        await add(client, slPercentage=30)
        await add(client, dayCondition="E", slPercentage=15)

        ordinary = await effective(client, tranchNumber=0)
        expiry = await effective(client, tranchNumber=0, dayCondition="E")

        assert ordinary["values"]["slPercentage"] == 30.0
        assert expiry["values"]["slPercentage"] == 15.0
        assert expiry["sources"]["slPercentage"]["scope"] == "day E"

    async def test_a_null_defers_rather_than_overriding_with_nothing(
        self, client: httpx.AsyncClient
    ) -> None:
        base = await add(client, slPercentage=30)
        tranche = await add(client, tranchNumber=1, slPercentage=20)
        await client.put(f"/api/strategy-config-tree/{tranche['id']}", json={"slPercentage": None})

        resolved = await effective(client, tranchNumber=1)

        assert resolved["values"]["slPercentage"] == 30.0, "cleared on the tranche: base shows"
        assert resolved["sources"]["slPercentage"]["scope"] == "base"
        assert base["id"] != tranche["id"]

    async def test_no_rows_resolves_to_nothing(self, client: httpx.AsyncClient) -> None:
        resolved = await effective(client, tranchNumber=0)
        assert resolved["values"] == {}
        assert resolved["layersInScope"] == 0


class TestTheReferencesRules:
    async def test_max_tranches_is_dropped_from_a_tranche_row(
        self, client: httpx.AsyncClient
    ) -> None:
        row = await add(client, tranchNumber=1, maxTranches=4, slPercentage=20)
        assert row["maxTranches"] is None
        assert row["slPercentage"] == 20.0
        base = await add(client, maxTranches=4)
        assert base["maxTranches"] == 4

    async def test_a_tranche_timing_before_the_strategy_start_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/strategy-config-tree",
            json={"strategyName": "straddle", "tranchNumber": 1, "tranchTiming": "09:10:00"},
        )
        assert response.status_code == 400
        assert "09:20:00" in response.json()["message"]
        later = await add(client, tranchNumber=1, tranchTiming="09:45:00")
        assert later["tranchTiming"] == "09:45:00"

    async def test_bulk_delete_by_strategy_is_refused(self, client: httpx.AsyncClient) -> None:
        await add(client, slPercentage=30)
        response = await client.delete("/api/strategy-config-tree/strategy/straddle")
        assert response.status_code == 400
        assert (await client.get("/api/strategy-config-tree/strategy/straddle")).json()[
            "count"
        ] == 1

    async def test_a_choice_outside_the_vocabulary_is_refused_by_name(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/strategy-config-tree",
            json={"strategyName": "straddle", "strikeType": "Nearest"},
        )
        assert response.status_code == 400
        assert "MoneyNess" in response.json()["message"]

    async def test_a_negative_percentage_is_refused(self, client: httpx.AsyncClient) -> None:
        response = await client.post(
            "/api/strategy-config-tree",
            json={"strategyName": "straddle", "slPercentage": -5},
        )
        assert response.status_code == 400


class TestTellingTheEngine:
    async def test_every_write_reaches_the_engine(
        self, client: httpx.AsyncClient, reloads: Reloads
    ) -> None:
        row = await add(client, slPercentage=30)
        await client.put(f"/api/strategy-config-tree/{row['id']}", json={"slPercentage": 25})
        await client.delete(f"/api/strategy-config-tree/{row['id']}")
        assert reloads.count == 3

    async def test_the_catalog_says_what_the_engine_reads(self, client: httpx.AsyncClient) -> None:
        body = (await client.get("/api/strategy-config-tree/catalog")).json()["data"]
        assert body["fields"]["slPercentage"]["readByEngine"] is True
        assert body["fields"]["strikeType"]["readByEngine"] is True
        assert body["fields"]["breakoutRangeType"]["readByEngine"] is False
        assert body["fields"]["maxTranches"]["baseOnly"] is True
        assert "MoneyNess" in body["fields"]["strikeType"]["choices"]
        assert any(g["name"] == "Trailing" for g in body["groups"])
        assert {d["code"] for d in body["dayConditions"]} >= {"E", "DT1", "TH"}

    async def test_the_strategy_list_counts_rows(self, client: httpx.AsyncClient) -> None:
        await add(client, slPercentage=30)
        await add(client, tranchNumber=1)
        [named] = (await client.get("/api/strategy-config-tree/strategy-names")).json()["data"]
        assert named["strategyName"] == "straddle"
        assert named["rows"] == 2
        assert named["startTime"] == "09:20:00"
