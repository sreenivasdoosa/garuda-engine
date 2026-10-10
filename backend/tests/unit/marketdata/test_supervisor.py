"""When the feed is replaced, and — mostly — when it is not.

A stalled feed and a closed market look identical from the socket: connected,
no frames, no error. Telling them apart is the whole job here, and getting it
wrong is expensive in both directions. Replace too eagerly and the engine
reconnects every cycle against an account that is fine, spending a login each
time; replace too late and prices are gone and nothing says so.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from garuda.core.backoff import ReconnectPolicy
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.marketdata.hub import TickHub
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.protocols.feed import FeedConnected, TicksReceived

NIFTY = InstrumentId("NSE:NIFTY")
NOW = datetime(2026, 9, 2, 5, 0, tzinfo=UTC)
POLICY = ReconnectPolicy(silence_before_reconnect=timedelta(seconds=60))


class OpenSocket:
    """A feed whose socket is up. Whether anything comes down it is separate."""

    def __init__(self) -> None:
        self.connected = True

    @property
    def name(self) -> str:
        return "open"

    @property
    def is_connected(self) -> bool:
        return self.connected

    async def connect(self) -> None:
        self.connected = True

    async def close(self) -> None:
        self.connected = False

    async def subscribe(self, instruments: object) -> None:
        return None

    async def unsubscribe(self, instruments: object) -> None:
        return None

    def events(self) -> object:  # pragma: no cover - not iterated here
        raise NotImplementedError


def a_tick(at: datetime) -> Tick:
    return Tick(NIFTY, Money.of("25000", Currency.INR), at)


async def supervisor_on(
    hub: TickHub, *, open_market: bool = True, feed: OpenSocket | None = None
) -> FeedSupervisor:
    socket = feed or OpenSocket()

    async def factory() -> OpenSocket:
        return socket

    built = FeedSupervisor(
        hub,
        factory,  # type: ignore[arg-type]
        ReplayClock(NOW),
        policy=POLICY,
        market_is_open=lambda _: open_market,
    )
    await built.start()
    return built


def hub_at(now: datetime) -> TickHub:
    return TickHub(InProcessEventBus(), ReplayClock(now))


async def watching(hub: TickHub) -> None:
    await hub.subscribe([NIFTY])


class TestNothingToJudge:
    @pytest.mark.asyncio
    async def test_no_feed_is_a_reason(self) -> None:
        hub = hub_at(NOW)
        supervisor = FeedSupervisor(
            hub,
            _never,  # type: ignore[arg-type]
            ReplayClock(NOW),
            policy=POLICY,
        )

        assert supervisor.needs_reconnect(NOW) == "no feed"

    @pytest.mark.asyncio
    async def test_a_closed_socket_is_a_reason(self) -> None:
        hub = hub_at(NOW)
        socket = OpenSocket()
        supervisor = await supervisor_on(hub, feed=socket)
        socket.connected = False

        assert supervisor.needs_reconnect(NOW) is not None

    @pytest.mark.asyncio
    async def test_silence_with_nothing_subscribed_is_not_a_fault(self) -> None:
        """Nothing was asked for, so nothing arriving is correct."""
        hub = hub_at(NOW)
        supervisor = await supervisor_on(hub)

        assert supervisor.needs_reconnect(NOW + timedelta(hours=2)) is None


class TestAConnectionThatHasNotHadTimeYet:
    @pytest.mark.asyncio
    async def test_a_feed_that_just_opened_is_left_alone(self) -> None:
        """Before this, "no tick has ever arrived" counted as a stall at once,
        so a feed started before the open was torn down on the first monitor
        pass and every pass after it."""
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub)
        await hub.consume([FeedConnected(NOW)])

        assert supervisor.needs_reconnect(NOW + timedelta(seconds=5)) is None

    @pytest.mark.asyncio
    async def test_silence_since_opening_eventually_counts(self) -> None:
        """A socket open for minutes with nothing on it, while a venue trades,
        is a stall -- which is the failure this check exists for."""
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub)
        await hub.consume([FeedConnected(NOW)])

        reason = supervisor.needs_reconnect(NOW + timedelta(minutes=5))

        assert reason is not None
        assert "no ticks" in reason

    @pytest.mark.asyncio
    async def test_with_neither_a_tick_nor_a_connection_time_nothing_is_guessed(self) -> None:
        """A hub that has seen nothing at all cannot say how long it has been
        quiet, and replacing a feed over that is guesswork."""
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub)

        assert supervisor.needs_reconnect(NOW + timedelta(hours=1)) is None


class TestAMarketThatIsClosed:
    @pytest.mark.asyncio
    async def test_silence_out_of_hours_is_not_a_fault(self) -> None:
        """The reference service never reconnects on silence for this reason.
        Treating a quiet weekend as a stall reconnects every cycle, forever,
        and each one spends a login."""
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub, open_market=False)
        await hub.consume([FeedConnected(NOW)])

        assert supervisor.needs_reconnect(NOW + timedelta(hours=6)) is None

    @pytest.mark.asyncio
    async def test_a_closed_socket_is_still_replaced_out_of_hours(self) -> None:
        """Staying connected through a closed session is the point; a dropped
        connection is a different thing and is restored."""
        hub = hub_at(NOW)
        await watching(hub)
        socket = OpenSocket()
        supervisor = await supervisor_on(hub, open_market=False, feed=socket)
        socket.connected = False

        assert supervisor.needs_reconnect(NOW) is not None


class TestAFeedThatIsWorking:
    @pytest.mark.asyncio
    async def test_a_recent_tick_is_healthy(self) -> None:
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub)
        await hub.consume([FeedConnected(NOW), TicksReceived((a_tick(NOW),))])

        assert supervisor.needs_reconnect(NOW + timedelta(seconds=30)) is None

    @pytest.mark.asyncio
    async def test_silence_after_ticks_were_flowing_is_a_stall(self) -> None:
        hub = hub_at(NOW)
        await watching(hub)
        supervisor = await supervisor_on(hub)
        await hub.consume([FeedConnected(NOW), TicksReceived((a_tick(NOW),))])

        reason = supervisor.needs_reconnect(NOW + timedelta(minutes=3))

        assert reason is not None
        assert "no ticks" in reason


async def _never() -> object:
    raise AssertionError("the factory must not be called here")
