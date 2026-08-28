"""A scripted trading session, end to end.

Drives the real pipeline -- evaluator, sizer, risk gate, order manager, paper
broker -- against a fixed list of ticks, journalling everything as it goes.

Everything that could vary between two runs is pinned:

* the clock is a :class:`ReplayClock` advanced to each tick's own timestamp,
  so nothing reads wall time;
* client order ids come from a dated counter;
* correlation ids are derived from the evaluation number;
* the paper broker's fill model has no randomness in it.

What remains is the engine's own behaviour, which is exactly what a replay is
supposed to be comparing.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime

from garuda.brokers.paper import PaperBroker, PaperFillPolicy
from garuda.capital.sizing import Sizer
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.journal import JournalEvent
from garuda.domain.market import Tick
from garuda.domain.order import ClientOrderId, Order
from garuda.domain.position import Position
from garuda.engine.context import EvaluationContext, Subscription
from garuda.engine.evaluator import LegBasedEvaluator
from garuda.engine.pipeline import IntentOutcome, TradingPipeline
from garuda.engine.spec import StrategySpec
from garuda.ordermgmt.ids import ClientOrderIdSequence
from garuda.ordermgmt.manager import JournalAppender, OrderManager
from garuda.rms.gate import RiskGate
from garuda.rms.limits import RiskLimits


@dataclass(frozen=True)
class SessionOutcome:
    """What a run produced."""

    orders: Mapping[ClientOrderId, Order]
    positions: Mapping[InstrumentId, Position]
    outcomes: tuple[IntentOutcome, ...] = field(default_factory=tuple)
    evaluations: int = 0

    @property
    def filled_orders(self) -> int:
        return sum(1 for order in self.orders.values() if order.filled_quantity > 0)


class SessionHarness:
    """Runs one scripted day."""

    def __init__(
        self,
        spec: StrategySpec,
        subscription: Subscription,
        instruments: Mapping[InstrumentId, Instrument],
        journal: JournalAppender,
        trading_day: date,
        start: datetime,
        sizer: Sizer,
        gate: RiskGate,
        *,
        limits: RiskLimits | None = None,
        fill_policy: PaperFillPolicy | None = None,
    ) -> None:
        self.spec = spec
        self.subscription = subscription
        self.instruments = instruments
        self.trading_day = trading_day
        self.clock = ReplayClock(start, auto_advance=False)
        self.bus = InProcessEventBus()
        self.broker = PaperBroker(subscription.trading_client, self.clock, instruments, fill_policy)
        self.orders = OrderManager(
            adapter=self.broker,
            clock=self.clock,
            bus=self.bus,
            journal=journal,
            trading_day_for=lambda _: trading_day,
        )
        self.pipeline = TradingPipeline(
            sizer=sizer,
            gate=gate,
            order_manager=self.orders,
            ids=ClientOrderIdSequence(trading_day),
            instruments=instruments,
            limits=limits,
        )
        self.evaluator = LegBasedEvaluator()
        self._quotes: dict[InstrumentId, Tick] = {}

    async def run(self, ticks: Sequence[Tick]) -> SessionOutcome:
        outcomes: list[IntentOutcome] = []
        evaluations = 0

        for tick in ticks:
            await self.clock.advance_to(tick.timestamp)
            self._quotes[tick.instrument] = tick
            await self.broker.on_tick(tick)
            await self._drain()

            evaluations += 1
            context = EvaluationContext(
                subscription=self.subscription,
                now=self.clock.now(),
                correlation_id=f"{self.spec.name}-{evaluations:04d}",
                quotes=dict(self._quotes),
                positions=self._positions(),
            )
            result = self.evaluator.evaluate(self.spec, context)
            if result.acted:
                outcomes.extend(
                    await self.pipeline.submit(
                        result.intents,
                        quotes=dict(self._quotes),
                        capital=self.subscription.capital,
                    )
                )
                await self._drain()

        return SessionOutcome(
            orders=dict(self.orders.orders),
            positions=self._positions(),
            outcomes=tuple(outcomes),
            evaluations=evaluations,
        )

    async def _drain(self) -> None:
        for event in self.broker.drain_events():
            await self.orders.handle(event)

    def _positions(self) -> dict[InstrumentId, Position]:
        positions: dict[InstrumentId, Position] = {}
        for instrument_id in self.instruments:
            position = self.broker.position(instrument_id)
            if position is not None:
                positions[instrument_id] = position
        return positions


def comparable(events: Sequence[JournalEvent]) -> list[tuple[object, ...]]:
    """A journal reduced to what two runs must agree on.

    Sequence numbers are included: two identical runs must not only record the
    same facts but record them in the same order.
    """
    return [
        (
            event.sequence,
            event.event_type.value,
            event.aggregate_type.value,
            event.aggregate_id,
            event.occurred_at.isoformat(),
            event.trading_day.isoformat(),
            event.actor.value,
            event.correlation_id,
            tuple(sorted(dict(event.payload).items(), key=lambda item: item[0])),
        )
        for event in events
    ]
