"""The evaluator.

There is exactly one, and it reads a :class:`StrategySpec`. It orchestrates:
resolve direction, resolve each leg's instrument, decide the side, emit
intents in entry order. Every piece of real logic lives in a direction
provider or an instrument selector.

If an ``if leg.kind is OPTION`` branch ever appears here, something belongs in
a selector instead. That is the tripwire.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from garuda.domain.enums import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import Intent, IntentKind
from garuda.engine.context import EvaluationContext, EvaluationResult
from garuda.engine.spec import LegSpec, StrategySpec


@runtime_checkable
class StrategyEvaluator(Protocol):
    def evaluate(self, spec: StrategySpec, context: EvaluationContext) -> EvaluationResult: ...


class LegBasedEvaluator:
    """The engine's only evaluator."""

    def evaluate(self, spec: StrategySpec, context: EvaluationContext) -> EvaluationResult:
        if not context.subscription.enabled:
            return EvaluationResult(stood_aside_because="the subscription is disabled")

        if self._already_in(spec, context):
            return self._maybe_exit(spec)

        signal = spec.direction.resolve(context)
        if signal is None:
            return EvaluationResult(stood_aside_because="no direction signal")

        intents: list[Intent] = []
        for leg in spec.entry_order:
            instrument = leg.selector.select(spec.underlying, context)
            if instrument is None:
                return EvaluationResult(
                    stood_aside_because=(
                        f"{leg.role} leg could not resolve an instrument; "
                        "a partial entry is worse than none"
                    )
                )
            if context.quote(instrument) is None:
                return EvaluationResult(
                    stood_aside_because=f"no quote for {instrument}",
                )
            intents.append(self._entry(spec, leg, instrument, signal, context))

        return EvaluationResult(intents=tuple(intents))

    # -- internals ----------------------------------------------------------

    def _already_in(self, spec: StrategySpec, context: EvaluationContext) -> bool:
        for leg in spec.legs:
            instrument = leg.selector.select(spec.underlying, context)
            if instrument is not None and context.has_open_position(instrument):
                return True
        return False

    def _maybe_exit(self, spec: StrategySpec) -> EvaluationResult:
        """Exits arrive with the exit policies; entry does not repeat meanwhile.

        Standing aside while a position is open is what stops a tick-triggered
        strategy re-entering on every tick.
        """
        return EvaluationResult(stood_aside_because=f"{spec.name} already holds a position")

    def _entry(
        self,
        spec: StrategySpec,
        leg: LegSpec,
        instrument: object,
        signal: Direction,
        context: EvaluationContext,
    ) -> Intent:

        assert isinstance(instrument, InstrumentId)
        return Intent(
            kind=IntentKind.ENTER,
            strategy=spec.name,
            trading_client=context.subscription.trading_client,
            instrument=instrument,
            direction=leg.side.resolve(signal),
            product=leg.product,
            correlation_id=context.correlation_id,
            role=leg.role,
            order_type=leg.order_type,
            ratio_numerator=leg.ratio_numerator,
            ratio_denominator=leg.ratio_denominator,
        )
