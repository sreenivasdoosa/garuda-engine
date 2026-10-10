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


# -- indices, watched whether or not anything trades them --------------------


def index_symbols() -> dict[str, SymbolInfo]:
    return {
        "NIFTY": SymbolInfo(
            symbol="NIFTY", exchange_code="NSE", is_index=True, index_symbol="NIFTY 50"
        ),
        # Its level is published under its own name, which the operator
        # records the same way as any other.
        "SENSEX": SymbolInfo(
            symbol="SENSEX", exchange_code="BSE", is_index=True, index_symbol="SENSEX"
        ),
        # Not an index: a stock is only watched when something trades it.
        "RELIANCE": SymbolInfo(symbol="RELIANCE", exchange_code="NSE"),
    }


async def test_every_index_on_an_enabled_exchange_is_watched_from_the_open(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """Nothing trades them here. The Console still needs a price per card, and
    a card with no price is the page looking broken."""
    watching = Watchlist(hub=hub, symbols=index_symbols(), exchanges=frozenset({"NSE", "BSE"}))

    await watching.ensure([], registry, TODAY)

    assert watching.watched == frozenset({InstrumentId("NSE:NIFTY_50"), InstrumentId("BSE:SENSEX")})


async def test_an_index_is_watched_by_its_spot_symbol(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """NIFTY's level arrives as "NIFTY 50". Subscribing to the derivative name
    would subscribe to nothing at all, silently."""
    watching = Watchlist(hub=hub, symbols=index_symbols(), exchanges=frozenset({"NSE"}))

    await watching.ensure([], registry, TODAY)

    assert InstrumentId("NSE:NIFTY_50") in watching.watched
    assert InstrumentId("NSE:NIFTY") not in watching.watched


async def test_an_index_on_a_disabled_exchange_is_not_watched(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """The feed would refuse it, and on a venue that is off it never ticks."""
    watching = Watchlist(hub=hub, symbols=index_symbols(), exchanges=frozenset({"NSE"}))

    await watching.ensure([], registry, TODAY)

    assert InstrumentId("BSE:SENSEX") not in watching.watched


async def test_a_tradable_symbol_is_not_watched_just_for_being_curated(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """Only indices get this. Subscribing to every curated stock would spend
    the connection's budget on prices nothing reads."""
    watching = Watchlist(hub=hub, symbols=index_symbols(), exchanges=frozenset({"NSE", "BSE"}))

    await watching.ensure([], registry, TODAY)

    assert InstrumentId("NSE:RELIANCE") not in watching.watched


async def test_with_no_exchange_enabled_nothing_is_watched(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    watching = Watchlist(hub=hub, symbols=index_symbols())

    await watching.ensure([], registry, TODAY)

    assert watching.watched == frozenset()


async def test_indices_are_added_alongside_what_a_strategy_needs(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """They add prices; they never replace the strategy's own."""
    symbols = index_symbols()
    symbols["NIFTY"] = SymbolInfo(
        symbol="NIFTY", exchange_code="NSE", is_index=True, index_symbol="NIFTY 50"
    )
    watching = Watchlist(hub=hub, symbols=symbols, exchanges=frozenset({"NSE"}))

    await watching.ensure([subscribed()], registry, TODAY)

    assert InstrumentId("NSE:NIFTY_50") in watching.watched
    assert NIFTY in watching.watched


def a_future(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NFO:NIFTY26SEPFUT"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.FUTURE,
        trading_symbol="NIFTY26SEPFUT",
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=EXPIRY,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


async def test_a_commodity_is_watched_by_its_current_month_future(
    hub: TickHub, nse: Exchange
) -> None:
    """MCX publishes no CRUDEOIL level, only its futures. Subscribing to the
    bare name subscribes to a symbol the master has never heard of, and it
    never ticks. Ported from the reference's futures reference symbol."""
    # A master with the future but no spot instrument, which is what a
    # commodity underlying looks like.
    with_future = InstrumentRegistry.build([a_future(nse)])
    watching = Watchlist(
        hub=hub,
        symbols={"NIFTY": SymbolInfo(symbol="NIFTY", exchange_code="NSE", is_index=True)},
        exchanges=frozenset({"NSE"}),
    )

    assert watching.indices(with_future, TODAY) == {InstrumentId("NFO:NIFTY26SEPFUT")}


async def test_an_underlying_with_neither_spot_nor_future_is_skipped(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """Not guessed at. A subscription to something the master does not list
    is a silent no-op, which is worse than an absent card."""
    watching = Watchlist(
        hub=hub,
        symbols={"NOTHING": SymbolInfo(symbol="NOTHING", exchange_code="NSE", is_index=True)},
        exchanges=frozenset({"NSE"}),
    )

    assert watching.indices(registry, TODAY) == set()


def test_what_is_curated_is_known_before_the_master_loads(
    hub: TickHub,
) -> None:
    """The engine decides whether to sweep at all before anything resolves."""
    watching = Watchlist(hub=hub, symbols=index_symbols(), exchanges=frozenset({"NSE", "BSE"}))

    assert {info.symbol for info in watching.configured_indices()} == {"NIFTY", "SENSEX"}


async def test_a_derived_series_subscribes_the_chain_of_its_underlying(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """A straddle is the at-the-money call plus put, so switching one on has
    to subscribe the strikes -- no strategy required.

    The id the chain is looked up by is the **symbol** (`NSE:NIFTY`), which is
    what options record as their underlying. The price is read from the
    **index symbol** (`NSE:NIFTY_50`). Both come from the symbols table, and
    passing the second where the first belongs matches no options at all and
    subscribes nothing -- silently, because a straddle with no quotes looks
    exactly like a quiet one.
    """
    watching = Watchlist(
        hub=hub,
        symbols={
            "NIFTY": SymbolInfo(
                symbol="NIFTY",
                exchange_code="NSE",
                is_index=True,
                index_symbol="NIFTY 50",
                strike_gap=Decimal(50),
                option_chain_levels=3,
                derives_straddle=True,
            )
        },
        exchanges=frozenset({"NSE"}),
    )
    # The level arrives on the index symbol, which is what gives the chain a
    # strike to centre on.
    await quote(hub, InstrumentId("NSE:NIFTY_50"), "25010")

    await watching.ensure([], registry, TODAY)

    options = {i for i in watching.watched if i.value.endswith(("CE", "PE"))}
    assert options, "the chain was not subscribed"
    assert InstrumentId("NSE:NIFTY_50") in watching.watched


async def test_an_underlying_deriving_nothing_gets_no_chain(
    hub: TickHub, registry: InstrumentRegistry
) -> None:
    """The chain is the expensive part. An index nobody is charting is one
    subscription, not forty."""
    watching = Watchlist(
        hub=hub,
        symbols={
            "NIFTY": SymbolInfo(
                symbol="NIFTY",
                exchange_code="NSE",
                is_index=True,
                index_symbol="NIFTY 50",
                strike_gap=Decimal(50),
            )
        },
        exchanges=frozenset({"NSE"}),
    )
    await quote(hub, InstrumentId("NSE:NIFTY_50"), "25010")

    await watching.ensure([], registry, TODAY)

    assert watching.watched == frozenset({InstrumentId("NSE:NIFTY_50")})
