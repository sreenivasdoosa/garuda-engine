"""The one socket the Console talks over.

Behavioural: what a browser gets for what it sends. The rules worth pinning
are the ones that decide whether a page looks broken -- an unauthenticated
socket is refused at the handshake rather than opened and left silent, an
engineless API says so instead of going quiet, and a channel nobody subscribed
to sends nothing.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from garuda.api.routers.socket import build, tick_payload
from garuda.api.tokens import issue
from garuda.core.bus import InProcessEventBus
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.protocols.topics import TOPIC_POLICIES, Topic

pytestmark = pytest.mark.integration

SECRET = "a-test-secret"
NIFTY = InstrumentId("NSE:NIFTY")
AT = dt.datetime(2026, 9, 2, 9, 20, tzinfo=dt.UTC)


def a_tick(price: str = "25010.55") -> Tick:
    return Tick(
        instrument=NIFTY,
        last_price=Money(Decimal(price), Currency.INR),
        timestamp=AT,
    )


class FakeParts:
    def __init__(self, bus: InProcessEventBus) -> None:
        self.bus = bus


class FakeEngine:
    def __init__(self, bus: InProcessEventBus) -> None:
        self.parts = FakeParts(bus)


def app_with(engine: Any, bus: InProcessEventBus | None = None) -> FastAPI:
    app = FastAPI()
    app.state.engine = engine
    app.include_router(build(SECRET))

    # Publishing has to happen on the application's own event loop, which is
    # the loop the socket is being served on. A route is the simplest way for
    # a test to reach it.
    @app.post("/test/publish")
    async def publish(price: str = "25010.55") -> dict[str, bool]:
        assert bus is not None
        await bus.publish(Topic.TICKS, a_tick(price))
        return {"published": True}

    return app


def a_token() -> str:
    return issue("admin", SECRET)


class TestGettingIn:
    def test_a_socket_with_no_token_is_refused_at_the_handshake(self) -> None:
        """Refused rather than accepted-and-silent: a socket that opens and
        says nothing is indistinguishable from an outage."""
        client = TestClient(app_with(FakeEngine(InProcessEventBus(dict(TOPIC_POLICIES)))))

        with pytest.raises(WebSocketDisconnect), client.websocket_connect("/socket"):
            pass

    def test_a_socket_with_a_bad_token_is_refused(self) -> None:
        client = TestClient(app_with(FakeEngine(InProcessEventBus(dict(TOPIC_POLICIES)))))

        with (
            pytest.raises(WebSocketDisconnect),
            client.websocket_connect("/socket?token=not-a-token"),
        ):
            pass

    def test_a_valid_token_is_greeted(self) -> None:
        client = TestClient(app_with(FakeEngine(InProcessEventBus(dict(TOPIC_POLICIES)))))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            assert socket.receive_json() == {"type": "connected", "status": "ok"}


class TestWithoutAnEngine:
    def test_it_says_there_are_no_prices_rather_than_going_quiet(self) -> None:
        """What `serve --reload` gives. The Console must be able to tell this
        apart from a feed that has stopped."""
        client = TestClient(app_with(None))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            greeting = socket.receive_json()

        assert greeting["type"] == "disconnected"
        assert greeting["status"] == "no-engine"


class TestStreamingTicks:
    def test_a_subscribed_browser_receives_a_tick(self) -> None:
        bus = InProcessEventBus(dict(TOPIC_POLICIES))
        client = TestClient(app_with(FakeEngine(bus), bus))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            socket.receive_json()
            socket.send_json({"method": "subscribe", "subList": ["ticks"]})
            # The publish has to happen once the subscription is live; the
            # portal drives the event loop between sends.
            client.post("/test/publish")

            message = socket.receive_json()

        assert message["type"] == "tick"
        assert message["tick"]["instrument"] == "NSE:NIFTY"

    def test_a_price_arrives_as_an_exact_decimal_not_a_float(self) -> None:
        """A price that survives the engine exactly and reaches the browser as
        123.44999999999999 was corrupted at the last possible moment."""
        payload = tick_payload(a_tick("25010.55"))

        assert payload["tick"]["lastPrice"] == "25010.55"
        assert isinstance(payload["tick"]["lastPrice"], str)


class TestChannels:
    def test_nothing_is_sent_before_anything_is_subscribed(self) -> None:
        """A browser that has not asked for ticks must not be given them."""
        bus = InProcessEventBus(dict(TOPIC_POLICIES))
        client = TestClient(app_with(FakeEngine(bus), bus))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            socket.receive_json()
            client.post("/test/publish")
            socket.send_json({"method": "subscribe", "subList": ["terminal"]})
            client.post("/test/publish")
            # Only the greeting was ever sent; ask for ticks and one arrives.
            socket.send_json({"method": "subscribe", "subList": ["ticks"]})
            client.post("/test/publish")

            assert socket.receive_json()["type"] == "tick"

    def test_a_channel_this_engine_does_not_have_does_not_close_the_socket(self) -> None:
        """A Console built against a later engine will ask for channels this
        one has not got. Closing over it would take the working ones too."""
        bus = InProcessEventBus(dict(TOPIC_POLICIES))
        client = TestClient(app_with(FakeEngine(bus), bus))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            socket.receive_json()
            socket.send_json({"method": "subscribe", "subList": ["ticks", "orderbook-of-2027"]})
            client.post("/test/publish")

            assert socket.receive_json()["type"] == "tick"

    def test_a_frame_that_is_not_json_is_ignored(self) -> None:
        bus = InProcessEventBus(dict(TOPIC_POLICIES))
        client = TestClient(app_with(FakeEngine(bus), bus))

        with client.websocket_connect(f"/socket?token={a_token()}") as socket:
            socket.receive_json()
            socket.send_text("hello?")
            socket.send_json({"method": "subscribe", "subList": ["ticks"]})
            client.post("/test/publish")

            assert socket.receive_json()["type"] == "tick"
