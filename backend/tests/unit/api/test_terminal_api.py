"""The Terminal, from the Console's side: the routes and the socket channel.

The view is a stand-in that answers with rows a test wrote; what is being
pinned is the wire -- money as strings, refusals with the right status and
reason, a full set on subscribe and only the changed rows after that, and
an alert the moment it is raised.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient

from garuda.api import envelope
from garuda.api.routers import socket, terminal
from garuda.api.tokens import issue
from garuda.composition.terminal import (
    AccountNotTradingError,
    AccountSummary,
    Counts,
    Pnl,
    SquareOffReport,
    UnknownAccountError,
)
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain.alert import Alert, AlertLevel, EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.protocols.topics import TOPIC_POLICIES, Topic

SECRET = "a-test-secret"
NOW = datetime(2026, 10, 10, 4, 0, tzinfo=UTC)
APPA = TradingClientId("appa")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def summary(client_id: TradingClientId, *, unrealised: str = "0", trading: bool = True) -> Any:
    zero = Money(Decimal(0), Currency.INR)
    return AccountSummary(
        trading_client_id=client_id,
        display_name=client_id.value.title(),
        broker="zerodha",
        client_id="AB1234",
        is_trading=trading,
        unavailable_because=None if trading else "no broker session",
        counts=Counts(active=1 if trading else 0),
        paper_counts=Counts(),
        pnl=Pnl(realised=rupees("-750"), unrealised=rupees(unrealised), unpriced=0),
        paper_pnl=Pnl(zero, zero),
        positions=1 if trading else 0,
        paper_positions=0,
        as_of=NOW,
    )


class FakeView:
    """Answers with whatever rows the test put in."""

    def __init__(self) -> None:
        self.rows: list[Any] = [summary(APPA, unrealised="750")]
        self.square_offs: list[dict[str, Any]] = []

    def summaries(self) -> list[Any]:
        return list(self.rows)

    def summary(self, client_id: TradingClientId) -> Any:
        for row in self.rows:
            if row.trading_client_id == client_id:
                return row
        raise UnknownAccountError(f"{client_id} is not a trading client the engine knows")

    def trades(self, client_id: TradingClientId) -> Any:
        row = self.summary(client_id)
        if not row.is_trading:
            raise AccountNotTradingError("Appa: no broker session")

        return SimpleNamespace(open=[], active=[], completed=[], cancelled=[], failed=[])

    def positions(self, client_id: TradingClientId) -> list[Any]:
        self.summary(client_id)
        return []

    async def square_off(self, client_id: TradingClientId, **scope: Any) -> SquareOffReport:
        self.summary(client_id)
        self.square_offs.append({"client": client_id.value, **scope})
        if scope.get("product") == "OVERNIGHT":
            raise ValueError("'OVERNIGHT' is not a square-off scope")
        if scope.get("trade_id") == "t-done":
            return SquareOffReport(skipped={"t-done": "already finished"})
        return SquareOffReport(requested=("t-1",))


class FakeAlerts:
    def __init__(self) -> None:
        self.raised: list[Alert] = []

    def open_alerts(self, day: date) -> list[Alert]:
        return [a for a in self.raised if a.trading_day == day]


class FakeVenue:
    def trading_day_for(self, instant: datetime) -> date:
        return instant.date()


class FakeParts:
    def __init__(self, bus: InProcessEventBus, clock: ReplayClock) -> None:
        self.bus = bus
        self.clock = clock
        self.alerts = FakeAlerts()
        self.exchanges = [FakeVenue()]


class FakeEngine:
    def __init__(self, bus: InProcessEventBus, clock: ReplayClock) -> None:
        self.parts = FakeParts(bus, clock)


def an_alert(message: str = "the stop could not be placed") -> Alert:
    return Alert(
        level=AlertLevel.CRITICAL,
        entity_type=EntityType.SYSTEM,
        entity="Appa",
        operation="stop",
        message=message,
        raised_at=NOW,
        trading_day=NOW.date(),
    )


def app_with(view: FakeView | None, *, engine: FakeEngine | None) -> tuple[FastAPI, Any]:
    app = FastAPI()
    envelope.install(app)
    app.state.engine = engine
    app.state.terminal = view
    app.include_router(terminal.build())
    app.include_router(socket.build(SECRET))
    bus = engine.parts.bus if engine is not None else None
    clock = engine.parts.clock if engine is not None else None

    @app.post("/test/alert")
    async def raise_alert() -> dict[str, bool]:
        assert bus is not None
        assert engine is not None
        alert = an_alert()
        engine.parts.alerts.raised.append(alert)
        await bus.publish(Topic.ALERTS, alert)
        return {"raised": True}

    @app.post("/test/tick")
    async def publish_tick() -> dict[str, bool]:
        assert bus is not None
        await bus.publish(Topic.TICKS, Tick(InstrumentId("NSE:NIFTY"), rupees("25000"), NOW))
        return {"published": True}

    @app.post("/test/advance")
    async def advance() -> dict[str, bool]:
        assert clock is not None
        await clock.advance_by(timedelta(seconds=3))
        return {"advanced": True}

    return app, clock


def harness() -> tuple[TestClient, FakeView, FakeEngine]:
    bus = InProcessEventBus(dict(TOPIC_POLICIES))
    engine = FakeEngine(bus, ReplayClock(NOW, auto_advance=False))
    view = FakeView()
    app, _ = app_with(view, engine=engine)
    return TestClient(app), view, engine


def a_token() -> str:
    return issue("admin", SECRET)


class TestTheRoutes:
    def test_summaries_carry_money_as_strings(self) -> None:
        client, _, _ = harness()
        [row] = client.get("/api/terminal/summaries").json()["data"]
        assert row["tradingClientId"] == "appa"
        assert row["pnl"] == {
            "realised": "-750",
            "unrealised": "750",
            "total": "0",
            "unpriced": 0,
        }
        assert row["isTrading"] is True

    def test_without_an_engine_the_terminal_says_so(self) -> None:
        app, _ = app_with(None, engine=None)
        response = TestClient(app).get("/api/terminal/summaries")
        assert response.status_code == 503

    def test_an_unknown_account_is_a_404(self) -> None:
        client, _, _ = harness()
        assert client.get("/api/terminal/clients/nobody").status_code == 404

    def test_an_account_not_trading_answers_its_summary_and_no_trades(self) -> None:
        client, view, _ = harness()
        view.rows.append(summary(TradingClientId("amma"), trading=False))
        body = client.get("/api/terminal/clients/amma").json()
        assert body["data"]["trades"] is None
        assert body["data"]["summary"]["unavailableBecause"] == "no broker session"

    def test_square_off_passes_the_scope_through(self) -> None:
        client, view, _ = harness()
        response = client.post(
            "/api/terminal/clients/appa/square-off",
            json={"product": "INTRADAY", "strategies": ["straddle"]},
        )
        assert response.status_code == 200
        assert response.json()["data"]["requested"] == ["t-1"]
        assert view.square_offs == [
            {"client": "appa", "product": "INTRADAY", "strategies": ["straddle"]}
        ]

    def test_a_bad_scope_is_refused(self) -> None:
        client, _, _ = harness()
        response = client.post(
            "/api/terminal/clients/appa/square-off", json={"product": "OVERNIGHT"}
        )
        assert response.status_code == 400

    def test_one_trade_already_finished_is_a_conflict(self) -> None:
        client, _, _ = harness()
        response = client.post("/api/terminal/clients/appa/trades/t-done/square-off")
        assert response.status_code == 409
        assert "finished" in response.json()["message"]

    def test_todays_alerts_are_listed_newest_first(self) -> None:
        client, _, engine = harness()
        engine.parts.alerts.raised.append(an_alert("first"))
        later = Alert(
            level=AlertLevel.WARNING,
            entity_type=EntityType.SYSTEM,
            entity="Appa",
            operation="stop",
            message="second",
            raised_at=NOW + timedelta(minutes=1),
            trading_day=NOW.date(),
        )
        engine.parts.alerts.raised.append(later)
        rows = client.get("/api/terminal/alerts").json()["data"]
        assert [row["alertMessage"] for row in rows] == ["second", "first"]
        assert rows[1]["alertLevel"] == "CRITICAL"


class TestTheSocketChannel:
    def test_subscribing_gets_every_summary_first(self) -> None:
        client, _, _ = harness()
        with client.websocket_connect(f"/socket?token={a_token()}") as sock:
            sock.receive_json()
            sock.send_json({"method": "subscribe", "subList": ["terminal"]})
            client.post("/test/advance")
            message = sock.receive_json()
        assert message["type"] == "full"
        assert [row["tradingClientId"] for row in message["terminalSummaries"]] == ["appa"]

    def test_then_only_what_changed(self) -> None:
        client, view, _ = harness()
        with client.websocket_connect(f"/socket?token={a_token()}") as sock:
            sock.receive_json()
            sock.send_json({"method": "subscribe", "subList": ["terminal"]})
            client.post("/test/advance")
            assert sock.receive_json()["type"] == "full"

            view.rows = [summary(APPA, unrealised="900"), summary(TradingClientId("amma"))]
            client.post("/test/advance")
            message = sock.receive_json()

        assert message["type"] == "delta"
        changed = {row["tradingClientId"]: row for row in message["terminalSummaries"]}
        assert set(changed) == {"appa", "amma"}
        assert changed["appa"]["pnl"]["unrealised"] == "900"

    def test_an_alert_is_pushed_as_it_is_raised(self) -> None:
        client, _, _ = harness()
        with client.websocket_connect(f"/socket?token={a_token()}") as sock:
            sock.receive_json()
            sock.send_json({"method": "subscribe", "subList": ["terminal"]})
            client.post("/test/advance")
            sock.receive_json()
            client.post("/test/alert")
            message = sock.receive_json()
        assert message["type"] == "alert"
        assert message["alert"]["alertLevel"] == "CRITICAL"
        assert "stop could not be placed" in message["alert"]["alertMessage"]

    def test_nothing_terminal_is_sent_to_a_ticks_only_browser(self) -> None:
        """An alert and a summary pass happen, then a tick: the tick is the
        first thing that arrives, so neither of the others was sent."""
        client, _, _ = harness()
        with client.websocket_connect(f"/socket?token={a_token()}") as sock:
            sock.receive_json()
            sock.send_json({"method": "subscribe", "subList": ["ticks"]})
            client.post("/test/advance")
            client.post("/test/alert")
            client.post("/test/tick")
            message = sock.receive_json()
        assert message["type"] == "tick"
