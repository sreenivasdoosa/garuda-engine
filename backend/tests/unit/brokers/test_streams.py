"""Running an order stream per trading client.

The claims are about independence: one account's problem must cost that
account and nothing else.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Sequence
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from garuda.alerts.manager import AlertManager
from garuda.brokers.sessions import Account, Credentials, SessionResolver
from garuda.brokers.streams import AccountStreamManager
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.order import BrokerOrderId, Side
from garuda.domain.session import BrokerSession
from garuda.protocols.account import (
    AccountConnected,
    AccountDisconnected,
    AccountEvent,
    AccountProblem,
    AccountStream,
    OrderUpdate,
)

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 8, 31, 4, 0, tzinfo=UTC)
TODAY = datetime(2026, 8, 31, 3, 0, tzinfo=UTC)
YESTERDAY = datetime(2026, 8, 30, 3, 0, tzinfo=UTC)

ONE = TradingClientId("one")
TWO = TradingClientId("two")


def an_update(client_id: str = "AB1234") -> OrderUpdate:
    return OrderUpdate(
        broker_order_id=BrokerOrderId("1"),
        broker_client_id=client_id,
        client_order_id=None,
        instrument=None,
        side=Side.BUY,
        quantity=1,
        filled_quantity=0,
        status=None,
    )


class FakeStream:
    def __init__(self, trading_client: TradingClientId, events: Sequence[AccountEvent] = ()):
        self._trading_client = trading_client
        self._events = list(events)
        self.connected = False
        self.closed = False

    @property
    def trading_client(self) -> TradingClientId:
        return self._trading_client

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False
        self.closed = True

    async def events(self) -> AsyncIterator[AccountEvent]:
        for event in self._events:
            yield event


def account(
    name: TradingClientId, client_id: str, *, websocket: bool = True, enabled: bool = True
) -> Account:
    return Account(
        id=name,
        broker="zerodha",
        client_id=client_id,
        enabled=enabled,
        api_key="key",
        websocket_enabled=websocket,
    )


def alerts(raised: list[Alert] | None = None) -> AlertManager:
    async def sink(alert: Alert) -> None:
        if raised is not None:
            raised.append(alert)

    return AlertManager(
        clock=ReplayClock(NOW),
        bus=InProcessEventBus(),
        trading_day_for=lambda now: NOW.date(),
        sink=sink,
    )


def manager(
    accounts: Sequence[Account],
    sessions: dict[TradingClientId, BrokerSession],
    streams: dict[TradingClientId, FakeStream] | None = None,
    handled: list[tuple[AccountEvent, TradingClientId]] | None = None,
    fail_for: set[TradingClientId] | None = None,
    raised: list[Alert] | None = None,
) -> AccountStreamManager:
    resolver = SessionResolver({a.id: a for a in accounts}, sessions, timezone=IST)
    built = streams if streams is not None else {}

    async def factory(credentials: Credentials) -> AccountStream:
        if fail_for and credentials.trading_client in fail_for:
            raise ConnectionError("the provider refused the socket")
        stream = built.get(credentials.trading_client) or FakeStream(credentials.trading_client)
        built[credentials.trading_client] = stream
        return stream

    async def handler(event: AccountEvent, trading_client: TradingClientId) -> None:
        if handled is not None:
            handled.append((event, trading_client))

    return AccountStreamManager(resolver, factory, ReplayClock(NOW), handler, alerts(raised))


async def settle() -> None:
    """Let the consumer tasks run to completion."""
    for _ in range(5):
        await asyncio.sleep(0)


class TestStarting:
    async def test_a_stream_opens_for_each_eligible_account(self) -> None:
        streams: dict[TradingClientId, FakeStream] = {}
        subject = manager(
            [account(ONE, "AB1234"), account(TWO, "CD5678")],
            {ONE: BrokerSession("AB1234", "t1", TODAY), TWO: BrokerSession("CD5678", "t2", TODAY)},
            streams,
        )
        report = await subject.start(NOW)
        try:
            assert set(report.started) == {ONE, TWO}
            assert streams[ONE].is_connected
            assert streams[TWO].is_connected
        finally:
            await subject.stop()

    async def test_an_account_with_the_socket_turned_off_gets_none(self) -> None:
        subject = manager(
            [account(ONE, "AB1234", websocket=False)],
            {ONE: BrokerSession("AB1234", "t1", TODAY)},
        )
        report = await subject.start(NOW)
        assert report.started == ()
        assert report.unavailable == {}

    async def test_one_account_not_logged_in_does_not_stop_the_others(self) -> None:
        """Three of five logged in should trade on three."""
        subject = manager(
            [account(ONE, "AB1234"), account(TWO, "CD5678")],
            {ONE: BrokerSession("AB1234", "t1", TODAY)},
        )
        report = await subject.start(NOW)
        try:
            assert report.started == (ONE,)
            assert TWO in report.unavailable
            assert "no broker session" in report.unavailable[TWO]
        finally:
            await subject.stop()

    async def test_an_expired_session_is_reported_not_raised(self) -> None:
        subject = manager([account(ONE, "AB1234")], {ONE: BrokerSession("AB1234", "t1", YESTERDAY)})
        report = await subject.start(NOW)
        assert not report.any_started
        assert "log in again" in report.unavailable[ONE]

    async def test_a_socket_that_will_not_connect_is_recorded_against_that_account(
        self,
    ) -> None:
        subject = manager(
            [account(ONE, "AB1234"), account(TWO, "CD5678")],
            {ONE: BrokerSession("AB1234", "t1", TODAY), TWO: BrokerSession("CD5678", "t2", TODAY)},
            fail_for={TWO},
        )
        report = await subject.start(NOW)
        try:
            assert report.started == (ONE,)
            assert "ConnectionError" in report.unavailable[TWO]
            assert subject.health[TWO].failures == 1
        finally:
            await subject.stop()

    async def test_starting_twice_does_not_double_the_streams(self) -> None:
        streams: dict[TradingClientId, FakeStream] = {}
        subject = manager(
            [account(ONE, "AB1234")], {ONE: BrokerSession("AB1234", "t1", TODAY)}, streams
        )
        await subject.start(NOW)
        try:
            await subject.start(NOW)
            assert len(subject.running) == 1
        finally:
            await subject.stop()


class TestConsuming:
    async def test_updates_reach_the_engine_with_the_stream_they_came_on(self) -> None:
        handled: list[tuple[AccountEvent, TradingClientId]] = []
        streams = {ONE: FakeStream(ONE, [AccountConnected(ONE, NOW), an_update()])}
        subject = manager(
            [account(ONE, "AB1234")],
            {ONE: BrokerSession("AB1234", "t1", TODAY)},
            streams,
            handled,
        )
        await subject.start(NOW)
        await settle()
        await subject.stop()

        assert [client for _, client in handled] == [ONE, ONE]
        assert subject.health[ONE].order_updates == 1

    async def test_a_handler_that_raises_does_not_kill_the_stream(self) -> None:
        """The next update may be the fill that matters."""
        seen: list[AccountEvent] = []

        async def handler(event: AccountEvent, trading_client: TradingClientId) -> None:
            seen.append(event)
            if len(seen) == 1:
                raise RuntimeError("the engine blew up on this one")

        resolver = SessionResolver(
            {ONE: account(ONE, "AB1234")},
            {ONE: BrokerSession("AB1234", "t1", TODAY)},
            timezone=IST,
        )
        stream = FakeStream(ONE, [an_update(), an_update(), an_update()])

        async def factory(credentials: Credentials) -> AccountStream:
            return stream

        subject = AccountStreamManager(resolver, factory, ReplayClock(NOW), handler, alerts())
        await subject.start(NOW)
        await settle()
        await subject.stop()

        assert len(seen) == 3

    async def test_problems_are_counted_without_dropping_the_stream(self) -> None:
        streams = {ONE: FakeStream(ONE, [AccountProblem(ONE, "a bad frame", NOW), an_update()])}
        subject = manager(
            [account(ONE, "AB1234")], {ONE: BrokerSession("AB1234", "t1", TODAY)}, streams
        )
        await subject.start(NOW)
        await settle()
        await subject.stop()

        assert subject.health[ONE].problems == 1
        assert subject.health[ONE].order_updates == 1


class TestReplacing:
    async def test_a_stream_that_ended_is_reopened(self) -> None:
        opened: list[FakeStream] = []

        resolver = SessionResolver(
            {ONE: account(ONE, "AB1234")},
            {ONE: BrokerSession("AB1234", "t1", TODAY)},
            timezone=IST,
        )

        async def factory(credentials: Credentials) -> AccountStream:
            stream = FakeStream(ONE, [an_update()] if not opened else [])
            opened.append(stream)
            return stream

        async def handler(event: AccountEvent, trading_client: TradingClientId) -> None: ...

        subject = AccountStreamManager(resolver, factory, ReplayClock(NOW), handler, alerts())
        await subject.start(NOW)
        await settle()

        try:
            report = await subject.reconcile(NOW)
            assert report.started == (ONE,)
            assert len(opened) == 2, "the ended stream was replaced"
            assert opened[0].closed, "and the old one was closed, not merely dropped"
        finally:
            await subject.stop()

    async def test_stopping_closes_every_stream(self) -> None:
        streams: dict[TradingClientId, FakeStream] = {}
        subject = manager(
            [account(ONE, "AB1234"), account(TWO, "CD5678")],
            {ONE: BrokerSession("AB1234", "t1", TODAY), TWO: BrokerSession("CD5678", "t2", TODAY)},
            streams,
        )
        await subject.start(NOW)
        await subject.stop()

        assert all(stream.closed for stream in streams.values())
        assert subject.running == frozenset()

    async def test_stopping_twice_is_safe(self) -> None:
        subject = manager([account(ONE, "AB1234")], {ONE: BrokerSession("AB1234", "t1", TODAY)})
        await subject.start(NOW)
        await subject.stop()
        await subject.stop()
        assert subject.running == frozenset()


class TestWhatTheOperatorSees:
    """An alert nobody can act on without a database query is not an alert."""

    def opaque(self) -> Account:
        return Account(
            id=TradingClientId("a3f9c2e1-0b44-4c1e-9a77-2d5f8e6b1c30"),
            broker="zerodha",
            client_id="AB1234",
            display_name="Appa",
            api_key="key",
        )

    async def test_a_stream_that_cannot_start_names_the_account_readably(self) -> None:
        raised: list[Alert] = []
        account = self.opaque()
        subject = manager([account], {}, raised=raised)

        await subject.start(NOW)

        assert raised, "an account with no session must tell the operator"
        alert = raised[0]
        assert alert.entity == "Appa (zerodha:AB1234)"
        assert str(account.id) not in alert.entity
        assert str(account.id) not in alert.message

    async def test_a_connected_stream_says_so_readably(self) -> None:
        raised: list[Alert] = []
        account = self.opaque()
        subject = manager(
            [account], {account.id: BrokerSession("AB1234", "t1", TODAY)}, raised=raised
        )
        await subject.start(NOW)
        try:
            assert [a.entity for a in raised] == ["Appa (zerodha:AB1234)"]
        finally:
            await subject.stop()

    async def test_a_disconnection_reaches_the_operator(self) -> None:
        raised: list[Alert] = []
        account = self.opaque()
        streams = {
            account.id: FakeStream(
                account.id, [AccountDisconnected(account.id, "token expired", NOW)]
            )
        }
        subject = manager(
            [account],
            {account.id: BrokerSession("AB1234", "t1", TODAY)},
            streams,
            raised=raised,
        )
        await subject.start(NOW)
        await settle()
        await subject.stop()

        messages = [a.message for a in raised]
        assert any("token expired" in message for message in messages)

    async def test_an_account_with_no_display_name_still_reads_sensibly(self) -> None:
        """A half-configured account must not produce a blank alert."""
        raised: list[Alert] = []
        account = Account(
            id=TradingClientId("abc123"), broker="zerodha", client_id="AB1234", api_key="key"
        )
        await manager([account], {}, raised=raised).start(NOW)
        assert raised[0].entity == "abc123 (zerodha:AB1234)"
