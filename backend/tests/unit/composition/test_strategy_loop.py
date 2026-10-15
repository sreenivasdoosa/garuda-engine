"""Running the strategies: the schedule, the state, the delivery.

Behavioural: a tranche fires at its time and its signals land in the
account's book; the firing is written to strategy state at once; a restart
does not fire it again; a time already past when the day starts is missed;
one strategy failing does not stop another; a reactivated strategy catches
up what it missed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.composition.engine import Engine
from garuda.composition.strategies import Loaded, assemble
from garuda.composition.strategy_context import MarketView
from garuda.composition.strategy_loop import StrategyLoop
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money
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
from garuda.domain.market import Tick
from garuda.domain.symbol import SymbolInfo
from garuda.engine.base_strategy import BaseStrategy, Evaluation, Outcome
from garuda.engine.strategy_state import StrategyState
from garuda.marketdata.registry import InstrumentRegistry
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDefinitionsRow,
    SubscriptionsRow,
)
from garuda.protocols.feed import TicksReceived

from .conftest import APPA, EngineBuilder, account, session

IST = ZoneInfo("Asia/Kolkata")
TODAY = date(2026, 8, 31)
EXPIRY = date(2026, 9, 3)
NIFTY = InstrumentId("NSE:NIFTY")


def at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 8, 31, hour, minute, second, tzinfo=IST).astimezone(UTC)


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


def definition(name: str = "straddle", **overrides: object) -> StrategyDefinitionsRow:
    values: dict[str, object] = {
        "strategy_id": 1,
        "strategy_name": name,
        "underlying_symbol": "NIFTY",
        "exchange": "NSE",
        "product": "INTRADAY",
        "trade_mode": "OPTION_SELLING",
        "status": "ACTIVE",
        "start_time": "09:20",
        "stop_time": "15:15",
        "capital_per_lot": 100000,
        "scheduled_trigger_enabled": True,
        "exclude_monthly_expiry": False,
        "use_premium_balancing": True,
        "catch_up_missed_tranches": True,
        "adaptive_tranches_enabled": False,
        "use_indicator_entry": False,
    }
    values.update(overrides)
    return StrategyDefinitionsRow(**values)


def base_config(name: str = "straddle", timing: str = "13:00") -> StrategyConfigRow:
    return StrategyConfigRow(
        id=1,
        strategy_name=name,
        strike_type="MoneyNess",
        strike_value="ATM",
        tranch_timing=timing,
        max_tranches=1,
    )


def subscription(name: str = "straddle", capital: str = "200000") -> SubscriptionsRow:
    return SubscriptionsRow(
        subscription_id=1,
        trading_client_id=APPA.value,
        strategy_name=name,
        is_active=True,
        capital=Decimal(capital),
        is_paper_trading=False,
    )


@dataclass
class MemoryStates:
    saved: list[StrategyState] = field(default_factory=list)
    stored: list[StrategyState] = field(default_factory=list)

    async def load_day(self, trading_day: date) -> list[StrategyState]:
        return [s for s in self.stored if s.trading_day == trading_day]

    async def save(self, state: StrategyState, *, now: datetime) -> None:
        self.saved.append(state)


@dataclass
class RecordingAlerts:
    raised: list[tuple[str, str]] = field(default_factory=list)

    async def warning(self, *args: object, key: str | None = None) -> None:
        self.raised.append(("WARNING", str(args[3])))

    async def critical(self, *args: object, key: str | None = None) -> None:
        self.raised.append(("CRITICAL", str(args[3])))


@pytest.fixture
def venue(nse_calendar: TradingCalendar) -> Exchange:
    return Exchange(
        code="NSE",
        name="NSE",
        currency=Currency.INR,
        calendar=nse_calendar,
        settlement=SettlementCycle.T1,
        segments=frozenset({Segment.EQUITY, Segment.FNO}),
    )


@pytest.fixture
def registry(venue: Exchange) -> InstrumentRegistry:
    return InstrumentRegistry.build(
        [
            option(strike, side, venue)
            for strike in (23900, 24000, 24900, 25000, 25100, 26000)
            for side in (OptionType.CALL, OptionType.PUT)
        ]
    )


@pytest.fixture
def engine(build_with: EngineBuilder, registry: InstrumentRegistry) -> Engine:
    built = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})
    built.parts.instruments.publish("zerodha", registry)
    return built


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


async def prices(engine: Engine, now: datetime) -> None:
    ticks = [Tick(instrument=NIFTY, last_price=rupees("25010"), timestamp=now)]
    for strike in (25000, 26000, 24000):
        for letters in ("CE", "PE"):
            ticks.append(
                Tick(
                    instrument=InstrumentId(f"NFO:N{strike}{letters}"),
                    last_price=rupees("120"),
                    timestamp=now,
                )
            )
    await engine.parts.hub.consume([TicksReceived(tuple(ticks))])
    await engine.parts.hub.dispatch_once()


def loop_for(
    engine: Engine,
    registry: InstrumentRegistry,
    venue: Exchange,
    clock: ReplayClock,
    loaded: Loaded,
    *,
    states: MemoryStates | None = None,
    pipeline: BaseStrategy | None = None,
    alerts: RecordingAlerts | None = None,
) -> StrategyLoop:
    market = MarketView(
        hub=engine.parts.hub,
        registry=lambda: registry,
        symbols={"NIFTY": SymbolInfo(symbol="NIFTY", exchange_code="NSE", strike_gap=Decimal(50))},
        timezone=IST,
    )
    return StrategyLoop(
        engine=engine,
        loaded=loaded,
        market=market,
        venue=venue,
        clock=clock,
        alerts=alerts or RecordingAlerts(),  # type: ignore[arg-type]
        states=states,
        pipeline=pipeline or BaseStrategy(),
    )


def straddle() -> Loaded:
    return assemble([definition()], [base_config()], [], [subscription()])


class TestATrancheFires:
    async def test_at_its_time_its_signals_land_in_the_book(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        clock = ReplayClock(at(12, 59, 58))
        loop = loop_for(engine, registry, venue, clock, straddle())
        await prices(engine, clock.now())

        assert await loop.run_once() == []
        clock._now = at(13, 0)
        (result,) = await loop.run_once()

        assert result.outcome.entered, result.outcome.stood_down
        assert result.delivered
        book = engine.parts.clients[APPA].book
        assert {s.instrument.value for s in book.signals("straddle")} == {
            "NFO:N25000CE",
            "NFO:N25000PE",
        }
        assert {s.quantity for s in book.signals("straddle")} == {150}  # 2 lots of 75

    async def test_the_firing_is_written_at_once(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        clock = ReplayClock(at(12, 59))
        states = MemoryStates()
        loop = loop_for(engine, registry, venue, clock, straddle(), states=states)
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        await loop.run_once()

        assert states.saved
        assert states.saved[-1].has_signalled(1)
        state = loop.state_of(APPA, "straddle")
        assert state is not None
        assert state.has_signalled(1)

    async def test_a_restart_does_not_fire_it_again(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        fired = StrategyState(APPA, "straddle", TODAY).tranche_signalled(
            1, at(13, 0), signals=2, lots=2
        )
        clock = ReplayClock(at(13, 0))
        loop = loop_for(
            engine, registry, venue, clock, straddle(), states=MemoryStates(stored=[fired])
        )
        await prices(engine, clock.now())
        (result,) = await loop.run_once()
        assert not result.outcome.entered
        assert "already signalled" in (result.outcome.stood_down or "")
        assert engine.parts.clients[APPA].book.signals("straddle") == []

    async def test_a_time_already_past_at_startup_is_missed(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        clock = ReplayClock(at(13, 5))
        loop = loop_for(engine, registry, venue, clock, straddle())
        await prices(engine, clock.now())
        assert await loop.run_once() == []
        assert loop.schedule is not None
        assert len(loop.schedule.missed) == 1


class TestContainment:
    async def test_one_failing_strategy_does_not_stop_another(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        class Explodes(BaseStrategy):
            def on_scheduled(self, ev: Evaluation) -> Outcome:
                if ev.runtime.definition.name == "broken":
                    raise RuntimeError("this strategy is broken")
                return super().on_scheduled(ev)

        loaded = assemble(
            [definition(), definition("broken", strategy_id=2)],
            [base_config(), base_config("broken")],
            [],
            [subscription(), subscription("broken")],
        )
        clock = ReplayClock(at(12, 59))
        alerts = RecordingAlerts()
        loop = loop_for(engine, registry, venue, clock, loaded, pipeline=Explodes(), alerts=alerts)
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        results = await loop.run_once()

        assert [r.strategy for r in results] == ["straddle"]
        assert results[0].outcome.entered
        assert [level for level, _ in alerts.raised] == ["CRITICAL"]


class TestReload:
    async def test_a_reactivated_strategy_catches_up_what_it_missed(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        clock = ReplayClock(at(13, 30))
        paused = assemble([definition(status="WIND_DOWN")], [base_config()], [], [subscription()])
        loop = loop_for(engine, registry, venue, clock, paused)
        await prices(engine, clock.now())
        await loop.run_once()
        assert loop.schedule is not None
        assert len(loop.schedule.missed) == 1

        loop.replace(straddle())
        assert loop.tranches_pending == 1
        (result,) = await loop.run_once()
        assert result.outcome.entered, result.outcome.stood_down

    async def test_a_reload_keeps_what_already_fired(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        clock = ReplayClock(at(12, 59))
        loop = loop_for(engine, registry, venue, clock, straddle())
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        await loop.run_once()
        loop.replace(straddle())
        clock._now = at(13, 0, 5)
        assert await loop.run_once() == []


class TestReporting:
    async def test_zero_lots_raises_a_warning(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        loaded = assemble([definition()], [base_config()], [], [subscription(capital="50000")])
        clock = ReplayClock(at(12, 59))
        alerts = RecordingAlerts()
        loop = loop_for(engine, registry, venue, clock, loaded, alerts=alerts)
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        (result,) = await loop.run_once()
        assert (result.outcome.stood_down or "").startswith("zero lots")
        assert [
            level for level, message in alerts.raised if "tranche 1 did not enter" in message
        ] == ["WARNING"]


def test_the_day_and_counts_are_reported(
    engine: Engine, registry: InstrumentRegistry, venue: Exchange
) -> None:
    loop = loop_for(engine, registry, venue, ReplayClock(at(9, 0)), straddle())
    assert loop.trading_day == TODAY
    assert loop.tranches_today == 0


class TestBreakoutWatches:
    async def test_a_watch_armed_at_its_time_enters_when_the_premium_falls(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        config = base_config()
        config.breakout_enabled = True
        loaded = assemble([definition()], [config], [], [subscription()])
        clock = ReplayClock(at(12, 59))
        loop = loop_for(engine, registry, venue, clock, loaded)
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        (armed,) = await loop.run_once()
        assert armed.outcome.armed
        assert len([w for w in loop.watches() if w.is_live]) == 2
        book = engine.parts.clients[APPA].book
        assert book.signals("straddle") == []

        # The call's premium falls 25% through the 20% trigger.
        tick = Tick(
            instrument=InstrumentId("NFO:N25000CE"), last_price=rupees("90"), timestamp=at(13, 5)
        )
        await engine.parts.hub.consume([TicksReceived((tick,))])
        await engine.parts.hub.dispatch_once()
        clock._now = at(13, 5)
        (entered,) = await loop.run_once()

        assert entered.outcome.entered, entered.outcome.stood_down
        assert [s.instrument.value for s in book.signals("straddle")] == ["NFO:N25000CE"]
        assert len([w for w in loop.watches() if w.is_live]) == 1


class TestCustomStrategies:
    async def test_a_definition_naming_a_class_runs_that_class(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        from garuda.engine import strategy as register
        from garuda.engine.custom_strategies import unregister
        from garuda.engine.direction_providers import Side

        @register("PUTS_ONLY_TEST")
        class PutsOnly(BaseStrategy):
            def direction(self, ev: Evaluation) -> Side:
                return Side.LONG

        try:
            loaded = assemble(
                [definition(strategy_class="PUTS_ONLY_TEST")], [base_config()], [], [subscription()]
            )
            assert "straddle" in loaded.strategies, loaded.refused
            clock = ReplayClock(at(12, 59))
            loop = loop_for(engine, registry, venue, clock, loaded)
            await prices(engine, clock.now())
            await loop.run_once()
            clock._now = at(13, 0)
            (result,) = await loop.run_once()
            assert [s.instrument.value for s in result.outcome.signals] == ["NFO:N25000PE"]
        finally:
            unregister("PUTS_ONLY_TEST")

    def test_an_unregistered_class_is_refused_at_load(self) -> None:
        loaded = assemble(
            [definition(strategy_class="NOBODY")], [base_config()], [], [subscription()]
        )
        assert "not registered" in loaded.refused["straddle"]


class TestPeriodic:
    async def test_with_nothing_on_it_tries_the_next_tranche_on_the_boundary(
        self, engine: Engine, registry: InstrumentRegistry, venue: Exchange
    ) -> None:
        loaded = assemble(
            [
                definition(
                    periodic_trigger_enabled=True,
                    periodic_interval_minutes=15,
                    scheduled_trigger_enabled=False,
                )
            ],
            [base_config(timing="")],
            [],
            [subscription()],
        )
        clock = ReplayClock(at(13, 14, 59))
        loop = loop_for(engine, registry, venue, clock, loaded)
        await prices(engine, clock.now())
        assert await loop.run_once() == []
        clock._now = at(13, 15)
        (result,) = await loop.run_once()
        assert result.outcome.entered, result.outcome.stood_down
        clock._now = at(13, 15, 30)
        assert await loop.run_once() == []  # once per boundary


class TestAfterExits:
    async def test_a_closed_tranche_cascades_and_a_stopped_short_arms_a_re_entry(
        self,
        engine: Engine,
        registry: InstrumentRegistry,
        venue: Exchange,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from garuda.domain.enums import Direction, ProductType
        from garuda.domain.trade import Trade, TradeId
        from garuda.domain.trade_state import TradeExitReason, TradeState

        config = base_config()
        config.max_tranches = 3
        config.re_entry = True
        config.max_reentries = 1
        loaded = assemble(
            [definition(adaptive_tranches_enabled=True)],
            [config],
            [],
            [subscription(capital="600000")],
        )
        clock = ReplayClock(at(12, 59))
        loop = loop_for(engine, registry, venue, clock, loaded)
        await prices(engine, clock.now())
        await loop.run_once()
        clock._now = at(13, 0)
        (first,) = await loop.run_once()
        assert first.outcome.entered

        stopped = Trade(
            id=TradeId("t-1"),
            trading_client=APPA,
            instrument=InstrumentId("NFO:N25000CE"),
            strategy="straddle",
            direction=Direction.SHORT,
            product=ProductType.MIS,
            quantity=75,
            filled_quantity=75,
            state=TradeState.COMPLETED,
            entry=rupees("120"),
            exit=rupees("156"),
            exit_reason=TradeExitReason.STOP_LOSS,
            tranche=1,
            started_at=at(13, 0),
            ended_at=at(13, 20),
        )
        book = engine.parts.clients[APPA].book
        monkeypatch.setattr(book, "trades_for", lambda strategy, group=None: [stopped])
        clock._now = at(13, 20)
        results = await loop.run_once()

        assert [r.tranche for r in results] == [2]  # the cascade
        assert results[0].outcome.entered
        re_entries = [w for w in loop.watches() if "RE1" in w.key]
        assert len(re_entries) == 1
        assert re_entries[0].below == Decimal(120)


class TestHedgeWindows:
    async def test_in_the_morning_window_a_hedge_moves_out_and_the_old_one_comes_off(
        self,
        engine: Engine,
        registry: InstrumentRegistry,
        venue: Exchange,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from garuda.domain.enums import Direction, ProductType
        from garuda.domain.intent import LegRole
        from garuda.domain.trade import Relationships, Trade, TradeId
        from garuda.domain.trade_state import TradeExitReason, TradeState

        loaded = assemble(
            [
                definition(
                    product="POSITIONAL",
                    hedge_replace_enabled=True,
                    hedge_distance_percentage_intraday=Decimal(4),
                )
            ],
            [base_config()],
            [],
            [subscription()],
        )

        def leg(
            number: int, instrument: str, direction: Direction, role: LegRole, **extra: object
        ) -> Trade:
            return Trade(
                id=TradeId(f"t-{number}"),
                trading_client=APPA,
                instrument=InstrumentId(instrument),
                strategy="straddle",
                direction=direction,
                product=ProductType.NRML,
                quantity=75,
                filled_quantity=75,
                state=TradeState.ACTIVE,
                entry=rupees("100"),
                relationships=Relationships(hedge_correlation_id="h-1", leg_role=role, **extra),  # type: ignore[arg-type]
                tranche=1,
                started_at=at(9, 0),
            )

        short = leg(1, "NFO:N25000CE", Direction.SHORT, LegRole.MAIN)
        old_hedge = leg(2, "NFO:N25100CE", Direction.LONG, LegRole.HEDGE)
        book = engine.parts.clients[APPA].book
        monkeypatch.setattr(book, "trades_for", lambda strategy, group=None: [short, old_hedge])

        clock = ReplayClock(at(9, 20))
        loop = loop_for(engine, registry, venue, clock, loaded)
        await prices(engine, clock.now())
        await loop.run_once()

        (replacement,) = book.signals("straddle")
        assert replacement.instrument == InstrumentId("NFO:N26000CE")  # 4% of 25000 out
        assert replacement.relationships.hedge_trade_id_to_square_off == old_hedge.id

        # The replacement fills; the old hedge is asked to come off.
        new_hedge = leg(
            3,
            "NFO:N26000CE",
            Direction.LONG,
            LegRole.HEDGE,
            hedge_trade_id_to_square_off=old_hedge.id,
        )
        requested: list[tuple[str, TradeExitReason]] = []

        async def request(
            trade: Trade, reason: TradeExitReason, *, by_operator: bool = False
        ) -> bool:
            requested.append((trade.id.value, reason))
            return True

        monkeypatch.setattr(book, "live_trades", lambda: [short, old_hedge, new_hedge])
        monkeypatch.setattr(engine.parts.clients[APPA].square_off, "request", request)
        clock._now = at(9, 21)
        await loop.run_once()
        assert requested == [("t-2", TradeExitReason.HEDGE_REPLACE)]
