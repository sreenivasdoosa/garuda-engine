"""Running one strategy's tranche.

Everything below this exists; this is the order they go in. For one
subscription's tranche, on one evaluation:

1. the tranche is open, or there is nothing to do;
2. its entry rules pass, or the tranche records what blocked it;
3. a direction is resolved, or the strategy stands aside;
4. every leg resolves to a listed instrument, or the entry stands down whole;
5. the legs become intents, which the signal factory sizes into signals,
   protected at the levels this tranche's configuration asks for;
6. the tranche arms, the signals are delivered, and the tranche fires.

**A partial entry is worse than none**, and that line is held at three
separate steps: a leg that cannot be resolved stands the entry down, a leg that
cannot be sized refuses the batch, and a combo whose leg is already held is
withdrawn on delivery. Each is a different failure and each would otherwise
leave an account holding something nobody designed.

Nothing here knows what a rule means, what an indicator is, or how a strike is
chosen. It knows the order.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import Intent, IntentKind, LegRole
from garuda.domain.money import Money
from garuda.engine.direction import DirectionRule, first_answer
from garuda.engine.protection import configured_protection
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.evaluate import RuleRunner, blocking_reason
from garuda.engine.rules.registry import Rule
from garuda.engine.selectors import SelectionContext
from garuda.engine.signals import SignalBatch, SignalFactory
from garuda.engine.spec import LegSpec, StrategySpec
from garuda.engine.tranches import Tranche, TrancheId, TrancheLedger

logger = logging.getLogger(__name__)


class StrategyContext(RuleContext, SelectionContext, Protocol):
    """Everything one evaluation needs: what a rule sees and what a leg needs.

    Two protocols rather than one, because they answer different questions and
    a selector reaching for candles is doing a rule's job. One object
    implements both, so an evaluation is consistent across the pair.
    """


#: Hands a built batch to the account that will trade it. Returns whether it
#: landed; why it did not is the deliverer's to report. Asynchronous because
#: a book is, and pretending otherwise would mean a synchronous runner that
#: cannot actually deliver anything.
type Deliver = Callable[[SignalBatch], Awaitable[bool]]


@dataclass(frozen=True, slots=True)
class Result:
    """What one tranche's evaluation produced."""

    tranche: Tranche
    signals: tuple[str, ...] = ()
    #: Why nothing happened, when nothing did. None on a firing.
    stood_down: str | None = None

    @property
    def fired(self) -> bool:
        return bool(self.signals) and self.stood_down is None


@dataclass(frozen=True)
class StrategySubscription:
    """One account running one strategy, and what it is allowed to do.

    Named apart from :class:`garuda.engine.context.Subscription`, which the
    phase-one pipeline uses for the same idea with fewer fields. The two want
    merging once the pipeline path is retired; until then, two names is
    clearer than one name meaning two things.
    """

    trading_client: TradingClientId
    spec: StrategySpec
    capital: Money
    entry_rules: Rule
    #: Asked in order; the first with an opinion wins. Empty means the legs'
    #: own side rules decide, which is what an undirectional strategy is.
    direction_rules: tuple[DirectionRule, ...] = ()
    #: How much of the tranche's day is left, as an absolute instant.
    cutoff: datetime | None = None
    tranches: tuple[int, ...] = (0,)
    is_paper: bool = False
    group: str = "DEFAULT"

    def identity(self, tranche: int, on: datetime) -> TrancheId:
        return TrancheId(
            trading_client=self.trading_client,
            strategy=self.spec.name,
            tranche=tranche,
            trading_day=on.date(),
        )


@dataclass
class StrategyRunner:
    """Evaluates subscriptions and delivers what they produce."""

    factory: SignalFactory
    deliver: Deliver
    ledger: TrancheLedger
    rules: RuleRunner = field(default_factory=RuleRunner)

    async def evaluate(
        self, subscription: StrategySubscription, tranche: int, context: StrategyContext
    ) -> Result:
        """One tranche, one pass."""
        if context.tranche != tranche:
            # Two sources for one number is two chances to disagree. A context
            # built for one tranche and asked about another would label the
            # signals with one and record the entry against the other, and
            # duplicate detection keys on that label.
            raise DomainError(
                f"{subscription.spec.name}: asked to evaluate tranche {tranche} with a "
                f"context built for tranche {context.tranche}"
            )

        identity = subscription.identity(tranche, context.now)
        state = self.ledger.open_for(identity, cutoff=subscription.cutoff)

        if not state.is_open:
            return Result(state, stood_down=f"already {state.state.lower()}")
        if state.has_expired(context.now):
            closed = state.expired(context.now)
            self.ledger.record(closed)
            return Result(closed, stood_down=closed.blocked_by)

        blocked = self._blocked(subscription, context)
        if blocked is not None:
            waiting = state.blocked(blocked)
            self.ledger.record(waiting)
            return Result(waiting, stood_down=blocked)

        batch = self._build(subscription, tranche, context)
        if batch.refusal is not None or not batch.signals:
            reason = batch.refusal or "nothing to enter"
            waiting = state.blocked(reason)
            self.ledger.record(waiting)
            return Result(waiting, stood_down=reason)

        identifiers = tuple(signal.id for signal in batch.signals)
        armed = state.armed(context.now, identifiers)
        self.ledger.record(armed)

        if not await self.deliver(batch):
            # Built and refused at the door. The tranche stays armed rather
            # than firing: something is holding these signals and the day is
            # not over, and marking it fired would hide that.
            return Result(armed, stood_down="the signals were not accepted")

        fired = armed.fired(context.now)
        self.ledger.record(fired)
        logger.info(
            "%s tranche %d entered with %d signal(s)",
            subscription.spec.name,
            tranche,
            len(identifiers),
        )
        return Result(fired, signals=identifiers)

    async def evaluate_all(
        self, subscription: StrategySubscription, context_for: Callable[[int], StrategyContext]
    ) -> list[Result]:
        """Every tranche of one subscription, in order.

        A context per tranche, not one for all of them: a context carries the
        tranche it was built for, because rules ask about it — how long since
        the previous tranche, how many have already gone on. One context
        serving several would answer for the wrong one.
        """
        return [
            await self.evaluate(subscription, tranche, context_for(tranche))
            for tranche in subscription.tranches
        ]

    # -- the steps ----------------------------------------------------------

    def _blocked(self, subscription: StrategySubscription, context: StrategyContext) -> str | None:
        evaluation = self.rules.evaluate(
            subscription.entry_rules, context, label=subscription.spec.name
        )
        return blocking_reason(evaluation)

    def _build(
        self, subscription: StrategySubscription, tranche: int, context: StrategyContext
    ) -> SignalBatch:
        direction = self._direction(subscription, context)
        if direction is None:
            return SignalBatch(refusal=f"{subscription.spec.name}: no direction to trade")

        intents = self._intents(subscription, tranche, direction, context)
        if isinstance(intents, str):
            return SignalBatch(refusal=intents)

        return self.factory.build(
            intents,
            capital=subscription.capital,
            now=context.now,
            group=subscription.group,
            tranche=tranche,
            is_paper=subscription.is_paper,
            protection=configured_protection(context.config),
        )

    def _direction(
        self, subscription: StrategySubscription, context: StrategyContext
    ) -> Direction | None:
        """Which way, from the configured rules or the spec's own provider.

        The rules win when there are any. A strategy with none falls back to
        the spec, which for an undirectional one answers a fixed side that its
        legs then read as "sell both".
        """
        if subscription.direction_rules:
            return first_answer(subscription.direction_rules, context)
        return subscription.spec.direction.resolve(context)

    def _intents(
        self,
        subscription: StrategySubscription,
        tranche: int,
        direction: Direction,
        context: StrategyContext,
    ) -> list[Intent] | str:
        """One intent per leg, or the reason there are none."""
        spec = subscription.spec
        correlation = _correlation(subscription, tranche, context)
        intents: list[Intent] = []

        for leg in spec.entry_order:
            instrument = leg.selector.select(spec.underlying, context)
            if instrument is None:
                return (
                    f"{spec.name}: the {leg.role} leg resolved to no listed instrument, "
                    "so the whole entry stands down — a partial entry is worse than none"
                )
            intents.append(
                _intent(spec.name, subscription, leg, instrument, direction, correlation)
            )
        return intents


def _intent(
    strategy: str,
    subscription: StrategySubscription,
    leg: LegSpec,
    instrument: InstrumentId,
    direction: Direction,
    correlation: str,
) -> Intent:
    return Intent(
        kind=IntentKind.ENTER,
        strategy=strategy,
        trading_client=subscription.trading_client,
        instrument=instrument,
        direction=leg.side.resolve(direction),
        product=leg.product,
        correlation_id=correlation,
        role=leg.role,
        order_type=leg.order_type,
        ratio_numerator=leg.ratio_numerator,
        ratio_denominator=leg.ratio_denominator,
    )


def _correlation(subscription: StrategySubscription, tranche: int, context: StrategyContext) -> str:
    """Ties one evaluation's legs together, and to everything downstream.

    Derived rather than random, so a replay produces the same ids and duplicate
    detection has something stable to compare. One evaluation of one tranche on
    one day is one correlation, whatever it emits.
    """
    return (
        f"{subscription.trading_client.value}-{subscription.spec.name}"
        f"-{context.trading_day:%Y%m%d}-{tranche}"
    )


def legs_of(spec: StrategySpec) -> Sequence[tuple[LegRole, ProductType]]:
    """What a spec will try to enter, for the console and the log."""
    return [(leg.role, leg.product) for leg in spec.entry_order]
