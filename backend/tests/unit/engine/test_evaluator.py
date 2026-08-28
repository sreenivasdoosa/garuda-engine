"""The spec-driven evaluator and the pipeline it feeds."""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from garuda.brokers.paper import PaperBroker
from garuda.capital import FixedLotAllocator, Sizer
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, DomainError, Money, OrderStatus
from garuda.domain.client import TradingClientId
from garuda.domain.enums import TradingMode
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import IntentKind, LegRole
from garuda.domain.journal import JournalEvent
from garuda.domain.market import Tick
from garuda.domain.order import ClientOrderId, Fill, Side
from garuda.domain.position import Position
from garuda.engine import (
    MAX_LEGS_CEILING,
    EvaluationContext,
    FixedDirection,
    FixedInstrumentSelector,
    LegBasedEvaluator,
    LegSpec,
    SideRule,
    StrategySpec,
    Subscription,
    TradingPipeline,
)
from garuda.ordermgmt import ClientOrderIdSequence, OrderManager
from garuda.rms import BreachType, RiskGate, RiskLimits, default_checks

T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
DAY = date(2026, 8, 27)
CLIENT = TradingClientId("appa-zerodha-paper")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_quote(instrument: Instrument, last: str = "120.00") -> Tick:
    return Tick(
        instrument=instrument.id,
        last_price=rupees(last),
        timestamp=T0,
        bid=rupees(str(Decimal(last) - Decimal("0.10"))),
        ask=rupees(str(Decimal(last) + Decimal("0.10"))),
    )


def a_spec(nifty_call: Instrument, *legs: LegSpec, **overrides: object) -> StrategySpec:
    base: dict[str, object] = {
        "name": "test-strategy",
        "underlying": InstrumentId("NSE:NIFTY"),
        "direction": FixedDirection(Direction.SHORT),
        "legs": legs or (LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.SAME_AS_SIGNAL),),
    }
    return StrategySpec(**{**base, **overrides})  # type: ignore[arg-type]


def a_context(nifty_call: Instrument, **overrides: object) -> EvaluationContext:
    base: dict[str, object] = {
        "subscription": Subscription(
            strategy="test-strategy",
            trading_client=CLIENT,
            mode=TradingMode.PAPER,
            capital=rupees("500000"),
        ),
        "now": T0,
        "correlation_id": "corr-1",
        "quotes": {nifty_call.id: a_quote(nifty_call)},
    }
    return EvaluationContext(**{**base, **overrides})  # type: ignore[arg-type]


class TestSpecValidation:
    def test_a_strategy_with_no_legs_is_refused(self, nifty_call):
        with pytest.raises(DomainError, match="no legs does nothing"):
            StrategySpec(
                name="empty",
                underlying=InstrumentId("NSE:NIFTY"),
                direction=FixedDirection(Direction.LONG),
                legs=(),
            )

    def test_a_hedge_without_a_main_leg_is_refused(self, nifty_call):
        """A hedge leg with no main leg protects nothing."""
        with pytest.raises(DomainError, match="protects nothing"):
            a_spec(
                nifty_call,
                LegSpec(
                    FixedInstrumentSelector(nifty_call.id),
                    SideRule.OPPOSITE,
                    role=LegRole.HEDGE,
                ),
            )

    def test_too_many_legs_is_refused(self, nifty_call):
        legs = tuple(
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.SAME_AS_SIGNAL)
            for _ in range(9)
        )
        with pytest.raises(DomainError, match="exceeds the limit of 8"):
            a_spec(nifty_call, *legs)

    def test_the_cap_can_be_raised_to_the_ceiling(self, nifty_call):
        """A hedged iron condor is exactly eight, so the cap is a setting."""
        legs = tuple(
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.SAME_AS_SIGNAL)
            for _ in range(10)
        )
        assert a_spec(nifty_call, *legs, max_legs=12).legs == legs

    def test_the_ceiling_itself_cannot_be_exceeded(self, nifty_call):
        with pytest.raises(DomainError, match="exceeds the ceiling"):
            a_spec(nifty_call, max_legs=MAX_LEGS_CEILING + 1)


class TestSideRules:
    """Selling and buying options are a field on a leg, not a mode."""

    @pytest.mark.parametrize(
        ("rule", "signal", "expected"),
        [
            (SideRule.SAME_AS_SIGNAL, Direction.LONG, Direction.LONG),
            (SideRule.SAME_AS_SIGNAL, Direction.SHORT, Direction.SHORT),
            (SideRule.OPPOSITE, Direction.LONG, Direction.SHORT),
            (SideRule.OPPOSITE, Direction.SHORT, Direction.LONG),
            (SideRule.ALWAYS_SHORT, Direction.LONG, Direction.SHORT),
            (SideRule.ALWAYS_LONG, Direction.SHORT, Direction.LONG),
        ],
    )
    def test_each_rule_resolves_as_declared(self, rule, signal, expected):
        assert rule.resolve(signal) is expected


class TestEvaluation:
    def test_a_single_leg_strategy_emits_one_intent(self, nifty_call):
        result = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call))
        assert len(result.intents) == 1
        assert result.intents[0].kind is IntentKind.ENTER
        assert result.intents[0].direction is Direction.SHORT

    def test_a_hedged_strategy_emits_a_leg_each(self, nifty_call, reliance):
        spec = a_spec(
            nifty_call,
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.ALWAYS_SHORT, sequence=1),
            LegSpec(
                FixedInstrumentSelector(reliance.id),
                SideRule.ALWAYS_LONG,
                role=LegRole.HEDGE,
                sequence=0,
            ),
        )
        context = a_context(
            nifty_call,
            quotes={nifty_call.id: a_quote(nifty_call), reliance.id: a_quote(reliance)},
        )
        result = LegBasedEvaluator().evaluate(spec, context)
        assert len(result.intents) == 2

    def test_legs_are_emitted_in_entry_order(self, nifty_call, reliance):
        """The hedge goes on first, so the main leg is never briefly naked."""
        spec = a_spec(
            nifty_call,
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.ALWAYS_SHORT, sequence=1),
            LegSpec(
                FixedInstrumentSelector(reliance.id),
                SideRule.ALWAYS_LONG,
                role=LegRole.HEDGE,
                sequence=0,
            ),
        )
        context = a_context(
            nifty_call,
            quotes={nifty_call.id: a_quote(nifty_call), reliance.id: a_quote(reliance)},
        )
        roles = [i.role for i in LegBasedEvaluator().evaluate(spec, context).intents]
        assert roles == [LegRole.HEDGE, LegRole.MAIN]

    def test_every_intent_shares_the_evaluation_correlation_id(self, nifty_call, reliance):
        spec = a_spec(
            nifty_call,
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.ALWAYS_SHORT),
            LegSpec(
                FixedInstrumentSelector(reliance.id),
                SideRule.ALWAYS_LONG,
                role=LegRole.HEDGE,
            ),
        )
        context = a_context(
            nifty_call,
            quotes={nifty_call.id: a_quote(nifty_call), reliance.id: a_quote(reliance)},
        )
        ids = {i.correlation_id for i in LegBasedEvaluator().evaluate(spec, context).intents}
        assert ids == {"corr-1"}

    def test_no_direction_signal_stands_aside(self, nifty_call):
        class NoSignal:
            def resolve(self, context: object) -> Direction | None:
                return None

        result = LegBasedEvaluator().evaluate(
            a_spec(nifty_call, direction=NoSignal()), a_context(nifty_call)
        )
        assert not result.acted
        assert result.stood_aside_because == "no direction signal"

    def test_a_missing_quote_stands_aside(self, nifty_call):
        result = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call, quotes={}))
        assert not result.acted
        assert "no quote" in (result.stood_aside_because or "")

    def test_a_leg_that_cannot_resolve_an_instrument_cancels_the_whole_entry(self, nifty_call):
        """A partial entry is worse than none."""

        class NoInstrument:
            def select(self, underlying: InstrumentId, context: object) -> InstrumentId | None:
                return None

        spec = a_spec(
            nifty_call,
            LegSpec(FixedInstrumentSelector(nifty_call.id), SideRule.ALWAYS_SHORT),
            LegSpec(NoInstrument(), SideRule.ALWAYS_LONG, role=LegRole.HEDGE),
        )
        result = LegBasedEvaluator().evaluate(spec, a_context(nifty_call))
        assert not result.acted
        assert "partial entry is worse than none" in (result.stood_aside_because or "")

    def test_an_open_position_stops_re_entry(self, nifty_call):
        """Otherwise a tick-triggered strategy re-enters on every tick."""
        held = Position.flat(nifty_call.id, Currency.INR).apply(
            Fill(
                client_order_id=ClientOrderId("x"),
                instrument=nifty_call.id,
                side=Side.SELL,
                quantity=75,
                price=rupees("120"),
                timestamp=T0,
            )
        )
        result = LegBasedEvaluator().evaluate(
            a_spec(nifty_call), a_context(nifty_call, positions={nifty_call.id: held})
        )
        assert not result.acted
        assert "already holds a position" in (result.stood_aside_because or "")

    def test_a_disabled_subscription_does_nothing(self, nifty_call):
        context = a_context(
            nifty_call,
            subscription=Subscription(
                strategy="test-strategy",
                trading_client=CLIENT,
                mode=TradingMode.PAPER,
                capital=rupees("500000"),
                enabled=False,
            ),
        )
        result = LegBasedEvaluator().evaluate(a_spec(nifty_call), context)
        assert result.stood_aside_because == "the subscription is disabled"


class TestPipeline:
    def build(
        self,
        nifty_call: Instrument,
        clock: ReplayClock,
        limits: RiskLimits | None = None,
        lots: int = 2,
    ) -> tuple[TradingPipeline, PaperBroker, OrderManager]:
        bus = InProcessEventBus()
        broker = PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})
        manager = OrderManager(
            adapter=broker,
            clock=clock,
            bus=bus,
            journal=self._journal,
            trading_day_for=lambda _: DAY,
        )
        pipeline = TradingPipeline(
            sizer=Sizer(FixedLotAllocator(lots)),
            gate=RiskGate(default_checks()),
            order_manager=manager,
            ids=ClientOrderIdSequence(DAY),
            instruments={nifty_call.id: nifty_call},
            limits=limits or RiskLimits(),
        )
        return pipeline, broker, manager

    @staticmethod
    async def _journal(events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        return list(events)

    async def test_an_intent_becomes_a_filled_order(self, nifty_call):
        clock = ReplayClock(T0)
        pipeline, broker, manager = self.build(nifty_call, clock)
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents, quotes={nifty_call.id: a_quote(nifty_call)}, capital=rupees("500000")
        )

        assert outcome.placed
        for event in broker.drain_events():
            await manager.handle(event)
        (order,) = manager.orders.values()
        assert order.status is OrderStatus.FILLED
        assert order.request.side is Side.SELL, "a short intent sells to open"

    async def test_the_risk_gate_can_stop_the_intent(self, nifty_call):
        clock = ReplayClock(T0)
        pipeline, broker, _ = self.build(
            nifty_call, clock, limits=RiskLimits(max_order_quantity=10)
        )
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents, quotes={nifty_call.id: a_quote(nifty_call)}, capital=rupees("500000")
        )

        assert not outcome.placed
        assert outcome.decision is not None
        assert outcome.decision.has(BreachType.ORDER_QTY_EXCEEDED)

    async def test_a_kill_switch_stops_everything(self, nifty_call):
        clock = ReplayClock(T0)
        pipeline, broker, _ = self.build(nifty_call, clock)
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents,
            quotes={nifty_call.id: a_quote(nifty_call)},
            capital=rupees("500000"),
            kill_switch_reason="operator stopped trading",
        )
        assert not outcome.placed
        assert outcome.decision is not None
        assert outcome.decision.has(BreachType.KILL_SWITCH_ACTIVE)

    async def test_capital_short_of_a_lot_refuses_with_a_reason(self, nifty_call):
        clock = ReplayClock(T0)
        pipeline, broker, _ = self.build(nifty_call, clock, lots=0)
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents, quotes={nifty_call.id: a_quote(nifty_call)}, capital=rupees("100")
        )
        assert not outcome.placed
        assert outcome.refusal is not None

    async def test_a_large_entry_is_sliced_into_several_orders(self, nifty_call):
        """Above the freeze limit, one intent is several orders."""
        clock = ReplayClock(T0)
        pipeline, broker, _ = self.build(nifty_call, clock, lots=67)
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents, quotes={nifty_call.id: a_quote(nifty_call)}, capital=rupees("100000000")
        )
        assert len(outcome.orders) == 3
        assert sum(o.request.quantity for o in outcome.orders) == 5025
        assert all(o.request.quantity <= 1800 for o in outcome.orders)

    async def test_every_order_carries_the_correlation_id(self, nifty_call):
        clock = ReplayClock(T0)
        pipeline, broker, _ = self.build(nifty_call, clock, lots=67)
        await broker.on_tick(a_quote(nifty_call))

        intents = LegBasedEvaluator().evaluate(a_spec(nifty_call), a_context(nifty_call)).intents
        (outcome,) = await pipeline.submit(
            intents, quotes={nifty_call.id: a_quote(nifty_call)}, capital=rupees("100000000")
        )
        assert {o.request.tag for o in outcome.orders} == {"corr-1"}
