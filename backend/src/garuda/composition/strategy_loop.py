"""Running the strategies.

`STRATEGY_ENGINE.md` §3. Every second the loop does its housekeeping -- keep
the feed quoting what the strategies need, price the synthetic series, bring
candle history up to date -- and then asks the day's tranche schedule what is
due. Each due tranche is evaluated for every account subscribed to it,
through the pipeline in `garuda.engine.base_strategy`, and whatever comes out
is delivered to that account's book.

Three things this owns that nothing below it can:

* **The day.** At the first pass of a trading day it reads the strategy
  state rows for that day -- a restart at 13:05 knows the 13:00 tranche went
  on -- and builds the tranche schedule. A new day rebuilds both.
* **Writing state.** A tranche signalled is written at once; counters are
  flushed every thirty seconds, the reference's rule.
* **Containment.** One strategy that fails must not stop the others.
  Trade management is still running positions that are already on, and a
  strategy raising on the way in is no reason to stop looking after them.

Evaluations for one subscription never overlap: tranches due together are
evaluated one after another, which is the reference's per-subscription
serialisation without its striped locks.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from dataclasses import replace as dataclass_replace
from datetime import date, datetime, timedelta
from typing import Protocol

from garuda.alerts.manager import AlertManager
from garuda.capital.event_days import NO_EVENT_DAYS, EventDays
from garuda.composition.derived_series import DerivedSeriesRecorder
from garuda.composition.engine import Engine
from garuda.composition.instruments import SymbolBook
from garuda.composition.routing import deliver
from garuda.composition.strategies import NOTHING_LOADED, Loaded, Strategy, Subscription
from garuda.composition.strategy_context import (
    ChainOnly,
    LiveContext,
    LiveEnvironment,
    MarketView,
    day_conditions_for,
)
from garuda.composition.watchlist import Watchlist
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import InstrumentId, canonical_symbol
from garuda.engine.base_strategy import BaseStrategy, Evaluation, Outcome
from garuda.engine.config import ResolvedConfig
from garuda.engine.daycondition import DayCondition
from garuda.engine.rules.evaluate import RuleRunner, blocking_reason
from garuda.engine.runtime_config import SubscriptionTerms
from garuda.engine.schedule import Slot, TrancheSchedule
from garuda.engine.signals import SignalBatch
from garuda.engine.strategy_state import StrategyState
from garuda.engine.vocabulary import StrategyStatus
from garuda.marketdata.synthetics import (
    ImpliedVolatility,
    SyntheticPublisher,
    for_symbol,
    for_symbols,
)
from garuda.protocols.clock import Clock
from garuda.protocols.feed import TicksReceived

logger = logging.getLogger(__name__)

#: How often the loop looks at the clock.
DEFAULT_INTERVAL = timedelta(seconds=1)
#: How often counters that changed without a critical change are written.
STATE_FLUSH_INTERVAL = timedelta(seconds=30)


class StateStore(Protocol):
    async def load_day(self, trading_day: date) -> list[StrategyState]: ...
    async def save(self, state: StrategyState, *, now: datetime) -> None: ...


@dataclass(frozen=True, slots=True)
class Evaluated:
    """One subscription's evaluation of one tranche, for the log and tests."""

    strategy: str
    trading_client: TradingClientId
    tranche: int
    outcome: Outcome
    delivered: bool = False
    refusal: str | None = None


@dataclass
class StrategyLoop:
    """Every subscribed strategy, evaluated as its tranches come due."""

    engine: Engine
    loaded: Loaded
    market: MarketView
    venue: Exchange
    clock: Clock
    alerts: AlertManager
    #: Where strategy state is kept. None keeps it in memory only, which is a
    #: test rather than a running engine.
    states: StateStore | None = None
    event_days: EventDays = NO_EVENT_DAYS
    pipeline: BaseStrategy = field(default_factory=BaseStrategy)
    watchlist: Watchlist | None = None
    synthetics: SyntheticPublisher | None = None
    derived: DerivedSeriesRecorder | None = None
    symbols: SymbolBook | None = None
    _symbols_version: int = -1
    interval: timedelta = DEFAULT_INTERVAL
    rules: RuleRunner = field(default_factory=RuleRunner)
    _stopping: bool = False
    _day: date | None = None
    _schedule: TrancheSchedule | None = None
    _state: dict[tuple[TradingClientId, str], StrategyState] = field(default_factory=dict)
    _unsaved: set[tuple[TradingClientId, str]] = field(default_factory=set)
    _last_flush: datetime | None = None
    #: Keys of alerts already raised, so one is raised once and not each second.
    _reported: set[str] = field(default_factory=set)

    # -- status ------------------------------------------------------------

    @property
    def trading_day(self) -> date:
        return self._day or self.venue.trading_day_for(self.clock.now())

    @property
    def schedule(self) -> TrancheSchedule | None:
        return self._schedule

    @property
    def tranches_pending(self) -> int:
        return len(self._schedule.pending) if self._schedule else 0

    @property
    def tranches_today(self) -> int:
        return len(self._schedule.slots) if self._schedule else 0

    def state_of(self, client: TradingClientId, strategy: str) -> StrategyState | None:
        return self._state.get((client, strategy))

    # -- running -----------------------------------------------------------

    async def run_once(self) -> list[Evaluated]:
        now = self.clock.now()
        self._refresh_series()
        await self._watch()
        await self._publish_synthetics(now)
        await self._refresh_history()
        await self._roll(now)

        results: list[Evaluated] = []
        if self._schedule is not None:
            for slot in self._schedule.due(now):
                results.extend(await self._fire(slot, now))
        await self._flush(now)
        return results

    async def run_forever(self) -> None:
        self._stopping = False
        while not self._stopping:
            try:
                await self.run_once()
            except Exception:
                logger.exception("the strategy loop pass failed")
            await self.clock.sleep(self.interval)

    def stop(self) -> None:
        self._stopping = True

    @property
    def is_stopping(self) -> bool:
        return self._stopping

    def replace(self, loaded: Loaded) -> None:
        """Take a fresh reading of the strategy tables, whole.

        The schedule is rebuilt for the new definitions, keeping what has
        already fired today. A strategy that just became ACTIVE with
        `catch_up_missed_tranches` has its missed tranches re-timed from now,
        a minute apart; any it already signalled stay signalled.
        """
        before = self.loaded
        self.loaded = loaded
        logger.info(
            "strategies reloaded: %d strategies, %d subscriptions (was %d), %d left out",
            len(loaded.strategies),
            len(loaded.subscriptions),
            len(before.subscriptions),
            len(loaded.refused),
        )
        if self._schedule is None or self._day is None:
            return
        now = self.clock.now()
        fired = {slot.key for slot in self._schedule.fired}
        rebuilt = self._build_schedule(self._day, now)
        for index, slot in enumerate(rebuilt.slots):
            if slot.key in fired:
                rebuilt.slots[index] = dataclass_replace(slot, fired=True, missed=False)
        for name, strategy in loaded.strategies.items():
            was = before.strategies.get(name)
            reactivated = strategy.definition.status is StrategyStatus.ACTIVE and (
                was is None or was.definition.status is not StrategyStatus.ACTIVE
            )
            if reactivated and strategy.definition.catch_up_missed_tranches and was is not None:
                retimed = rebuilt.catch_up(name, now)
                if retimed:
                    logger.info(
                        "%s reactivated: catching up tranche(s) %s",
                        name,
                        ", ".join(str(slot.tranche) for slot in retimed),
                    )
        self._schedule = rebuilt

    # -- the day -----------------------------------------------------------

    async def _roll(self, now: datetime) -> None:
        day = self.venue.trading_day_for(now)
        if day == self._day:
            return
        await self._flush(now, force=True)
        self._state = {}
        self._unsaved = set()
        if self.states is not None:
            for state in await self.states.load_day(day):
                self._state[(state.trading_client, state.strategy)] = state
        self._day = day
        self._schedule = self._build_schedule(day, now)
        logger.info(
            "strategy day %s: %d tranche(s) scheduled, %d already past, %d without a time",
            day,
            len(self._schedule.slots),
            len(self._schedule.missed),
            len(self._schedule.unscheduled),
        )

    def _build_schedule(self, day: date, now: datetime) -> TrancheSchedule:
        if not self.venue.calendar.is_trading_day(day):
            return TrancheSchedule(day)
        timings: dict[str, list[tuple[int, str | None, str | None]]] = {}
        for name, strategy in self.loaded.strategies.items():
            if not self.loaded.subscribers(name):
                continue
            if not strategy.definition.scheduled_trigger:
                continue
            conditions = self._conditions(strategy, day)
            runtime = strategy.runtime(_SCHEDULING_TERMS, conditions)
            timings[name] = [
                (
                    number,
                    runtime.tranche(number).text("tranch_timing"),
                    runtime.tranche(number).text("tranch_cutoff_time"),
                )
                for number in runtime.tranche_numbers
            ]
        return TrancheSchedule.build(day, self.venue.timezone, timings, now=now)

    def _conditions(self, strategy: Strategy, day: date) -> frozenset[DayCondition]:
        return day_conditions_for(
            strategy.underlying, day, self.market.registry(), self.venue.calendar
        )

    # -- one tranche -------------------------------------------------------

    async def _fire(self, slot: Slot, now: datetime) -> list[Evaluated]:
        strategy = self.loaded.strategies.get(slot.strategy)
        if strategy is None:
            return []
        results: list[Evaluated] = []
        for subscription in self.loaded.subscribers(slot.strategy):
            try:
                results.append(await self._evaluate(strategy, subscription, slot.tranche, now))
            except Exception as error:
                await self._failed(strategy.name, subscription, slot.tranche, error)
        return results

    async def _evaluate(
        self, strategy: Strategy, subscription: Subscription, tranche: int, now: datetime
    ) -> Evaluated:
        day = self.trading_day
        key = (subscription.trading_client, strategy.name)
        state = self._state.get(key) or StrategyState(
            trading_client=subscription.trading_client, strategy=strategy.name, trading_day=day
        )
        if not self.venue.is_open(now):
            outcome = Outcome(state=state, stood_down=f"{self.venue.code} is not open")
            return Evaluated(strategy.name, subscription.trading_client, tranche, outcome)

        conditions = self._conditions(strategy, day)
        runtime = strategy.runtime(subscription.terms, conditions)
        env = LiveEnvironment(
            market=self.market,
            venue=self.venue,
            now=now,
            trading_day=day,
            conditions=conditions,
            day_allocation=strategy.day_allocation,
            event_days=self.event_days,
            memory=state.data,
        )
        evaluation = Evaluation(
            runtime=runtime,
            state=state,
            env=env,
            tranche=tranche,
            entry_gate=self._entry_gate(strategy, subscription, tranche, conditions, now),
        )
        outcome = self.pipeline.on_scheduled(evaluation)
        self._remember(key, state, outcome.state, now)

        delivered, refusal = False, None
        if outcome.entered:
            delivery = await deliver(
                self.engine, SignalBatch(signals=outcome.signals, legs=outcome.legs)
            )
            delivered, refusal = delivery.delivered, delivery.refusal
            logger.info(
                "%s tranche %d for %s: %d signal(s), %d lot(s)%s",
                strategy.name,
                tranche,
                subscription.trading_client.value,
                len(outcome.signals),
                outcome.lots,
                "" if delivered else f" -- not delivered: {refusal}",
            )
        else:
            logger.info(
                "%s tranche %d for %s stood down: %s",
                strategy.name,
                tranche,
                subscription.trading_client.value,
                outcome.stood_down,
            )
            if outcome.alert:
                await self._skipped(strategy.name, subscription, tranche, outcome.stood_down or "")
        await self._persist_if_critical(key, state, outcome.state, now)
        return Evaluated(
            strategy.name, subscription.trading_client, tranche, outcome, delivered, refusal
        )

    def _entry_gate(
        self,
        strategy: Strategy,
        subscription: Subscription,
        tranche: int,
        conditions: frozenset[DayCondition],
        now: datetime,
    ) -> Callable[[ResolvedConfig], str | None] | None:
        rules = strategy.entry_rules
        client = self.engine.parts.clients.get(subscription.trading_client)
        if rules is None or client is None:
            return None

        def blocked(config: ResolvedConfig) -> str | None:
            context = LiveContext(
                market=self.market,
                book=client.book,
                now=now,
                trading_day=self.trading_day,
                strategy=strategy.name,
                trading_client=subscription.trading_client,
                tranche=tranche,
                config=config,
                underlying=strategy.underlying,
                day_conditions=conditions,
            )
            return blocking_reason(self.rules.evaluate(rules, context, label=strategy.name))

        return blocked

    # -- state -------------------------------------------------------------

    def _remember(
        self,
        key: tuple[TradingClientId, str],
        before: StrategyState,
        after: StrategyState,
        now: datetime,
    ) -> None:
        del before, now
        self._state[key] = after
        self._unsaved.add(key)

    async def _persist_if_critical(
        self,
        key: tuple[TradingClientId, str],
        before: StrategyState,
        after: StrategyState,
        now: datetime,
    ) -> None:
        if self.states is None or not after.critical_change(before):
            return
        await self.states.save(after, now=now)
        self._unsaved.discard(key)

    async def _flush(self, now: datetime, *, force: bool = False) -> None:
        if self.states is None or not self._unsaved:
            self._last_flush = self._last_flush or now
            return
        if not force and self._last_flush and now - self._last_flush < STATE_FLUSH_INTERVAL:
            return
        for key in list(self._unsaved):
            state = self._state.get(key)
            if state is None:
                continue
            try:
                await self.states.save(state, now=now)
                self._unsaved.discard(key)
            except Exception:
                logger.exception("could not write strategy state for %s %s", *key)
        self._last_flush = now

    # -- reporting ---------------------------------------------------------

    async def _skipped(
        self, strategy: str, subscription: Subscription, tranche: int, because: str
    ) -> None:
        key = f"tranche-skipped:{strategy}:{tranche}:{subscription.trading_client.value}"
        await self.alerts.warning(
            EntityType.STRATEGY,
            strategy,
            "tranche-skipped",
            f"{strategy} tranche {tranche} did not enter for "
            f"{subscription.trading_client.value}: {because}",
            key=key,
        )

    async def _failed(
        self, strategy: str, subscription: Subscription, tranche: int, error: Exception
    ) -> None:
        logger.exception("%s tranche %d could not be evaluated", strategy, tranche)
        await self.alerts.critical(
            EntityType.STRATEGY,
            strategy,
            "strategy-evaluation",
            f"{strategy} tranche {tranche} could not be evaluated for "
            f"{subscription.trading_client.value} ({type(error).__name__}: {error}). It did "
            "not enter; positions already on are still managed.",
            key=f"strategy-evaluation:{strategy}:{tranche}",
        )

    # -- housekeeping ------------------------------------------------------

    async def _watch(self) -> None:
        """Keep the feed quoting what the strategies need. Never raises."""
        if self.watchlist is None:
            return
        held = {
            trade.instrument
            for client in self.engine.parts.clients.values()
            for trade in client.book.live_trades()
        }
        try:
            await self.watchlist.ensure(
                self.loaded.underlyings(),
                self.market.registry(),
                self.trading_day,
                held=held,
            )
        except Exception:
            logger.exception("could not update what the feed is watching")

    def _refresh_series(self) -> None:
        """Rebuild the derived series when the symbols have been swapped.

        Cheap and idempotent: the version is an integer compare, and nothing
        is rebuilt while it is unchanged. Rebuilding rather than mutating
        because a synthetic is frozen and carries its own configuration -- a
        changed PCR width is a different object, not an edited one.

        A series switched **off** disappears from the sources here, which is
        what stops it being priced and stored. Its past stays in the table:
        turning a chart off is not a reason to delete a morning of it.
        """
        if self.symbols is None or self.synthetics is None:
            return
        if self.symbols.version == self._symbols_version:
            return

        configured = {
            InstrumentId(f"{info.exchange_code}:{canonical_symbol(info.symbol)}"): info
            for info in sorted(self.symbols.values(), key=lambda i: i.symbol)
            if info.derives_anything
        }
        self.synthetics.sources = for_symbols(configured)
        if self.derived is not None:
            self.derived.volatility = tuple(
                (underlying, source)
                for underlying, info in configured.items()
                for source in for_symbol(underlying, info)
                if isinstance(source, ImpliedVolatility)
            )
        self._symbols_version = self.symbols.version
        logger.info(
            "derived series rebuilt: %d source(s) across %d underlying(s)",
            len(self.synthetics.sources),
            len(configured),
        )

    async def _publish_synthetics(self, now: datetime) -> None:
        """Price the series nobody publishes, and put them on the hub.

        After the watchlist and before the sweep: a synthetic is computed from
        the chain the watchlist just subscribed to, and read by rules a moment
        later. Never raises — a chain that cannot be priced is a quiet
        synthetic, not a stopped engine.
        """
        if self.synthetics is None:
            return
        try:
            view = ChainOnly(market=self.market, trading_day=self.trading_day)
            ticks = tuple(self.synthetics.ticks(view, now))
            if ticks:
                await self.engine.parts.hub.consume([TicksReceived(ticks)])
                await self.engine.parts.hub.dispatch_once()
            if self.derived is not None:
                # After the hub, never before it. Storing is bookkeeping and
                # the engine's own read of the series must not wait on a
                # database round trip.
                await self.derived.record(ticks, view, now)
        except Exception:
            logger.exception("could not publish the synthetic series")

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


#: Scheduling reads only the strategy's own configuration, which does not
#: vary by account; the terms are a placeholder the timing never consults.
_SCHEDULING_TERMS = SubscriptionTerms(trading_client_id=TradingClientId("schedule"))


async def deliver_for(engine: Engine, batch: SignalBatch) -> bool:
    """Hand a batch to the account it names, and say whether it landed."""
    delivery = await deliver(engine, batch)
    if not delivery.delivered and delivery.refusal is not None:
        logger.info("signals not delivered: %s", delivery.refusal)
    return delivery.delivered


__all__ = ["NOTHING_LOADED", "Evaluated", "StateStore", "StrategyLoop", "deliver_for"]
