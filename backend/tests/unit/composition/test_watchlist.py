"""What the feed is asked to quote.

A strategy needs its underlying from the open, the chain near the money once
there is a money to be near, and its own positions always. Those arrive at
different times, which is why the list is recomputed rather than fixed.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from garuda.composition.watchlist import Watchlist
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.symbol import SymbolInfo
from garuda.engine.rules.compose import AllOf
from garuda.engine.selectors import OptionStrikeSelector
from garuda.engine.spec import FixedDirection, LegSpec, SideRule, StrategySpec
from garuda.engine.strategy import StrategySubscription
from garuda.marketdata.hub import TickHub
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.feed import TicksReceived

NOW = datetime(2026, 8, 31, 10, 0, tzinfo=UTC)
TODAY = date(2026, 8, 31)
EXPIRY = date(2026, 9, 3)
NIFTY = InstrumentId("NSE:NIFTY")
CLIENT = TradingClientId("appa")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def option(strike: int, side: OptionType, nse: Exchange) -> Instrument:
    letters = "CE" if side is OptionType.CALL else "PE"
    return Instrument(
        id=InstrumentId(f"NFO:N{strike}{letters}"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol=f"N{strike}{letters}",
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=EXPIRY,
        strike=Decimal(strike),
        option_type=side,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


@pytest.fixture
def registry(nse: Exchange) -> InstrumentRegistry:
    return InstrumentRegistry.build(
        [
            option(strike, side, nse)
            for strike in range(24000, 26001, 50)
            for side in (OptionType.CALL, OptionType.PUT)
        ]
    )


@pytest.fixture
def hub() -> TickHub:
    return TickHub(InProcessEventBus(), ReplayClock(NOW))


@pytest.fixture
def watchlist(hub: TickHub) -> Watchlist:
    return Watchlist(
        hub=hub,
        symbols={
            "NIFTY": SymbolInfo(
                symbol="NIFTY",
                exchange_code="NSE",
                strike_gap=Decimal(50),
                option_chain_levels=3,
            )
        },
    )


def subscribed() -> StrategySubscription:
    return StrategySubscription(
        trading_client=CLIENT,
        spec=StrategySpec(
            name="straddle",
            underlying=NIFTY,
            direction=FixedDirection(Direction.SHORT),
            legs=(
                LegSpec(
                    selector=OptionStrikeSelector(OptionType.CALL),
                    side=SideRule.ALWAYS_SHORT,
                    product=ProductType.NRML,
                ),
            ),
        ),
        capital=rupees("500000"),
        entry_rules=AllOf(()),
    )


async def quote(hub: TickHub, instrument: InstrumentId, price: str) -> None:
    tick = Tick(instrument=instrument, last_price=rupees(price), timestamp=NOW)
    await hub.consume([TicksReceived((tick,))])
    await hub.dispatch_once()


# -- the underlying ---------------------------------------------------------


async def test_a_strategy_s_underlying_is_watched_from_the_start(
    watchlist: Watchlist, registry: InstrumentRegistry
) -> None:
    """Every strike is chosen around it, so it comes first."""
    await watchlist.ensure([subscribed()], registry, TODAY)

    assert NIFTY in watchlist.watched


async def test_nothing_subscribed_watches_nothing(
    watchlist: Watchlist, registry: InstrumentRegistry
) -> None:
    assert await watchlist.ensure([], registry, TODAY) == 0


# -- the chain --------------------------------------------------------------


async def test_the_chain_is_not_known_before_the_underlying_ticks(
    watchlist: Watchlist, registry: InstrumentRegistry
) -> None:
    """Which is why the list is recomputed: pinning it at the open would leave
    a strategy choosing strikes it has no prices for."""
    await watchlist.ensure([subscribed()], registry, TODAY)

    assert watchlist.watched == frozenset({NIFTY})


async def test_the_chain_appears_once_there_is_a_spot(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    await watchlist.ensure([subscribed()], registry, TODAY)
    await quote(hub, NIFTY, "25010")

    await watchlist.ensure([subscribed()], registry, TODAY)

    # Three levels either side of the money, both sides: seven strikes, two
    # options each, plus the underlying.
    assert len(watchlist.watched) == 1 + 7 * 2


async def test_the_chain_is_centred_on_the_money(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    await quote(hub, NIFTY, "25010")

    await watchlist.ensure([subscribed()], registry, TODAY)

    assert InstrumentId("NFO:N25000CE") in watchlist.watched
    assert InstrumentId("NFO:N25150CE") in watchlist.watched
    assert InstrumentId("NFO:N24850PE") in watchlist.watched
    assert InstrumentId("NFO:N25200CE") not in watchlist.watched


async def test_both_sides_of_every_strike_are_watched(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    """A premium search on the put side needs put prices."""
    await quote(hub, NIFTY, "25010")

    await watchlist.ensure([subscribed()], registry, TODAY)

    assert InstrumentId("NFO:N25000CE") in watchlist.watched
    assert InstrumentId("NFO:N25000PE") in watchlist.watched


async def test_a_symbol_with_no_curated_gap_gets_no_chain(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """Without spacing there is nothing to centre on."""
    bare = Watchlist(hub=hub, symbols={})
    await quote(hub, NIFTY, "25010")

    await bare.ensure([subscribed()], registry, TODAY)

    assert bare.watched == frozenset({NIFTY})


# -- what is already held ---------------------------------------------------


async def test_a_held_position_is_always_watched(
    watchlist: Watchlist, registry: InstrumentRegistry
) -> None:
    """A position with no price is one the engine cannot stop out."""
    far = InstrumentId("NFO:N24000CE")

    await watchlist.ensure([subscribed()], registry, TODAY, held={far})

    assert far in watchlist.watched


async def test_a_held_position_outside_the_chain_is_not_dropped_when_spot_moves(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    far = InstrumentId("NFO:N24000CE")
    await watchlist.ensure([subscribed()], registry, TODAY, held={far})
    await quote(hub, NIFTY, "25010")

    await watchlist.ensure([subscribed()], registry, TODAY, held={far})

    assert far in watchlist.watched


# -- only ever adding -------------------------------------------------------


async def test_nothing_is_ever_unwatched(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    """Unsubscribing a strike because spot moved would drop the price of a
    position still open at it."""
    await quote(hub, NIFTY, "25010")
    await watchlist.ensure([subscribed()], registry, TODAY)
    early = watchlist.watched

    await quote(hub, NIFTY, "25500")
    await watchlist.ensure([subscribed()], registry, TODAY)

    assert early <= watchlist.watched


async def test_a_second_pass_over_the_same_chain_adds_nothing(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    """It runs every second all day; re-subscribing every second would be a
    conversation with the broker that says nothing."""
    await quote(hub, NIFTY, "25010")
    await watchlist.ensure([subscribed()], registry, TODAY)

    assert await watchlist.ensure([subscribed()], registry, TODAY) == 0


async def test_what_is_watched_is_actually_subscribed(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    await quote(hub, NIFTY, "25010")

    await watchlist.ensure([subscribed()], registry, TODAY)

    assert watchlist.watched <= hub.subscriptions


async def test_an_underlying_with_no_listed_expiry_gets_no_chain(
    watchlist: Watchlist, hub: TickHub, nse: Exchange
) -> None:
    """The staleness guard answers None when the master lost this week, and a
    chain centred on the wrong series is worse than no chain."""
    await quote(hub, NIFTY, "25010")
    empty = InstrumentRegistry.build([])

    await watchlist.ensure([subscribed()], empty, TODAY)

    assert watchlist.watched == frozenset({NIFTY})


async def test_nothing_new_is_nothing_said_to_the_broker(
    watchlist: Watchlist, registry: InstrumentRegistry, hub: TickHub
) -> None:
    """It runs every second all day. An empty subscribe is a wire message
    that says nothing, three and a half thousand times a session."""
    calls: list[int] = []
    original = hub.subscribe

    async def counting(instruments: object) -> None:
        calls.append(1)
        await original(instruments)  # type: ignore[arg-type]

    await quote(hub, NIFTY, "25010")
    await watchlist.ensure([subscribed()], registry, TODAY)
    hub.subscribe = counting  # type: ignore[method-assign]

    await watchlist.ensure([subscribed()], registry, TODAY)

    assert calls == []
