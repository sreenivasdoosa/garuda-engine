"""Sweeping the strategies.

Two things this owns that nothing below it can: the tranche ledger across a
day, and containment — one strategy failing must not stop the sweep, because
trade management is still running positions that are already on.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.alerts.manager import AlertManager
from garuda.capital import FixedLotAllocator, Sizer
from garuda.composition.engine import Engine
from garuda.composition.strategies import Loaded, Strategy
from garuda.composition.strategy_context import MarketView
from garuda.composition.strategy_loop import StrategyLoop
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money
from garuda.domain.alert import Alert, AlertLevel
from garuda.domain.calendar import TradingCalendar
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementCycle,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.symbol import SymbolInfo
from garuda.engine.rules.compose import AllOf
from garuda.engine.rules.outcome import RuleOutcome, failed, passed
from garuda.engine.selectors import OptionStrikeSelector
from garuda.engine.signals import SignalBatch, SignalFactory
from garuda.engine.spec import FixedDirection, LegSpec, SideRule, StrategySpec
from garuda.engine.strategy import (
    Result,
    StrategyContext,
    StrategyRunner,
    StrategySubscription,
)
from garuda.engine.tranches import TrancheId, TrancheLedger, TrancheState
from garuda.marketdata.history import CandleCache, HistorySource
from garuda.marketdata.hub import TickHub
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.feed import TicksReceived

from .conftest import APPA, EngineBuilder, account, session

#: What `StrategyRunner.evaluate` looks like, for the tests that replace it.
type Evaluate = Callable[[StrategySubscription, int, StrategyContext], Awaitable[Result]]
#: What an AlertManager writes through.
type AlertSink = Callable[[Alert], Awaitable[None]]

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 8, 31, 13, 0, tzinfo=IST).astimezone(UTC)
TODAY = date(2026, 8, 31)
EXPIRY = date(2026, 9, 3)
NIFTY = InstrumentId("NSE:NIFTY")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def venue_for(nse_calendar: TradingCalendar) -> Exchange:
    return Exchange(
        code="NSE",
        name="NSE",
        currency=Currency.INR,
        calendar=nse_calendar,
        settlement=SettlementCycle.T1,
        segments=frozenset({Segment.EQUITY, Segment.FNO}),
    )


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


def a_straddle() -> StrategySpec:
    return StrategySpec(
        name="straddle",
        underlying=NIFTY,
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL),
                side=SideRule.ALWAYS_SHORT,
                sequence=0,
            ),
            LegSpec(
                selector=OptionStrikeSelector(OptionType.PUT),
                side=SideRule.ALWAYS_SHORT,
                sequence=1,
            ),
        ),
    )


@dataclass(frozen=True)
class Says:
    verdict: bool = True

    def evaluate(self, context: object) -> RuleOutcome:
        return passed("the condition holds") if self.verdict else failed("not yet")


@dataclass(frozen=True)
class Explodes:
    def evaluate(self, context: object) -> RuleOutcome:
        raise RuntimeError("this strategy is broken")


@dataclass
class Doorman:
    accept: bool = True
    batches: list[SignalBatch] = field(default_factory=list)

    async def __call__(self, batch: SignalBatch) -> bool:
        self.batches.append(batch)
        return self.accept


@pytest.fixture
def registry(nse: Exchange) -> InstrumentRegistry:
    return InstrumentRegistry.build(
        [
            option(strike, side, nse)
            for strike in (24900, 25000, 25100)
            for side in (OptionType.CALL, OptionType.PUT)
        ]
    )


@pytest.fixture
def engine(build_with: EngineBuilder, registry: InstrumentRegistry) -> Engine:
    built = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})
    built.parts.instruments.publish("zerodha", registry)
    return built


async def prices(hub: TickHub) -> None:
    ticks = (
        Tick(instrument=NIFTY, last_price=rupees("25010"), timestamp=NOW),
        Tick(instrument=InstrumentId("NFO:N25000CE"), last_price=rupees("150"), timestamp=NOW),
        Tick(instrument=InstrumentId("NFO:N25000PE"), last_price=rupees("120"), timestamp=NOW),
    )
    await hub.consume([TicksReceived(ticks)])
    await hub.dispatch_once()


def loop_over(
    engine: Engine,
    registry: InstrumentRegistry,
    doorman: Doorman,
    nse_calendar: TradingCalendar,
    *,
    entry: object = None,
    tranches: tuple[int, ...] = (0,),
) -> StrategyLoop:
    strategy = Strategy(
        spec=a_straddle(),
        entry_rules=entry or AllOf((Says(True),)),  # type: ignore[arg-type]
        exit_rules=None,
        layers=(),
        tranches=tranches,
    )
    subscription = StrategySubscription(
        trading_client=APPA,
        spec=strategy.spec,
        capital=rupees("500000"),
        entry_rules=strategy.entry_rules,
        tranches=tranches,
    )
    market = MarketView(
        hub=engine.parts.hub,
        registry=lambda: registry,
        symbols={"NIFTY": SymbolInfo(symbol="NIFTY", exchange_code="NSE", strike_gap=Decimal(50))},
        timezone=IST,
    )
    ledger = TrancheLedger(TODAY)
    factory = SignalFactory(
        Sizer(FixedLotAllocator(2)),
        lambda i: registry.get(i),
        engine.parts.hub.latest,
    )
    return StrategyLoop(
        engine=engine,
        loaded=Loaded(strategies={"straddle": strategy}, subscriptions=(subscription,), refused={}),
        market=market,
        venue=venue_for(nse_calendar),
        clock=ReplayClock(NOW),
        alerts=engine.parts.alerts,
        runner=StrategyRunner(factory=factory, deliver=doorman, ledger=ledger),
        ledger=ledger,
    )


# -- a sweep ----------------------------------------------------------------


async def test_a_sweep_enters_a_subscribed_strategy(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    doorman = Doorman()
    await prices(engine.parts.hub)

    results = await loop_over(engine, registry, doorman, nse_calendar).run_once()

    assert [result.fired for result in results] == [True]
    assert len(doorman.batches[0].signals) == 2


async def test_a_strategy_whose_rules_do_not_hold_enters_nothing(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    doorman = Doorman()
    await prices(engine.parts.hub)

    loop = loop_over(engine, registry, doorman, nse_calendar, entry=AllOf((Says(False),)))
    results = await loop.run_once()

    assert not results[0].fired
    assert doorman.batches == []


async def test_no_prices_means_no_entry(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """No spot, so no strike, so no leg — and the entry stands down whole."""
    doorman = Doorman()

    results = await loop_over(engine, registry, doorman, nse_calendar).run_once()

    assert not results[0].fired


# -- once a day -------------------------------------------------------------


async def test_a_second_sweep_does_not_enter_again(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """The rules still hold on the next sweep a second later."""
    doorman = Doorman()
    await prices(engine.parts.hub)
    loop = loop_over(engine, registry, doorman, nse_calendar)

    await loop.run_once()
    later = await loop.run_once()

    assert len(doorman.batches) == 1
    # Not merely refused by the runner: a tranche that is done is not
    # evaluated at all, so no context is built for it on every sweep of a
    # six-hour day.
    assert later == []


async def test_the_loop_and_the_runner_share_one_ledger(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """Two ledgers would let the loop think a tranche was open while the runner
    had already fired it, and it would enter on every sweep."""
    doorman = Doorman()
    await prices(engine.parts.hub)
    loop = loop_over(engine, registry, doorman, nse_calendar)

    await loop.run_once()

    assert loop.ledger is loop.runner.ledger
    assert loop.ledger.open == []


async def test_every_tranche_gets_its_own_entry(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    doorman = Doorman()
    await prices(engine.parts.hub)

    loop = loop_over(engine, registry, doorman, nse_calendar, tranches=(1, 2))
    await loop.run_once()

    assert len(doorman.batches) == 2
    assert {s.tranche for batch in doorman.batches for s in batch.signals} == {1, 2}


# -- containment ------------------------------------------------------------


async def test_a_strategy_that_raises_does_not_stop_the_sweep(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """Positions already on are still being managed; stopping helps nobody."""
    doorman = Doorman()
    await prices(engine.parts.hub)
    loop = loop_over(engine, registry, doorman, nse_calendar, tranches=(1, 2))
    loop.runner.evaluate = _raises_once(loop.runner.evaluate)  # type: ignore[method-assign, assignment]

    results = await loop.run_once()

    assert len(results) == 1  # the second tranche still evaluated


def _raises_once(original: Evaluate) -> Evaluate:
    calls = {"n": 0}

    async def wrapper(
        subscription: StrategySubscription, tranche: int, context: StrategyContext
    ) -> Result:
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return await original(subscription, tranche, context)

    return wrapper


async def test_a_broken_rule_blocks_the_tranche_rather_than_failing_the_sweep(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """The rule runner turns the exception into UNAVAILABLE, so the tranche is
    blocked and retried — which is right, because the rule may recover."""
    doorman = Doorman()
    await prices(engine.parts.hub)
    loop = loop_over(engine, registry, doorman, nse_calendar, entry=AllOf((Explodes(),)))

    await loop.run_once()

    assert loop.ledger.open != []
    assert doorman.batches == []


async def test_a_strategy_that_cannot_be_evaluated_is_alerted_once(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """Once, not once a second for six hours."""
    raised: list[Alert] = []
    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)
    loop.alerts = AlertManager(
        clock=ReplayClock(NOW),
        bus=InProcessEventBus(),
        trading_day_for=lambda moment: TODAY,
        sink=_collect(raised),
    )
    loop.runner.evaluate = _always_raises()  # type: ignore[method-assign, assignment]

    await loop.run_once()
    await loop.run_once()
    await loop.run_once()

    assert len(raised) == 1
    assert raised[0].level is AlertLevel.CRITICAL


def _collect(into: list[Alert]) -> AlertSink:
    async def sink(alert: Alert) -> None:
        into.append(alert)

    return sink


def _always_raises() -> Evaluate:
    async def wrapper(
        subscription: StrategySubscription, tranche: int, context: StrategyContext
    ) -> Result:
        raise RuntimeError("boom")

    return wrapper


async def test_a_subscription_whose_account_is_not_trading_is_skipped(
    build_with: EngineBuilder, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """The account has no session, so there is no book to signal into.

    Skipped quietly, and that is the point: an account nobody has logged into
    yet is the normal state at dawn, and raising a CRITICAL alert about it
    every second until someone does is not help.
    """
    raised: list[Alert] = []
    built = build_with([account(APPA, "AB1234")], {})
    built.parts.instruments.publish("zerodha", registry)
    doorman = Doorman()
    loop = loop_over(built, registry, doorman, nse_calendar)
    loop.alerts = AlertManager(
        clock=ReplayClock(NOW),
        bus=InProcessEventBus(),
        trading_day_for=lambda moment: TODAY,
        sink=_collect(raised),
    )

    results = await loop.run_once()

    assert results == []
    assert doorman.batches == []
    assert raised == []


async def test_a_tranche_whose_subscription_vanished_is_still_closed_out(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """A strategy deactivated mid-day leaves its tranches behind. They expire
    on the sweep rather than staying open in the record for ever."""
    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)
    orphan = TrancheId(trading_client=APPA, strategy="withdrawn", tranche=0, trading_day=TODAY)
    loop.ledger.open_for(orphan, cutoff=NOW - timedelta(minutes=1))

    await loop.run_once()

    closed = loop.ledger.get(orphan)
    assert closed is not None
    assert closed.state is TrancheState.EXPIRED


# -- the day ----------------------------------------------------------------


async def test_a_tranche_past_its_cutoff_is_closed_out(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)
    identity = loop.loaded.subscriptions[0].identity(0, NOW)
    loop.ledger.open_for(identity, cutoff=NOW - timedelta(minutes=1))

    await loop.run_once()

    tranche = loop.ledger.get(identity)
    assert tranche is not None
    assert tranche.state is TrancheState.EXPIRED


async def test_stopping_ends_the_sweep(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    import asyncio

    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)

    running = asyncio.create_task(loop.run_forever())
    await asyncio.sleep(0)
    loop.stop()
    await asyncio.wait_for(running, timeout=1)

    assert running.done()


# -- history ----------------------------------------------------------------


async def test_history_is_refreshed_before_the_rules_read_it(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    """A rule cannot wait on a broker, so the waiting happens here — and it
    happens first, or every sweep reads what the previous one asked for."""
    fetched: list[str] = []

    class Source:
        async def fetch(
            self,
            instrument: InstrumentId,
            interval: BarInterval,
            start: datetime,
            end: datetime,
        ) -> list[Bar]:
            fetched.append(instrument.value)
            return []

    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)
    cache = CandleCache(source=Source(), clock=ReplayClock(NOW))
    cache.wants(NIFTY, BarInterval.ONE_MINUTE)
    loop.market = replace(loop.market, candles=cache)

    await loop.run_once()

    # Both tiers: the settled days and today's.
    assert fetched == [NIFTY.value, NIFTY.value]


async def test_a_broken_history_source_does_not_stop_the_sweep(
    engine: Engine, registry: InstrumentRegistry, nse_calendar: TradingCalendar
) -> None:
    class Broken:
        async def fetch(
            self,
            instrument: InstrumentId,
            interval: BarInterval,
            start: datetime,
            end: datetime,
        ) -> list[Bar]:
            raise RuntimeError("history is down")

    doorman = Doorman()
    await prices(engine.parts.hub)
    loop = loop_over(engine, registry, doorman, nse_calendar)
    cache = CandleCache(source=Broken(), clock=ReplayClock(NOW))
    cache.wants(NIFTY, BarInterval.ONE_MINUTE)
    loop.market = replace(loop.market, candles=cache)

    results = await loop.run_once()

    assert [result.fired for result in results] == [True]


async def test_no_candle_cache_is_quiet(
    engine: Engine,
    registry: InstrumentRegistry,
    nse_calendar: TradingCalendar,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """An engine with no market-data account has no history, which is a state
    and not a fault. Logging an error about it once a second is noise that
    buries the real ones."""
    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)

    with caplog.at_level("ERROR"):
        await loop.run_once()

    assert "candle history" not in caplog.text


async def test_a_day_the_venue_does_not_trade_is_quiet(
    engine: Engine,
    registry: InstrumentRegistry,
    nse_calendar: TradingCalendar,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """There is no session to fetch today's candles from."""
    doorman = Doorman()
    loop = loop_over(engine, registry, doorman, nse_calendar)
    loop.market = replace(
        loop.market, candles=CandleCache(source=_unused(), clock=ReplayClock(NOW))
    )
    loop.ledger = TrancheLedger(date(2026, 9, 5))  # a Saturday

    with caplog.at_level("ERROR"):
        await loop.run_once()

    assert "candle history" not in caplog.text


def _unused() -> HistorySource:
    class Nothing:
        async def fetch(
            self,
            instrument: InstrumentId,
            interval: BarInterval,
            start: datetime,
            end: datetime,
        ) -> list[Bar]:
            raise AssertionError("there is no session to fetch for")

    return Nothing()
