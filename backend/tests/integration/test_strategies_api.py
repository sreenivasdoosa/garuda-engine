"""Strategies, as the Console defines, rules and subscribes them.

Behavioural: what the pages get, and what the running engine is told. The
claims that matter are the ones that would otherwise be learnt at startup --
a strategy the engine would refuse is refused at the save, a subscription
with no capital is refused rather than silently skipped, and every write
reaches the engine at once.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import AsyncIterator
from decimal import Decimal
from typing import Any

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api import envelope
from garuda.api.routers import strategies
from garuda.composition.strategies import validate_strategy
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.persistence.repositories import StrategyConfigRepository

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)

STRADDLE_LEGS = [
    {"instrument": {"type": "option_strike", "option_type": "CALL"}, "side": "ALWAYS_SHORT"},
    {"instrument": {"type": "option_strike", "option_type": "PUT"}, "side": "ALWAYS_SHORT"},
]

#: What the Console's rule builder writes.
CONSOLE_ENTRY_RULES = {
    "type": "operator",
    "operator": "AND",
    "children": [
        {
            "type": "condition",
            "condition": {
                "indicator": "RSI",
                "params": {"period": 14},
                "interval": "5minute",
                "comparator": "GREATER_THAN",
                "value": 30,
            },
        }
    ],
}


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
            models.TradingClientRow(
                id="appa",
                display_name="Appa",
                broker="ZERODHA",
                client_id="AB1234",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()
    app = FastAPI()
    envelope.install(app)
    app.state.reload_strategies = reloads
    app.state.validate_strategy = validate_strategy
    app.include_router(strategies.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def define(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    payload = {
        "strategyName": "straddle",
        "underlyingSymbol": "NIFTY",
        "exchange": "NSE",
        "product": "INTRADAY",
        "legs": STRADDLE_LEGS,
        **body,
    }
    response = await client.post("/api/engine/definitions", json=payload)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()["data"]
    return created


class TestDefinitions:
    async def test_a_strategy_is_defined_inactive_with_its_legs(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await define(client)
        assert created["status"] == "INACTIVE", "nothing trades until the operator says"
        assert created["underlyingSymbol"] == "NIFTY"
        assert len(created["legs"]) == 2
        assert json.loads(created["comboSpecJson"])["legs"] == STRADDLE_LEGS
        assert created["subscriptions"] == 0

    async def test_a_new_strategy_starts_with_the_references_defaults(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The template's default configuration, now the definition's columns
        and one base configuration row written beside it."""
        created = await define(client)
        assert created["tradeMode"] == "OPTION_SELLING"
        assert (created["startTime"], created["stopTime"]) == ("09:20", "15:15")
        assert created["capitalPerLot"] == 100000
        assert created["hedgeDistancePercentageIntraday"] == 4.0
        assert created["useIndicatorEntry"] is False
        assert created["strategyClass"] is None
        async with session_factory() as session:
            rows = list(await StrategyConfigRepository(session).all())
        assert len(rows) == 1
        base = rows[0]
        assert (base.tranch_number, base.day_condition) == (None, None)
        assert (base.strike_type, base.strike_value) == ("MoneyNess", "ATM")
        assert (base.lots_per_tranch, base.hedging_enabled, base.tranch_timing) == (
            1,
            True,
            "09:20",
        )
        assert base.sl_percentage == Decimal(30)

    async def test_a_trade_mode_outside_the_vocabulary_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/engine/definitions",
            json={
                "strategyName": "x",
                "underlyingSymbol": "NIFTY",
                "exchange": "NSE",
                "tradeMode": "SPEC",
            },
        )
        assert response.status_code == 400
        assert "OPTION_SELLING" in response.json()["message"]

    async def test_a_custom_strategy_class_is_refused_while_none_is_registered(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/engine/definitions",
            json={
                "strategyName": "x",
                "underlyingSymbol": "NIFTY",
                "exchange": "NSE",
                "strategyClass": "MINE",
            },
        )
        assert response.status_code == 400
        assert "none are registered" in response.json()["message"]

    async def test_the_catalog_names_what_a_leg_can_be(self, client: httpx.AsyncClient) -> None:
        body = (await client.get("/api/engine/catalog")).json()["data"]
        assert {s["type"] for s in body["selectors"]} >= {"option_strike", "premium", "future"}
        assert (
            "option_type"
            in next(s for s in body["selectors"] if s["type"] == "option_strike")["fields"]
        )
        assert "ALWAYS_SHORT" in body["sideRules"]
        assert "indicator" in body["rules"]

    async def test_activating_a_strategy_the_engine_would_refuse_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        """The reason the morning's log would give, at the form instead."""
        created = await define(client, isDirectional=True)  # no provider named
        response = await client.put(
            f"/api/engine/definitions/{created['strategyId']}/status/ACTIVE"
        )
        assert response.status_code == 400
        assert "would refuse" in response.json()["message"]
        assert (await client.get(f"/api/engine/definitions/{created['strategyId']}")).json()[
            "data"
        ]["status"] == "INACTIVE"

    async def test_a_sound_strategy_activates_and_the_engine_is_told(
        self, client: httpx.AsyncClient, reloads: Reloads
    ) -> None:
        created = await define(client)
        before = reloads.count
        response = await client.put(
            f"/api/engine/definitions/{created['strategyId']}/status/ACTIVE"
        )
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "ACTIVE"
        assert reloads.count == before + 1

    async def test_a_directional_strategy_without_direction_rules_cannot_go_active(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await define(client, isDirectional=True)
        response = await client.put(
            f"/api/engine/definitions/{created['strategyId']}/status/ACTIVE"
        )
        assert response.status_code == 400
        assert "direction" in response.json()["message"]

    async def test_a_name_is_unique(self, client: httpx.AsyncClient) -> None:
        await define(client)
        response = await client.post(
            "/api/engine/definitions",
            json={"strategyName": "straddle", "underlyingSymbol": "NIFTY", "exchange": "NSE"},
        )
        assert response.status_code == 409

    async def test_a_field_the_definition_does_not_have_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        response = await client.post(
            "/api/engine/definitions",
            json={
                "strategyName": "x",
                "underlyingSymbol": "NIFTY",
                "exchange": "NSE",
                "legs": STRADDLE_LEGS,
                "colour": "blue",
            },
        )
        assert response.status_code == 400
        assert "colour" in response.json()["message"]

    async def test_a_partial_edit_leaves_the_rest(self, client: httpx.AsyncClient) -> None:
        created = await define(client, displayName="Straddle")
        response = await client.put(
            f"/api/engine/definitions/{created['strategyId']}", json={"startTime": "09:20:00"}
        )
        body = response.json()["data"]
        assert body["startTime"] == "09:20:00"
        assert body["displayName"] == "Straddle"
        assert len(body["legs"]) == 2

    async def test_a_subscribed_strategy_cannot_be_deleted(self, client: httpx.AsyncClient) -> None:
        created = await define(client)
        await client.post(
            "/api/engine/subscriptions",
            json={"tradingClientId": "appa", "strategyName": "straddle", "capital": 200000},
        )
        response = await client.delete(f"/api/engine/definitions/{created['strategyId']}")
        assert response.status_code == 409
        assert "subscription" in response.json()["message"]

    async def test_an_unsubscribed_strategy_is_deleted_with_its_rules(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await define(client)
        await client.put(
            "/api/engine/indicator-rules/straddle", json={"entryRules": CONSOLE_ENTRY_RULES}
        )
        assert (
            await client.delete(f"/api/engine/definitions/{created['strategyId']}")
        ).status_code == 200
        assert (await client.get("/api/engine/definitions/name/straddle")).status_code == 404
        assert (await client.get("/api/engine/indicator-rules/straddle")).status_code == 404


class TestRules:
    async def test_the_builders_tree_is_stored_and_read_back(
        self, client: httpx.AsyncClient
    ) -> None:
        await define(client)
        response = await client.put(
            "/api/engine/indicator-rules/straddle",
            json={"entryRules": CONSOLE_ENTRY_RULES, "useIndicatorExit": False},
        )
        assert response.status_code == 200, response.text
        body = (await client.get("/api/engine/indicator-rules/straddle")).json()["data"]
        assert body["entryRules"] == CONSOLE_ENTRY_RULES
        assert body["exitRules"] is None
        assert json.loads(body["entryRulesJson"]) == CONSOLE_ENTRY_RULES

    async def test_a_rule_the_engine_cannot_read_is_refused_on_an_active_strategy(
        self, client: httpx.AsyncClient
    ) -> None:
        created = await define(client)
        await client.put(f"/api/engine/definitions/{created['strategyId']}/status/ACTIVE")
        bad = {
            "type": "operator",
            "operator": "AND",
            "children": [
                {
                    "type": "condition",
                    "condition": {
                        "indicator": "RSI",
                        "params": {"period": 14},
                        "interval": "2minute",
                        "comparator": "GREATER_THAN",
                        "value": 30,
                    },
                }
            ],
        }
        response = await client.put(
            "/api/engine/indicator-rules/straddle", json={"entryRules": bad}
        )
        assert response.status_code == 400
        assert "would refuse" in response.json()["message"]
        assert (await client.get("/api/engine/indicator-rules/straddle")).json()["data"][
            "entryRules"
        ] is None, "nothing was stored"

    async def test_unreadable_json_text_is_refused_by_name(self, client: httpx.AsyncClient) -> None:
        await define(client)
        response = await client.put(
            "/api/engine/indicator-rules/straddle", json={"entryRulesJson": "{not json"}
        )
        assert response.status_code == 400
        assert "entryRulesJson" in response.json()["message"]


class TestSubscriptions:
    async def test_an_account_subscribes_with_capital_and_the_engine_is_told(
        self, client: httpx.AsyncClient, reloads: Reloads
    ) -> None:
        await define(client)
        before = reloads.count
        response = await client.post(
            "/api/engine/subscriptions",
            json={
                "tradingClientId": "appa",
                "strategyName": "straddle",
                "capital": 200000,
                "isPaperTrading": True,
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()["data"]
        assert body["displayName"] == "Appa"
        assert body["capital"] == 200000.0
        assert body["isPaperTrading"] is True
        assert body["isActive"] is True
        assert body["activatedAt"] == NOW.isoformat()
        assert reloads.count == before + 1

    async def test_no_capital_is_refused_rather_than_skipped_at_startup(
        self, client: httpx.AsyncClient
    ) -> None:
        await define(client)
        response = await client.post(
            "/api/engine/subscriptions",
            json={"tradingClientId": "appa", "strategyName": "straddle"},
        )
        assert response.status_code == 400
        assert "capital" in response.json()["message"]

    async def test_one_subscription_per_account_and_strategy(
        self, client: httpx.AsyncClient
    ) -> None:
        """Two would enter every signal twice."""
        await define(client)
        body = {"tradingClientId": "appa", "strategyName": "straddle", "capital": 1000}
        await client.post("/api/engine/subscriptions", json=body)
        response = await client.post("/api/engine/subscriptions", json=body)
        assert response.status_code == 409

    async def test_an_unknown_account_or_strategy_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        await define(client)
        no_account = await client.post(
            "/api/engine/subscriptions",
            json={"tradingClientId": "nobody", "strategyName": "straddle", "capital": 1},
        )
        assert no_account.status_code == 404
        no_strategy = await client.post(
            "/api/engine/subscriptions",
            json={"tradingClientId": "appa", "strategyName": "nope", "capital": 1},
        )
        assert no_strategy.status_code == 404

    async def test_pausing_and_resuming(self, client: httpx.AsyncClient, reloads: Reloads) -> None:
        await define(client)
        created = (
            await client.post(
                "/api/engine/subscriptions",
                json={"tradingClientId": "appa", "strategyName": "straddle", "capital": 1000},
            )
        ).json()["data"]
        sid = created["subscriptionId"]
        before = reloads.count

        paused = (await client.put(f"/api/engine/subscriptions/{sid}/deactivate")).json()["data"]
        assert paused["isActive"] is False
        assert paused["deactivatedAt"] == NOW.isoformat()

        resumed = (await client.put(f"/api/engine/subscriptions/{sid}/activate")).json()["data"]
        assert resumed["isActive"] is True
        assert resumed["deactivatedAt"] is None
        assert reloads.count == before + 2

        listed = (await client.get("/api/engine/subscriptions?activeOnly=true")).json()["data"]
        assert [s["subscriptionId"] for s in listed] == [sid]

    async def test_editing_capital_and_removing(self, client: httpx.AsyncClient) -> None:
        await define(client)
        sid = (
            await client.post(
                "/api/engine/subscriptions",
                json={"tradingClientId": "appa", "strategyName": "straddle", "capital": 1000},
            )
        ).json()["data"]["subscriptionId"]

        edited = (
            await client.put(f"/api/engine/subscriptions/{sid}", json={"capital": 5000})
        ).json()["data"]
        assert edited["capital"] == 5000.0

        assert (await client.delete(f"/api/engine/subscriptions/{sid}")).status_code == 200
        assert (await client.get(f"/api/engine/subscriptions/{sid}")).status_code == 404
        assert (await client.get("/api/engine/subscriptions/client/appa")).json()["data"] == []


class TestTheReferencesRules:
    """Rules the reference engine's servlets enforce, kept here."""

    async def test_start_must_be_before_stop(self, client: httpx.AsyncClient) -> None:
        """An inverted window is a strategy that never fires."""
        response = await client.post(
            "/api/engine/definitions",
            json={
                "strategyName": "late",
                "underlyingSymbol": "NIFTY",
                "exchange": "NSE",
                "legs": STRADDLE_LEGS,
                "startTime": "15:00:00",
                "stopTime": "09:30:00",
            },
        )
        assert response.status_code == 400
        assert "never fire" in response.json()["message"]

    async def test_winding_down_keeps_the_strategy_loadable(
        self, client: httpx.AsyncClient
    ) -> None:
        """Open positions still need their exit rules, so a WIND_DOWN strategy
        is built -- and therefore validated -- like an active one."""
        created = await define(client, isDirectional=True)  # no provider named
        response = await client.put(
            f"/api/engine/definitions/{created['strategyId']}/status/WIND_DOWN"
        )
        assert response.status_code == 400

        sound = await define(client, strategyName="sound")
        response = await client.put(
            f"/api/engine/definitions/{sound['strategyId']}/status/WIND_DOWN"
        )
        assert response.status_code == 200
        assert response.json()["data"]["status"] == "WIND_DOWN"

    async def test_activating_twice_is_refused(self, client: httpx.AsyncClient) -> None:
        await define(client)
        sid = (
            await client.post(
                "/api/engine/subscriptions",
                json={"tradingClientId": "appa", "strategyName": "straddle", "capital": 1000},
            )
        ).json()["data"]["subscriptionId"]
        response = await client.put(f"/api/engine/subscriptions/{sid}/activate")
        assert response.status_code == 400
        assert "already active" in response.json()["message"]

    async def test_the_list_filters_by_symbol_and_exchange(self, client: httpx.AsyncClient) -> None:
        await define(client, strategyName="nifty", underlyingSymbol="NIFTY")
        await define(client, strategyName="crude", underlyingSymbol="CRUDEOIL", exchange="MCX")
        by_symbol = (await client.get("/api/engine/definitions?symbol=crudeoil")).json()["data"]
        assert [d["strategyName"] for d in by_symbol] == ["crude"]
        by_exchange = (await client.get("/api/engine/definitions?exchange=NSE")).json()["data"]
        assert [d["strategyName"] for d in by_exchange] == ["nifty"]
