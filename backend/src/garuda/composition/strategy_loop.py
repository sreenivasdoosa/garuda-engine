"""Running the strategies.

The last join. On a cadence, for every active subscription and every tranche
of it that is still open, build a view of the moment, evaluate, and deliver
whatever comes out.

**Paced by what it watches, not by a timer** in the end (`STRATEGY_RULES.md`
§7); until rules declare their dependencies this sweeps on a short interval,
which for inputs published about once a second is the same thing at a slightly
higher cost.

Two things this owns that nothing below it can:

* **The tranche ledger**, restored at day-init so a restart at 13:05 does not
  re-enter a tranche that fired at 13:00.
* **Containment.** One strategy that fails must not stop the sweep. Trade
  management is still running positions that are already on, and a strategy
  raising on the way in is no reason to stop looking after them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field, replace
from datetime import date, datetime, timedelta

from garuda.alerts.manager import AlertManager
from garuda.composition.engine import ClientParts, Engine
from garuda.composition.routing import deliver
from garuda.composition.strategies import Loaded, Strategy
from garuda.composition.strategy_context import LiveContext, MarketView, day_conditions_for
from garuda.domain.alert import EntityType
from garuda.domain.exchange import Exchange
from garuda.domain.trade import Trade
from garuda.engine.daycondition import DayCondition
from garuda.engine.signals import SignalBatch
from garuda.engine.strategy import Result, StrategyRunner, StrategySubscription
from garuda.engine.tranches import TrancheLedger
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: How often the strategies are swept. Short enough that a condition met at
#: 13:00:00 is acted on by 13:00:01, which is well inside the resolution
#: anything here is configured at.
DEFAULT_INTERVAL = timedelta(seconds=1)


@dataclass
class StrategyLoop:
    """Every subscribed strategy, evaluated until the day ends."""

    engine: Engine
    loaded: Loaded
    market: MarketView
    venue: Exchange
    clock: Clock
    alerts: AlertManager
    runner: StrategyRunner
    ledger: TrancheLedger
    interval: timedelta = DEFAULT_INTERVAL
    _stopping: bool = False
    #: Strategies that raised on the way in, so the alert is raised once and
    #: not once a second.
    _reported: set[str] = field(default_factory=set)

    @property
    def trading_day(self) -> date:
        return self.ledger.trading_day

    async def run_once(self) -> list[Result]:
        """One sweep of everything subscribed.

        History first, so a rule reading candles sees what the last sweep asked
        for. A rule cannot wait on a broker, so this is where the waiting
        happens.
        """
        now = self.clock.now()
        await self._refresh_history()
        self.ledger.expire_due(now)

        results: list[Result] = []
        for subscription in self.loaded.subscriptions:
            results.extend(await self._sweep(subscription, now))
        return results

    async def run_forever(self) -> None:
        self._stopping = False
        while not self._stopping:
            try:
                await self.run_once()
            except Exception:
                # The sweep itself came apart, which is different from one
                # strategy failing. Reported and retried: positions already on
                # are still being managed, and stopping helps nobody.
                logger.exception("the strategy sweep failed")
            await self.clock.sleep(self.interval)

    def stop(self) -> None:
        self._stopping = True

    async def _refresh_history(self) -> None:
        """Bring the candle cache up to date. Never raises."""
        cache = self.market.candles
        if cache is None:
            return
        windows = self.venue.calendar.windows_on(self.trading_day)
        if not windows:
            return
        try:
            await cache.refresh_due(session_start=windows[0].start)
        except Exception:
            logger.exception("could not refresh candle history")

    async def _sweep(self, subscription: StrategySubscription, now: datetime) -> list[Result]:
        strategy = self.loaded.strategies.get(subscription.spec.name)
        client = self.engine.parts.clients.get(subscription.trading_client)
        if strategy is None or client is None:
            return []

        conditions = day_conditions_for(
            subscription.spec.underlying,
            self.trading_day,
            self.market.registry(),
            self.venue.calendar,
        )

        results: list[Result] = []
        await self._consider_exits(subscription, client, conditions)
        for tranche in subscription.tranches:
            state = self.ledger.get(subscription.identity(tranche, now))
            if state is not None and not state.is_open:
                continue
            try:
                results.append(
                    await self.runner.evaluate(
                        subscription,
                        tranche,
                        self._context(subscription, strategy, tranche, conditions, client, now=now),
                    )
                )
            except Exception as error:
                await self._failed(subscription, tranche, error)
        return results

    def _context(
        self,
        subscription: StrategySubscription,
        strategy: Strategy,
        tranche: int,
        conditions: frozenset[DayCondition],
        client: ClientParts,
        *,
        now: datetime | None = None,
        trade: Trade | None = None,
    ) -> LiveContext:
        """One evaluation's view. Built fresh, because it holds a moment."""
        return LiveContext(
            market=self.market,
            book=client.book,
            now=now or self.clock.now(),
            trading_day=self.trading_day,
            strategy=subscription.spec.name,
            trading_client=subscription.trading_client,
            tranche=tranche,
            config=strategy.configuration(tranche, conditions),
            underlying=subscription.spec.underlying,
            day_conditions=conditions,
            trade=trade,
        )

    async def _consider_exits(
        self,
        subscription: StrategySubscription,
        client: ClientParts,
        conditions: frozenset[DayCondition],
    ) -> None:
        """Whether anything already on should come off early.

        Before the entries, because a strategy that wants out and back in on
        the same sweep should get out first — and because a position leaving
        frees the capital the entry will size against.
        """
        # Whether there are exit rules at all is the runner's to decide, and
        # having it in two places is having it disagree in one of them.
        strategy = self.loaded.strategies.get(subscription.spec.name)
        if strategy is None:
            return

        def context_for(trade: Trade) -> LiveContext:
            return self._context(subscription, strategy, 0, conditions, client, trade=trade)

        runner = replace(self.runner, request_exit=client.square_off.request)
        try:
            await runner.consider_exits(
                subscription, client.book.trades_for(subscription.spec.name), context_for
            )
        except Exception:
            logger.exception("%s: exit rules could not be evaluated", subscription.spec.name)

    async def _failed(
        self, subscription: StrategySubscription, tranche: int, error: Exception
    ) -> None:
        name = subscription.spec.name
        logger.exception("%s tranche %d could not be evaluated", name, tranche)
        if name in self._reported:
            return
        self._reported.add(name)
        await self.alerts.critical(
            EntityType.STRATEGY,
            name,
            "strategy-evaluation",
            f"{name} could not be evaluated for {subscription.trading_client.value} "
            f"({type(error).__name__}: {error}). It will not enter until this is fixed; "
            "positions already on are still managed.",
            key=f"strategy-evaluation:{name}",
        )


async def deliver_for(engine: Engine, batch: SignalBatch) -> bool:
    """Hand a batch to the account it names, and say whether it landed."""
    delivery = await deliver(engine, batch)
    if not delivery.delivered and delivery.refusal is not None:
        logger.info("signals not delivered: %s", delivery.refusal)
    return delivery.delivered
