"""Risk, as the Console edits and reads it.

Behavioural: rows go in at a scope, and the claims are about what the gate
would enforce on an order -- the narrowest row winning per column, with
where each value came from -- and about the rules the reference enforces at
the edge: one row per scope, a column dropped where it means nothing, the
three states of a kill switch, a source disarmed. And that every write
reaches the engine.
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
from garuda.api.routers import rms
from garuda.composition.risk import load_kill_switches, load_limits
from garuda.core.clock import ReplayClock
from garuda.persistence import models
from garuda.rms.killswitch import MANUAL

pytestmark = pytest.mark.integration

#: 09:30 in Kolkata on the 10th. The venue's day is what "today" means.
NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)
TODAY = dt.date(2026, 10, 10)
APPA = "appa-zerodha"
AMMA = "amma-zerodha"


class Reloads:
    def __init__(self) -> None:
        self.limits = 0
        self.switches = 0

    async def limits_hook(self) -> None:
        self.limits += 1

    async def switches_hook(self) -> None:
        self.switches += 1


@pytest.fixture
def reloads() -> Reloads:
    return Reloads()


@pytest.fixture
async def client(
    session_factory: async_sessionmaker[AsyncSession], reloads: Reloads
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
    app.state.reload_limits = reloads.limits_hook
    app.state.reload_kill_switches = reloads.switches_hook
    app.include_router(rms.build(session_factory, ReplayClock(NOW)))
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def add(client: httpx.AsyncClient, **body: Any) -> dict[str, Any]:
    response = await client.post("/api/rms-config", json=body)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()["data"]
    return created


async def effective(client: httpx.AsyncClient, **params: Any) -> dict[str, Any]:
    response = await client.get("/api/rms-config/effective", params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


# -- limits -------------------------------------------------------------------


class TestTheScopes:
    async def test_the_level_is_computed_from_the_columns(self, client: httpx.AsyncClient) -> None:
        """The reference's label disagreed with its columns; here it cannot."""
        rows = [
            await add(client, maxOrderQty=100),
            await add(client, exchange="nse", maxOrderQty=90),
            await add(client, symbol="nifty", maxOrderQty=80),
            await add(client, tradingClientId=APPA, maxOrderQty=70),
            await add(client, tradingClientId=APPA, symbol="NIFTY", maxOrderQty=60),
        ]
        assert [r["configLevel"] for r in rows] == [
            "GLOBAL",
            "EXCHANGE",
            "SYMBOL",
            "CLIENT",
            "CLIENT",
        ]
        assert rows[1]["exchange"] == "NSE"
        assert rows[2]["symbol"] == "NIFTY"
        assert rows[3]["tradingClient"] == "Appa"
        assert rows[4]["scope"] == "symbol NIFTY and client Appa"

    async def test_one_row_per_scope(self, client: httpx.AsyncClient) -> None:
        await add(client, segmentType="OPTIONS", maxOrderQty=100)
        response = await client.post(
            "/api/rms-config", json={"segmentType": "options", "maxOrderQty": 50}
        )
        assert response.status_code == 409
        assert "global for OPTIONS" in response.json()["message"]
        # A different segment is a different scope.
        await add(client, segmentType="FUTURES", maxOrderQty=50)

    async def test_an_unknown_exchange_client_or_segment_is_refused(
        self, client: httpx.AsyncClient
    ) -> None:
        assert (await client.post("/api/rms-config", json={"exchange": "LSE"})).status_code == 400
        assert (
            await client.post("/api/rms-config", json={"tradingClientId": "nobody"})
        ).status_code == 404
        response = await client.post("/api/rms-config", json={"segmentType": "CURRENCY"})
        assert response.status_code == 400
        assert "OPTIONS" in response.json()["message"]

    async def test_a_negative_limit_is_refused(self, client: httpx.AsyncClient) -> None:
        response = await client.post("/api/rms-config", json={"maxOrderQty": -1})
        assert response.status_code == 400


class TestWhatMeansNothingAtAScope:
    async def test_a_rate_limit_on_a_symbol_row_is_dropped_and_said(
        self, client: httpx.AsyncClient
    ) -> None:
        """The reference's applicability table: rates are the account's."""
        response = await client.post(
            "/api/rms-config",
            json={"symbol": "NIFTY", "maxOrdersPerSecond": 5, "maxOrderQty": 100},
        )
        assert response.status_code == 201
        body = response.json()
        assert body["data"]["maxOrdersPerSecond"] is None
        assert body["data"]["maxOrderQty"] == 100
        assert "maxOrdersPerSecond" in body["message"]
        assert "SYMBOL" in body["message"]

    async def test_a_stale_window_on_a_client_row_is_dropped(
        self, client: httpx.AsyncClient
    ) -> None:
        row = await add(client, tradingClientId=APPA, stalePriceSeconds=10, maxOrdersPerDay=50)
        assert row["stalePriceSeconds"] is None
        assert row["maxOrdersPerDay"] == 50

    async def test_a_row_seeded_by_hand_is_cleaned_when_the_engine_loads_it(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """A ported row that the reference would have silently ignored."""
        async with session_factory() as session:
            session.add(
                models.RmsConfigRow(
                    config_level="SYMBOL",
                    symbol="NIFTY",
                    max_orders_per_second=3,
                    max_order_qty=40,
                    is_active=True,
                )
            )
            await session.commit()
        book = await load_limits(session_factory)
        [row] = book.rows
        assert row.limits.max_orders_per_second is None
        assert row.limits.max_order_quantity == 40

    async def test_the_catalog_says_which_fields_apply_where_and_which_are_enforced(
        self, client: httpx.AsyncClient
    ) -> None:
        body = (await client.get("/api/rms-config/catalog")).json()["data"]
        assert body["fields"]["maxOrdersPerSecond"]["levels"] == ["GLOBAL", "CLIENT"]
        assert body["fields"]["stalePriceSeconds"]["levels"] == ["GLOBAL", "EXCHANGE"]
        assert body["fields"]["maxOrderQty"]["levels"] == ["GLOBAL", "EXCHANGE", "SYMBOL", "CLIENT"]
        assert body["fields"]["maxOrderQty"]["enforced"] is True
        assert body["fields"]["maxVixLevel"]["enforced"] is False
        assert body["killLevels"] == ["GLOBAL", "EXCHANGE", "SYMBOL", "CLIENT"]


class TestWhatTheGateResolves:
    async def test_the_narrowest_row_wins_per_column(self, client: httpx.AsyncClient) -> None:
        await add(client, maxOrderQty=100, maxOrderValue=1_000_000)
        await add(client, exchange="NSE", maxOrderQty=90)
        await add(client, tradingClientId=APPA, maxOrderQty=70)
        await add(client, symbol="NIFTY", maxOrderQty=60)

        resolved = await effective(
            client, exchange="NSE", symbol="NIFTY", tradingClientId=APPA, segmentType="OPTIONS"
        )

        assert resolved["config"]["maxOrderQty"] == 60
        assert resolved["sources"]["maxOrderQty"] == "symbol NIFTY"
        assert resolved["config"]["maxOrderValue"] == 1_000_000
        assert resolved["sources"]["maxOrderValue"] == "global"
        assert resolved["layersInScope"] == 4

    async def test_a_segment_row_applies_to_its_segment_only(
        self, client: httpx.AsyncClient
    ) -> None:
        await add(client, maxOrderQty=100)
        await add(client, segmentType="OPTIONS", maxOrderQty=20)

        options = await effective(client, segmentType="OPTIONS")
        futures = await effective(client, segmentType="FUTURES")

        assert options["config"]["maxOrderQty"] == 20
        assert futures["config"]["maxOrderQty"] == 100

    async def test_an_inactive_row_does_not_apply(self, client: httpx.AsyncClient) -> None:
        await add(client, maxOrderQty=100)
        narrow = await add(client, symbol="NIFTY", maxOrderQty=20)
        await client.put(f"/api/rms-config/{narrow['id']}", json={"isActive": False})

        resolved = await effective(client, symbol="NIFTY")

        assert resolved["config"]["maxOrderQty"] == 100

    async def test_nothing_configured_enforces_nothing_but_staleness(
        self, client: httpx.AsyncClient
    ) -> None:
        resolved = await effective(client, segmentType="OPTIONS")
        assert resolved["config"] == {"stalePriceSeconds": 30}
        assert resolved["sources"]["stalePriceSeconds"] == "default"
        assert "maxOrderQty" in resolved["enforced"]


class TestTellingTheEngineAboutLimits:
    async def test_every_write_reaches_the_engine(
        self, client: httpx.AsyncClient, reloads: Reloads
    ) -> None:
        row = await add(client, maxOrderQty=100)
        await client.put(f"/api/rms-config/{row['id']}", json={"maxOrderQty": 50})
        response = await client.delete(f"/api/rms-config/{row['id']}")
        assert response.status_code == 200
        assert reloads.limits == 3
        assert (await client.get("/api/rms-config")).json()["count"] == 0

    async def test_the_scope_of_a_row_cannot_be_edited_into_another(
        self, client: httpx.AsyncClient
    ) -> None:
        row = await add(client, maxOrderQty=100)
        saved = (await client.put(f"/api/rms-config/{row['id']}", json={"symbol": "NIFTY"})).json()[
            "data"
        ]
        assert saved["symbol"] is None
        assert saved["configLevel"] == "GLOBAL"


# -- the breach log -----------------------------------------------------------


async def breached(
    session_factory: async_sessionmaker[AsyncSession],
    *,
    at: dt.datetime,
    client_id: str = APPA,
    breach_type: str = "VOLUME_LOW",
    category: str = "LIQUIDITY",
    severity: int = 2,
    symbol: str = "NIFTY26OCT25000CE",
    details: str = "volume 400 is under 500",
) -> None:
    async with session_factory() as session:
        session.add(
            models.RmsBreachLogRow(
                trading_client_id=client_id,
                breach_time=at,
                strategy_name="straddle",
                trading_symbol=symbol,
                exchange="NSE",
                breach_type=breach_type,
                breach_category=category,
                breach_details=details,
                action_taken="ORDER_REJECTED",
                current_value="400",
                limit_value="500",
                severity=severity,
            )
        )
        await session.commit()


class TestTheBreachLog:
    async def test_a_page_counts_the_whole_filtered_set(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        for minute in range(5):
            await breached(session_factory, at=NOW + dt.timedelta(minutes=minute))
        await breached(
            session_factory,
            at=NOW,
            client_id=AMMA,
            breach_type="KILL_SWITCH_ACTIVE",
            category="SYSTEM",
            severity=5,
        )

        page = (
            await client.get("/api/rms-config/breaches", params={"page": 1, "pageSize": 4})
        ).json()["data"]

        assert len(page["data"]) == 4
        assert page["pagination"] == {
            "page": 1,
            "pageSize": 4,
            "totalCount": 6,
            "totalPages": 2,
            "hasNext": True,
            "hasPrev": False,
        }
        assert page["summary"] == {"highSeverity": 1, "uniqueClients": 2}
        newest = page["data"][0]
        assert newest["tradingClient"] in ("Appa", "Amma")
        assert newest["broker"] == "ZERODHA"

    async def test_the_filters_are_the_references(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await breached(session_factory, at=NOW, severity=1)
        await breached(session_factory, at=NOW, severity=2)
        await breached(session_factory, at=NOW, severity=3, client_id=AMMA)
        await breached(
            session_factory,
            at=NOW,
            breach_type="SPREAD_WIDE",
            severity=5,
            details="spread 9% is over 5%",
        )

        async def count(**params: Any) -> int:
            body = (await client.get("/api/rms-config/breaches", params=params)).json()
            return int(body["count"])

        assert await count(severity=1) == 1
        assert await count(severity=2) == 1
        assert await count(severity=3) == 2, "three and up is high"
        assert await count(tradingClientId=AMMA) == 1
        assert await count(type="spread_wide") == 1
        assert await count(category="LIQUIDITY") == 4
        assert await count(search="spread") == 1
        assert await count(search="amma") == 1, "the client's name is searchable"

    async def test_today_is_the_venues_day(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """23:30 UTC on the 9th is 05:00 on the 10th in Kolkata: today."""
        await breached(session_factory, at=dt.datetime(2026, 10, 9, 23, 30, tzinfo=dt.UTC))
        await breached(session_factory, at=dt.datetime(2026, 10, 9, 10, 0, tzinfo=dt.UTC))

        today = (await client.get("/api/rms-config/breaches/today")).json()
        assert today["count"] == 1

        ranged = (
            await client.get(
                "/api/rms-config/breaches",
                params={"startDate": "2026-10-09", "endDate": "2026-10-09"},
            )
        ).json()
        assert ranged["count"] == 1

    async def test_the_filters_come_from_the_vocabulary(self, client: httpx.AsyncClient) -> None:
        body = (await client.get("/api/rms-config/breach-filters")).json()["data"]
        assert "VOLUME_LOW" in body["typesByCategory"]["LIQUIDITY"]
        assert body["severities"]["KILL_SWITCH_ACTIVE"] == 5
        assert "SYSTEM" in body["categories"]


# -- kill switches ------------------------------------------------------------


async def status(client: httpx.AsyncClient) -> dict[str, Any]:
    body: dict[str, Any] = (await client.get("/api/rms-config/kill-switch")).json()["data"]
    return body


class TestKillSwitches:
    async def test_a_switch_set_is_in_force_today_and_reaches_the_engine(
        self,
        client: httpx.AsyncClient,
        session_factory: async_sessionmaker[AsyncSession],
        reloads: Reloads,
    ) -> None:
        response = await client.post(
            "/api/rms-config/kill-switch",
            json={"level": "client", "tradingClientId": APPA, "reason": "margin call"},
        )
        assert response.status_code == 200, response.text
        entry = response.json()["data"]
        assert entry["key"] == f"CLIENT|{APPA}"
        assert entry["active"] is True
        assert entry["source"] == MANUAL
        assert entry["tradingClient"] == "Appa"
        assert reloads.switches == 1

        loaded = await load_kill_switches(session_factory, today=TODAY)
        assert len(loaded) == 1
        assert loaded.switches[0].scope.trading_client == APPA

    async def test_every_level_needs_its_scope(self, client: httpx.AsyncClient) -> None:
        async def refused(body: dict[str, Any]) -> str:
            response = await client.post("/api/rms-config/kill-switch", json=body)
            assert response.status_code in (400, 404), response.text
            return str(response.json()["message"])

        assert "exchange" in await refused({"level": "EXCHANGE"})
        assert "symbol" in await refused({"level": "SYMBOL"})
        assert "trading client" in await refused({"level": "CLIENT"})
        assert "not a trading client" in await refused({"level": "CLIENT", "tradingClientId": "x"})
        assert "BROKER" in await refused({"level": "BROKER"})
        everything = await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL"})
        assert everything.json()["data"]["key"] == "GLOBAL"

    async def test_off_is_listed_and_removed_is_not(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """The reference's three states, each a separate operator action."""
        await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL"})
        await client.post(
            "/api/rms-config/kill-switch", json={"level": "EXCHANGE", "exchange": "NSE"}
        )

        off = await client.post("/api/rms-config/kill-switch/deactivate", json={"keys": ["GLOBAL"]})
        assert off.json()["data"] == {"deactivated": ["GLOBAL"], "unknown": []}
        listed = await status(client)
        assert {e["key"]: e["active"] for e in listed["switches"]} == {
            "GLOBAL": False,
            "EXCHANGE|NSE": True,
        }
        assert listed["activeCount"] == 1
        assert len(await load_kill_switches(session_factory, today=TODAY)) == 1

        gone = await client.post("/api/rms-config/kill-switch/remove", json={"keys": ["GLOBAL"]})
        assert gone.json()["data"]["removed"] == ["GLOBAL"]
        assert [e["key"] for e in (await status(client))["switches"]] == ["EXCHANGE|NSE"]

    async def test_setting_a_switch_turned_off_turns_it_back_on(
        self, client: httpx.AsyncClient
    ) -> None:
        await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL", "reason": "a"})
        await client.post("/api/rms-config/kill-switch/deactivate", json={"keys": ["GLOBAL"]})
        again = await client.post(
            "/api/rms-config/kill-switch", json={"level": "GLOBAL", "reason": "b"}
        )
        assert again.json()["data"]["active"] is True
        assert again.json()["data"]["reason"] == "b"
        assert len((await status(client))["switches"]) == 1, "one row per key per day"

    async def test_remove_all_clears_the_day(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL"})
        await client.post(
            "/api/rms-config/kill-switch", json={"level": "SYMBOL", "symbol": "nifty"}
        )
        cleared = await client.post("/api/rms-config/kill-switch/remove-all")
        assert sorted(cleared.json()["data"]["removed"]) == ["GLOBAL", "SYMBOL|NIFTY"]
        assert (await status(client))["switches"] == []
        assert len(await load_kill_switches(session_factory, today=TODAY)) == 0

    async def test_yesterdays_switch_is_not_todays(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(
                models.KillSwitchesRow(
                    created_date=TODAY - dt.timedelta(days=1),
                    key_name="GLOBAL",
                    level="GLOBAL",
                    active=True,
                    source=MANUAL,
                    created_at=NOW - dt.timedelta(days=1),
                    updated_at=NOW - dt.timedelta(days=1),
                )
            )
            await session.commit()
        assert (await status(client))["switches"] == []

    async def test_a_source_can_be_disarmed_and_its_switches_removed_with_it(
        self, client: httpx.AsyncClient, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        async with session_factory() as session:
            session.add(
                models.KillSwitchesRow(
                    created_date=TODAY,
                    key_name=f"CLIENT|{APPA}",
                    level="CLIENT",
                    trading_client_id=APPA,
                    active=True,
                    source="DAILY_LOSS",
                    reason="lost 40,000",
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
            await session.commit()
        before = await status(client)
        assert before["typeStates"] == {
            "DAILY_LOSS": True,
            "REJECTION_RATE": True,
            "VOLATILITY": True,
        }
        assert before["automaticSourcesBuilt"] is False

        disarmed = await client.post(
            "/api/rms-config/kill-switch-type",
            json={"source": "daily_loss", "enabled": False, "alsoRemoveInstances": True},
        )
        assert disarmed.json()["data"] == {
            "source": "DAILY_LOSS",
            "enabled": False,
            "instancesRemoved": 1,
        }
        after = await status(client)
        assert after["typeStates"]["DAILY_LOSS"] is False
        assert after["switches"] == []

        manual = await client.post(
            "/api/rms-config/kill-switch-type", json={"source": "MANUAL", "enabled": False}
        )
        assert manual.status_code == 400

    async def test_the_status_says_the_gate_is_always_on(self, client: httpx.AsyncClient) -> None:
        await add(client, maxOrderQty=100)
        await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL"})
        body = (await client.get("/api/rms-config/status")).json()["data"]
        assert body == {
            "enabled": True,
            "activeConfigRows": 1,
            "activeKillSwitchCount": 1,
            "breachesToday": 0,
        }


class _Venue:
    """Saturday evening on the venue's calendar belongs to Monday's session."""

    def trading_day_for(self, now: dt.datetime) -> dt.date:
        assert now == NOW
        return dt.date(2026, 10, 12)


class _Parts:
    def __init__(self) -> None:
        self.venues = type("Venues", (), {"all": (_Venue(),)})()


class _Engine:
    def __init__(self) -> None:
        self.parts = _Parts()


class TestWhichDayASwitchBelongsTo:
    async def test_the_engines_calendar_decides_so_the_page_and_the_loader_agree(
        self,
        client: httpx.AsyncClient,
        session_factory: async_sessionmaker[AsyncSession],
        reloads: Reloads,
    ) -> None:
        """A switch set on Saturday is Monday's: the engine loads Monday's rows,
        so the page must write them -- or the brake would stop nothing."""
        app = client._transport.app  # type: ignore[attr-defined]
        app.state.engine = _Engine()

        entry = (await client.post("/api/rms-config/kill-switch", json={"level": "GLOBAL"})).json()[
            "data"
        ]
        assert entry["createdDate"] == "2026-10-12"
        assert (await status(client))["date"] == "2026-10-12"
        assert len(await load_kill_switches(session_factory, today=dt.date(2026, 10, 12))) == 1
        assert len(await load_kill_switches(session_factory, today=TODAY)) == 0
        assert reloads.switches == 1
