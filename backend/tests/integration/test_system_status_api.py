"""System Status, from the Console's side.

The engine's half comes through a stand-in view that answers with rows a
test wrote; the tables' half is real. What is pinned is the wire -- which
panels answer without an engine and what they say, the counts the tables
contribute, the session rule for an account, and the probe's refusal when
there is nothing to probe.
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
from garuda.api.routers import system_status
from garuda.composition.status import (
    AccountStatus,
    FeedStatus,
    HealthCheck,
    LoopStatus,
    ProbeResult,
    ProcessStatus,
    RiskStatus,
    VenueStatus,
)
from garuda.core.clock import ReplayClock
from garuda.core.timeline import TimelineEvent, TimelinePhase
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.phases import DayPhase, PhaseInstant
from garuda.persistence import models
from garuda.persistence.secrets import SecretBox
from garuda.rms.killswitch import ActiveKillSwitch, KillSwitchScope

pytestmark = pytest.mark.integration

#: 09:30 in Kolkata on Saturday the 10th.
NOW = dt.datetime(2026, 10, 10, 4, 0, tzinfo=dt.UTC)
TODAY = dt.date(2026, 10, 10)
SECRETS = SecretBox("a-test-key")


class FakeView:
    """Answers with the rows a test put in."""

    def __init__(self) -> None:
        self.account_rows = [
            AccountStatus("appa", "Appa", "ZERODHA", "AB1234", True, True, None, True),
            AccountStatus(
                "amma", "Amma", "ZERODHA", "CD5678", True, False, "no broker session", False
            ),
        ]
        self.switches: tuple[ActiveKillSwitch, ...] = ()
        self.ran: list[tuple[str, str, dt.date | None]] = []

    def process(self) -> ProcessStatus:
        return ProcessStatus(
            version="0.1.0",
            python="3.12.0",
            started_at=NOW - dt.timedelta(hours=2),
            uptime=dt.timedelta(hours=2),
            cpu_count=4,
            load_average=None,
            process_rss_mb=180,
            system_memory_total_mb=8000,
            system_memory_available_mb=3000,
            open_file_descriptors=40,
            max_file_descriptors=1024,
            threads=3,
            asyncio_tasks=7,
        )

    def feed(self) -> FeedStatus:
        return FeedStatus(
            service=None, state="INACTIVE", any_market_open=False, history_provider=None
        )

    def loops(self) -> LoopStatus:
        return LoopStatus(
            runner_running=True,
            trade_loops_started=False,
            accounts_cycling=frozenset(),
            strategy_loop=None,
        )

    def accounts(self) -> list[AccountStatus]:
        return list(self.account_rows)

    def venues(self) -> list[VenueStatus]:
        return [
            VenueStatus(
                code="NSE",
                name="NSE",
                timezone="Asia/Kolkata",
                trading_day=TODAY,
                is_trading_day=False,
                is_open=False,
                sessions=(),
                next_phase=PhaseInstant(
                    "NSE",
                    dt.date(2026, 10, 12),
                    DayPhase.DAY_INIT,
                    dt.datetime(2026, 10, 12, 0, 45, tzinfo=dt.UTC),
                ),
            )
        ]

    def risk(self) -> RiskStatus:
        return RiskStatus(kill_switches=self.switches, limit_rows=3)

    def instrument_files(self) -> list[Any]:
        return []

    def startup_events(self) -> list[TimelineEvent]:
        return [
            TimelineEvent(NOW, "Finished application startup -- took 8s", TimelinePhase.STARTUP)
        ]

    def day_events(self) -> list[TimelineEvent]:
        return []

    async def run_phase(self, exchange: str, phase: str, trading_day: dt.date | None) -> str | None:
        self.ran.append((exchange.upper(), phase.upper(), trading_day))
        if phase.upper() == "EOD":
            return "archive: RuntimeError: disk full"
        if phase.upper() not in {"DAY_INIT", "ALGO_START", "REPORTS", "EOD"}:
            raise ValueError(f"{phase!r} is not a phase")
        return None

    async def health_check(self) -> HealthCheck:
        return HealthCheck(
            instrument=InstrumentId("NSE:NIFTY_50"),
            tick=ProbeResult(
                ok=True,
                latency=dt.timedelta(milliseconds=1),
                last_price=Money.of("25012.35", Currency.INR),
                at=NOW,
            ),
            history=ProbeResult(
                ok=False,
                latency=dt.timedelta(milliseconds=420),
                error="SessionUnavailableError: no provider is logged in",
                interval="5m",
            ),
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
        for name in ("zerodha", "dhan"):
            session.add(
                models.BrokersRow(
                    broker_name=name,
                    enabled=True,
                    stopped=name == "dhan",
                    description=name,
                    provider=None if name == "zerodha" else name,
                    use_dealer_apis=False,
                    server_url=f"https://api.{name}.example",
                    web_socket_enabled=True,
                    api_version=1,
                    server_start_time="08:00",
                    order_update_interval_secs=30,
                    position_update_interval_secs=60,
                    mtf_interest_rate_per_annum=Decimal(0),
                )
            )
        for client_id, name in (("appa", "Appa"), ("amma", "Amma"), ("thatha", "Thatha")):
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
        # The accounts first: the rows below refer to them, and the models
        # do not declare the keys, so the unit of work cannot order them.
        await session.commit()
        session.add(
            models.TradingClientLoginStatusRow(
                trading_client_id="appa",
                client_id="APPA",
                is_login_success=True,
                access_token_encrypted=SECRETS.seal("live"),
                session_created_on=NOW,
                updated_on=NOW,
            )
        )
        session.add(
            models.TradingClientLoginStatusRow(
                trading_client_id="amma",
                client_id="AMMA",
                is_login_success=False,
                login_error="the vendor refused the request token",
                updated_on=NOW,
            )
        )
        for name, status in (
            ("straddle", "ACTIVE"),
            ("strangle", "WIND_DOWN"),
            ("old", "INACTIVE"),
        ):
            session.add(
                models.StrategyDefinitionsRow(
                    strategy_name=name,
                    underlying_symbol="NIFTY",
                    exchange="NSE",
                    trade_mode="SPEC",
                    status=status,
                    tick_trigger_enabled=status == "ACTIVE",
                    scheduled_trigger_enabled=True,
                    exclude_monthly_expiry=False,
                    use_premium_balancing=True,
                    catch_up_missed_tranches=True,
                    adaptive_tranches_enabled=False,
                    created_at=NOW,
                    updated_at=NOW,
                )
            )
        session.add(
            models.SubscriptionsRow(
                trading_client_id="appa",
                strategy_name="straddle",
                is_active=True,
                is_paper_trading=False,
            )
        )
        session.add(
            models.SubscriptionsRow(
                trading_client_id="amma",
                strategy_name="straddle",
                is_active=False,
                is_paper_trading=True,
            )
        )
        session.add(models.KillSwitchTypesRow(source="VOLATILITY", enabled=False, updated_at=NOW))
        session.add(
            models.RmsBreachLogRow(
                trading_client_id="appa",
                breach_time=NOW,
                strategy_name="straddle",
                trading_symbol="NIFTY26OCT25000CE",
                exchange="NSE",
                breach_type="ORDER_VALUE_EXCEEDED",
                breach_category="ORDER",
                breach_details="too big",
                action_taken="ORDER_REJECTED",
                current_value="400",
                limit_value="500",
                severity=3,
            )
        )
        await session.commit()


def app_with(view: FakeView | None, sessions: async_sessionmaker[AsyncSession]) -> FastAPI:
    app = FastAPI()
    envelope.install(app)
    app.state.status = view
    app.include_router(system_status.build(sessions, ReplayClock(NOW)))
    return app


@pytest.fixture
async def attached(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[tuple[httpx.AsyncClient, FakeView]]:
    await seed(session_factory)
    view = FakeView()
    transport = httpx.ASGITransport(app=app_with(view, session_factory))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http, view


@pytest.fixture
async def detached(
    session_factory: async_sessionmaker[AsyncSession],
) -> AsyncIterator[httpx.AsyncClient]:
    await seed(session_factory)
    transport = httpx.ASGITransport(app=app_with(None, session_factory))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def snapshot(http: httpx.AsyncClient) -> dict[str, Any]:
    response = await http.get("/api/system-status")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()["data"]
    return body


class TestTheSnapshot:
    async def test_the_tables_half(self, attached: tuple[httpx.AsyncClient, FakeView]) -> None:
        http, _ = attached
        body = await snapshot(http)

        assert body["engineAttached"] is True
        assert body["strategies"]["definitions"] == {
            "total": 3,
            "active": 1,
            "windDown": 1,
            "inactive": 1,
            "tickEnabled": 1,
            "scheduledEnabled": 3,
            "signalEnabled": 0,
            "periodicEnabled": 0,
        }
        assert body["strategies"]["subscriptions"] == {
            "total": 2,
            "active": 1,
            "inactive": 1,
            "paper": 1,
            "live": 1,
        }
        assert body["risk"]["breachesToday"] == 1
        assert body["risk"]["killSwitchTypes"] == {
            "DAILY_LOSS": True,
            "REJECTION_RATE": True,
            "VOLATILITY": False,
        }
        assert body["risk"]["limitRows"] == 3

    async def test_an_accounts_session_follows_the_reference_rule(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        accounts = (await snapshot(http))["accounts"]

        by_id = {row["tradingClientId"]: row for row in accounts["rows"]}
        assert by_id["appa"]["session"] == "LOGGED_IN"
        assert by_id["amma"]["session"] == "FAILED"
        assert by_id["amma"]["loginError"] == "the vendor refused the request token"
        assert by_id["thatha"]["session"] == "NONE"
        assert accounts["configured"] == 3
        assert accounts["loggedIn"] == 1
        assert accounts["failed"] == 1
        assert accounts["loggedOut"] == 1
        # The engine's half, merged by id.
        assert by_id["appa"]["isTrading"] is True
        assert by_id["amma"]["unavailableBecause"] == "no broker session"
        assert by_id["thatha"]["isTrading"] is False

    async def test_brokers_count_their_accounts(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        brokers = (await snapshot(http))["brokers"]
        assert brokers["total"] == 2
        assert brokers["stopped"] == 1
        [dhan, zerodha] = brokers["rows"]
        assert zerodha == {
            "name": "zerodha",
            "enabled": True,
            "stopped": False,
            "accounts": 3,
            "loggedIn": 1,
            "trading": 1,
        }
        assert dhan["accounts"] == 0

    async def test_the_engines_half(self, attached: tuple[httpx.AsyncClient, FakeView]) -> None:
        http, view = attached
        view.switches = (
            ActiveKillSwitch(
                KillSwitchScope(trading_client="appa"), reason="manual", source="MANUAL"
            ),
        )
        body = await snapshot(http)

        assert body["runtime"]["uptimeSeconds"] == 7200
        assert body["runtime"]["systemMemoryUsedMb"] == 5000
        assert body["feed"]["state"] == "INACTIVE"
        assert body["feed"]["status"] == "stopped"
        assert body["loops"]["runnerRunning"] is True
        [nse] = body["venues"]["rows"]
        assert nse["nextPhase"] == {"phase": "DAY_INIT", "at": "2026-10-12T00:45:00+00:00"}
        assert body["venues"]["anyMarketOpen"] is False
        assert body["tradingDay"] == "2026-10-10", "the engine's own reckoning of the day"
        assert body["risk"]["activeKillSwitches"] == 1
        assert body["risk"]["killSwitches"][0]["tradingClient"] == "appa"

    async def test_without_an_engine_the_tables_still_answer(
        self, detached: httpx.AsyncClient
    ) -> None:
        body = await snapshot(detached)
        assert body["engineAttached"] is False
        assert body["runtime"] is None
        assert body["feed"] is None
        assert body["venues"] is None
        assert body["strategies"]["definitions"]["total"] == 3
        assert body["accounts"]["configured"] == 3
        row = body["accounts"]["rows"][0]
        assert row["isTrading"] is False
        assert row["unavailableBecause"] == "the API is running without an engine"
        assert body["risk"]["limitRows"] is None
        assert body["tradingDay"] == "2026-10-10", "the venue's date, from its timezone"


class TestTheProbe:
    async def test_it_answers_both_halves(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        response = await http.get("/api/system-status/health-check")
        assert response.status_code == 200
        body = response.json()["data"]
        assert body["instrument"] == "NSE:NIFTY_50"
        assert body["tick"]["ok"] is True
        assert body["tick"]["lastPrice"] == "25012.35"
        assert body["history"]["ok"] is False
        assert body["history"]["latencyMs"] == 420
        assert body["history"]["interval"] == "5m"

    async def test_without_an_engine_there_is_nothing_to_probe(
        self, detached: httpx.AsyncClient
    ) -> None:
        response = await detached.get("/api/system-status/health-check")
        assert response.status_code == 503


class TestRunningAPhase:
    async def test_the_press_reaches_the_runner(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, view = attached
        response = await http.post(
            "/api/system-status/run-phase",
            json={"exchange": "nse", "phase": "reports", "tradingDay": "2026-10-12"},
        )
        assert response.status_code == 200, response.text
        assert response.json()["data"]["ran"] is True
        assert view.ran == [("NSE", "REPORTS", dt.date(2026, 10, 12))]

    async def test_a_failure_is_reported_not_hidden(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        body = (
            await http.post(
                "/api/system-status/run-phase", json={"exchange": "NSE", "phase": "EOD"}
            )
        ).json()
        assert body["data"]["ran"] is False
        assert "disk full" in body["data"]["failure"]
        assert "failed" in body["message"]

    async def test_bad_inputs_are_refused(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        assert (
            await http.post(
                "/api/system-status/run-phase", json={"exchange": "NSE", "phase": "LUNCH"}
            )
        ).status_code == 400
        assert (
            await http.post(
                "/api/system-status/run-phase",
                json={"exchange": "NSE", "phase": "REPORTS", "tradingDay": "monday"},
            )
        ).status_code == 400

    async def test_without_an_engine_nothing_can_run(self, detached: httpx.AsyncClient) -> None:
        assert (
            await detached.post(
                "/api/system-status/run-phase", json={"exchange": "NSE", "phase": "REPORTS"}
            )
        ).status_code == 503


class TestTheTimeline:
    async def test_it_is_read_newest_first_as_recorded(
        self, attached: tuple[httpx.AsyncClient, FakeView]
    ) -> None:
        http, _ = attached
        body = (await http.get("/api/system-status/init-timeline")).json()["data"]
        assert body["startup"] == [
            {"timestamp": NOW.isoformat(), "message": "Finished application startup -- took 8s"}
        ]
        assert body["day"] == []

    async def test_without_an_engine_it_is_empty_and_says_so(
        self, detached: httpx.AsyncClient
    ) -> None:
        body = (await detached.get("/api/system-status/init-timeline")).json()["data"]
        assert body == {"startup": [], "day": [], "engineAttached": False}
