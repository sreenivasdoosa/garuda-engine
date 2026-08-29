"""Alerts.

The claims are about what an operator ends up looking at: how many lines, in
whose language, and whether a storm buries what matters.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from garuda.alerts.manager import AlertManager
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain.alert import Alert, AlertLevel, EntityType
from garuda.domain.client import BrokerCode, TradingClient, TradingClientId
from garuda.domain.errors import DomainError
from garuda.protocols.topics import Topic

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
DAY = date(2026, 8, 31)


def manager(clock: ReplayClock | None = None, sink: list[Alert] | None = None) -> AlertManager:
    async def store(alert: Alert) -> None:
        if sink is not None:
            sink.append(alert)

    return AlertManager(
        clock=clock or ReplayClock(T0),
        bus=InProcessEventBus(),
        trading_day_for=lambda now: DAY,
        sink=store,
    )


class TestNamingThingsReadably:
    def test_an_alert_must_name_something(self) -> None:
        with pytest.raises(DomainError, match="readably"):
            Alert(
                level=AlertLevel.WARNING,
                entity_type=EntityType.BROKER,
                entity="  ",
                operation="login",
                message="failed",
                raised_at=T0,
                trading_day=DAY,
            )

    def test_a_trading_client_reads_as_a_person_would_say_it(self) -> None:
        """The operator does not know what the internal id is."""
        client = TradingClient(
            id=TradingClientId("a3f9c2e1-0b44-4c1e-9a77-2d5f8e6b1c30"),
            display_name="Appa",
            broker=BrokerCode.ZERODHA,
            client_id="AB1234",
        )
        assert str(client) == "Appa (ZERODHA:AB1234)"
        assert str(client.id) not in str(client)

    async def test_the_line_an_operator_reads_carries_no_internal_ids(self) -> None:
        subject = manager()
        alert = await subject.warning(
            EntityType.BROKER, "Appa (ZERODHA:AB1234)", "login", "the session expired"
        )
        assert alert is not None
        assert "Appa (ZERODHA:AB1234)" in alert.describe()
        assert "the session expired" in alert.describe()


class TestCoalescing:
    async def test_a_repeat_advances_a_count_rather_than_adding_a_row(self) -> None:
        """A socket flapping all night is one line, not two hundred."""
        subject = manager()
        for _ in range(200):
            await subject.warning(
                EntityType.BROKER,
                "Appa (ZERODHA:AB1234)",
                "reconnect",
                "socket dropped",
                key="broker-socket:appa",
            )

        (alert,) = subject.open_alerts(DAY)
        assert alert.occurrences == 200
        assert alert.is_repeat

    async def test_the_latest_wording_wins(self) -> None:
        """The fiftieth failure says something different from the first."""
        subject = manager()
        await subject.warning(EntityType.BROKER, "Appa", "reconnect", "socket dropped", key="k")
        alert = await subject.warning(
            EntityType.BROKER, "Appa", "reconnect", "still down after an hour", key="k"
        )
        assert alert is not None
        assert alert.message == "still down after an hour"

    async def test_severity_only_ever_rises(self) -> None:
        """A problem that got worse must not be softened by a later info."""
        subject = manager()
        await subject.critical(EntityType.BROKER, "Appa", "login", "session expired", key="k")
        alert = await subject.info(EntityType.BROKER, "Appa", "login", "retrying", key="k")
        assert alert is not None
        assert alert.level is AlertLevel.CRITICAL

    async def test_the_first_and_latest_times_are_both_kept(self) -> None:
        clock = ReplayClock(T0)
        subject = manager(clock)
        await subject.warning(EntityType.FEED, "Kite", "stall", "no ticks", key="k")
        await clock.advance_to(T0 + timedelta(minutes=30))
        alert = await subject.warning(EntityType.FEED, "Kite", "stall", "still none", key="k")

        assert alert is not None
        assert alert.began_at == T0
        assert alert.raised_at == T0 + timedelta(minutes=30)

    async def test_alerts_without_a_key_never_coalesce(self) -> None:
        """A one-shot event happening twice really is two events."""
        raised: list[Alert] = []
        subject = manager(sink=raised)
        await subject.info(EntityType.SYSTEM, "engine", "start", "day started")
        await subject.info(EntityType.SYSTEM, "engine", "start", "day started")
        assert len(raised) == 2
        assert subject.open_alerts(DAY) == []

    async def test_different_keys_stay_separate(self) -> None:
        subject = manager()
        await subject.warning(EntityType.BROKER, "Appa", "reconnect", "dropped", key="appa")
        await subject.warning(EntityType.BROKER, "Amma", "reconnect", "dropped", key="amma")
        assert len(subject.open_alerts(DAY)) == 2

    async def test_a_new_day_starts_the_count_again(self) -> None:
        """Otherwise today's occurrence lands on yesterday's row and is unseen."""
        subject = manager()
        await subject.warning(EntityType.BROKER, "Appa", "reconnect", "dropped", key="k")
        assert subject.forget_day(DAY) == 1
        assert subject.open_alerts(DAY) == []


class TestThrottling:
    async def test_a_storm_becomes_one_line(self) -> None:
        clock = ReplayClock(T0)
        raised: list[Alert] = []
        subject = manager(clock, raised)

        for _ in range(500):
            await subject.throttled(
                AlertLevel.CRITICAL, EntityType.FEED, "Kite", "decode", "bad packet", key="decode"
            )
        assert len(raised) == 1

    async def test_the_next_one_says_how_much_was_hidden(self) -> None:
        clock = ReplayClock(T0)
        subject = manager(clock)
        for _ in range(6):
            await subject.throttled(
                AlertLevel.CRITICAL, EntityType.FEED, "Kite", "decode", "bad packet", key="decode"
            )

        await clock.advance_to(T0 + timedelta(minutes=1))
        alert = await subject.throttled(
            AlertLevel.CRITICAL, EntityType.FEED, "Kite", "decode", "bad packet", key="decode"
        )
        assert alert is not None
        assert "5 similar suppressed" in alert.message

    async def test_a_suppressed_alert_says_so_by_returning_nothing(self) -> None:
        subject = manager()
        first = await subject.throttled(
            AlertLevel.WARNING, EntityType.FEED, "Kite", "decode", "bad", key="k"
        )
        second = await subject.throttled(
            AlertLevel.WARNING, EntityType.FEED, "Kite", "decode", "bad", key="k"
        )
        assert first is not None
        assert second is None


class TestDelivery:
    async def test_an_alert_reaches_the_console_live(self) -> None:
        bus = InProcessEventBus()
        subject = AlertManager(clock=ReplayClock(T0), bus=bus, trading_day_for=lambda now: DAY)
        subscription = bus.subscribe(Topic.ALERTS, name="console")
        await subject.critical(EntityType.ORDER, "NIFTY26AUG25000CE", "rejected", "margin")

        received = await anext(aiter(subscription))
        assert isinstance(received, Alert)
        assert received.entity == "NIFTY26AUG25000CE"

    async def test_a_store_that_fails_does_not_break_the_caller(self) -> None:
        """The code raising the alert was already reporting a problem."""

        async def broken(alert: Alert) -> None:
            raise RuntimeError("the database is gone")

        subject = AlertManager(
            clock=ReplayClock(T0),
            bus=InProcessEventBus(),
            trading_day_for=lambda now: DAY,
            sink=broken,
        )
        alert = await subject.critical(EntityType.SYSTEM, "engine", "halt", "everything is fine")
        assert alert is not None

    async def test_the_most_urgent_is_listed_first(self) -> None:
        subject = manager()
        await subject.info(EntityType.SYSTEM, "engine", "start", "started", key="a")
        await subject.critical(EntityType.ORDER, "NIFTY", "rejected", "margin", key="b")
        assert subject.open_alerts(DAY)[0].level is AlertLevel.CRITICAL


class TestWhatInterruptsTheOperator:
    """Every alert is recorded; only some raise a toast in the Console."""

    def bus_and_manager(self) -> tuple[InProcessEventBus, AlertManager]:
        bus = InProcessEventBus()
        return bus, AlertManager(clock=ReplayClock(T0), bus=bus, trading_day_for=lambda now: DAY)

    async def test_a_warning_interrupts(self) -> None:
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        await subject.warning(EntityType.BROKER, "Appa", "login", "session expired")
        assert isinstance(await anext(aiter(toasts)), Alert)

    async def test_a_critical_interrupts(self) -> None:
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        await subject.critical(EntityType.ORDER, "NIFTY", "rejected", "margin")
        assert isinstance(await anext(aiter(toasts)), Alert)

    async def test_an_ordinary_info_does_not(self) -> None:
        """A restart otherwise fires a toast per account for every socket."""
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        for _ in range(20):
            await subject.info(EntityType.BROKER, "Appa", "order-stream", "connected")
        assert toasts.depth == 0

    async def test_an_info_the_caller_asks_for_does(self) -> None:
        """ "Strategy engine started" is worth one line on the screen."""
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        await subject.info(
            EntityType.SYSTEM, "engine", "start", "strategy engine started", notify_ui=True
        )
        assert toasts.depth == 1

    async def test_everything_still_reaches_the_alerts_stream(self) -> None:
        """The toast is a separate decision from the record."""
        bus, subject = self.bus_and_manager()
        recorded = bus.subscribe(Topic.ALERTS, name="audit")
        await subject.info(EntityType.BROKER, "Appa", "order-stream", "connected")
        assert recorded.depth == 1

    async def test_a_storm_does_not_toast_every_time(self) -> None:
        """Between milestones the count advances quietly on the Alerts page."""
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        for _ in range(9):
            await subject.warning(EntityType.BROKER, "Appa", "reconnect", "dropped", key="k")
        assert toasts.depth == 1, "the first occurrence only"

    async def test_a_storm_speaks_up_again_at_a_milestone(self) -> None:
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        for _ in range(10):
            await subject.warning(EntityType.BROKER, "Appa", "reconnect", "dropped", key="k")
        assert toasts.depth == 2, "the first, and the tenth"

    async def test_a_problem_turning_critical_interrupts_again(self) -> None:
        """Escalation is exactly when the operator needs telling twice."""
        bus, subject = self.bus_and_manager()
        toasts = bus.subscribe(Topic.UI, name="console")
        await subject.warning(EntityType.BROKER, "Appa", "login", "retrying", key="k")
        await subject.warning(EntityType.BROKER, "Appa", "login", "retrying", key="k")
        await subject.critical(EntityType.BROKER, "Appa", "login", "gave up", key="k")
        assert toasts.depth == 2, "the first warning, and the escalation"

    async def test_the_toast_never_precedes_the_durable_row(self) -> None:
        """The Console must not show what is not yet stored."""
        order: list[str] = []

        async def sink(alert: Alert) -> None:
            order.append("stored")

        bus = InProcessEventBus()
        subject = AlertManager(
            clock=ReplayClock(T0), bus=bus, trading_day_for=lambda now: DAY, sink=sink
        )

        async def watch() -> None:
            subscription = bus.subscribe(Topic.UI, name="console")
            await anext(aiter(subscription))
            order.append("toasted")

        import asyncio

        watcher = asyncio.create_task(watch())
        await asyncio.sleep(0)
        await subject.critical(EntityType.ORDER, "NIFTY", "rejected", "margin")
        await watcher
        assert order == ["stored", "toasted"]


class TestNoiseThatIsRecordedElsewhere:
    async def test_routine_trade_lifecycle_info_is_not_stored_twice(self) -> None:
        """It is already in the trade store and the log."""
        raised: list[Alert] = []
        subject = manager(sink=raised)
        for operation in ("trade-entry", "trade-exit", "square-off", "square-off-all"):
            assert await subject.info(EntityType.TRADE, "Straddle", operation, "done") is None
        assert raised == []

    async def test_the_same_operation_going_wrong_is_always_kept(self) -> None:
        """A square-off that failed is a real signal."""
        raised: list[Alert] = []
        subject = manager(sink=raised)
        await subject.critical(EntityType.TRADE, "Straddle", "square-off", "the broker refused")
        assert len(raised) == 1

    async def test_a_caller_that_wants_the_operator_told_is_honoured(self) -> None:
        raised: list[Alert] = []
        subject = manager(sink=raised)
        await subject.info(EntityType.TRADE, "Straddle", "trade-entry", "entered", notify_ui=True)
        assert len(raised) == 1
