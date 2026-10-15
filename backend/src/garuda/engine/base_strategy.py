"""The strategy pipeline: one fixed sequence of hooks.

`STRATEGY_ENGINE.md` §4. The reference's F&O evaluator, as an order rather
than a class hierarchy. Every hook's default does what the configuration
says; a custom strategy (§7) subclasses this and overrides the hooks it
needs, and the order, the state, the ids and everything downstream stay as
they are.

On a scheduled tranche:

1. ``gate``      -- status, day rules, window, not already signalled, entry rules;
2. ``direction`` -- BOTH for a non-directional strategy, else the provider;
3. ``legs``      -- the shape from trade mode and direction, strikes, hedges,
                    liquidity, every instrument resolved or the entry stands down;
4. ``lots``      -- capital to lots, the reference's arithmetic;
5. ``emit``      -- freeze slicing and one signal per leg per slice, with the
                    reference's group, pair, hedge and combo ids.

Pure: an :class:`Evaluation` in, an :class:`Outcome` out. Nothing here
delivers a signal, writes a row or reads a clock; the loop does those, so a
whole entry can be pinned by a test with a fake environment.
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field, replace
from datetime import date, datetime, time, timedelta, tzinfo
from decimal import Decimal
from fractions import Fraction
from typing import Any, Protocol

from garuda.capital.sizing import slice_for_freeze_limit
from garuda.domain.calendar import TradingCalendar
from garuda.domain.enums import Direction, ExpiryKind, OptionType, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.domain.strikes import Moneyness, atm_strike
from garuda.domain.trade import Relationships
from garuda.domain.trade_signal import EntryRules, EscalationMode, SignalType, TradeSignal
from garuda.engine.breakout import BreakoutSettings, Watch, WatchedLeg, watch_key
from garuda.engine.config import ResolvedConfig
from garuda.engine.daycondition import DayCondition
from garuda.engine.direction_providers import Answer, DirectionContext, Side, applicable
from garuda.engine.direction_providers import build as build_provider
from garuda.engine.exit_timing import ExitTiming, exit_at
from garuda.engine.hedging import hedge_strike
from garuda.engine.lots import (
    LotDecision,
    LotInputs,
    RiskDecision,
    allocated_lots,
    risk_aware_lots,
)
from garuda.engine.protection import protection_from
from garuda.engine.ranges import Band
from garuda.engine.ranges import resolve as resolve_range
from garuda.engine.runtime_config import Definition, RuntimeConfig
from garuda.engine.strategy_state import StrategyState
from garuda.engine.strike_selection import (
    DEFAULT_STRADDLE_MAX_DIFF,
    StrikeRequest,
    select_strikes,
)
from garuda.engine.vocabulary import (
    BreakoutDirection,
    BreakoutReversalMode,
    BreakoutSide,
    BreakoutTriggerMode,
    BreakoutWatchType,
    ExpiryType,
    OrderFillEscalationMode,
    StrategyProduct,
    StrategyStatus,
    StrikeType,
    TradeMode,
    UnderlyingType,
)

logger = logging.getLogger(__name__)

#: The reference's `TRADE_SIGNAL_VALIDITY_MINUTES`: a signal nobody acted on
#: in ten minutes is stale.
SIGNAL_VALIDITY = timedelta(minutes=10)
#: The reference's `DEFAULT_ORDER_FILL_ESCALATION_SECONDS`.
DEFAULT_ESCALATION_SECONDS = 5
#: The stored signal id column is 50 characters.
SIGNAL_ID_LENGTH = 50


class StrategyEnvironment(DirectionContext, Protocol):
    """What one evaluation reads about the world, all from one instant."""

    @property
    def now(self) -> datetime: ...
    @property
    def trading_day(self) -> date: ...
    @property
    def conditions(self) -> frozenset[DayCondition]: ...
    @property
    def timezone(self) -> tzinfo: ...
    @property
    def calendar(self) -> TradingCalendar: ...
    @property
    def market_close(self) -> time: ...

    def spot(self, underlying: InstrumentId) -> Money | None: ...
    def future_price(self, underlying: InstrumentId) -> Money | None: ...
    def strike_gap(self, underlying: InstrumentId) -> Decimal | None: ...
    def hedge_rounding(self, underlying: InstrumentId) -> Decimal | None: ...
    def option_expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None: ...
    def is_monthly_expiry_week(self, underlying: InstrumentId) -> bool: ...
    def option(
        self, underlying: InstrumentId, expiry: date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None: ...
    def strikes(self, underlying: InstrumentId, expiry: date) -> list[Decimal]: ...
    def instrument(self, instrument: InstrumentId) -> Instrument | None: ...
    def quote(self, instrument: InstrumentId) -> Tick | None: ...
    def candles(
        self, instrument: InstrumentId, interval: BarInterval, count: int
    ) -> Sequence[Bar]: ...
    def straddle_max_diff(self, underlying: InstrumentId) -> Decimal | None: ...
    def near_future(self, underlying: InstrumentId) -> InstrumentId | None: ...
    def option_chain_levels(self, underlying: InstrumentId) -> int: ...
    def day_allocation_percent(self, strategy: str) -> int: ...
    def event_day_percent(self, strategy: str, exchange: str) -> int: ...

    @property
    def memory(self) -> Mapping[str, Any]: ...


@dataclass(frozen=True)
class Evaluation:
    """Everything one evaluation of one tranche reads."""

    runtime: RuntimeConfig
    state: StrategyState
    env: StrategyEnvironment
    tranche: int
    #: Why the entry rule tree blocks this tranche, or None when it passes.
    #: Supplied by the loop, which owns the rule context; None for a
    #: strategy without `use_indicator_entry`.
    entry_gate: Callable[[ResolvedConfig], str | None] | None = None

    @property
    def definition(self) -> Definition:
        return self.runtime.definition

    @property
    def config(self) -> ResolvedConfig:
        return self.runtime.tranche(self.tranche)

    @property
    def underlying(self) -> InstrumentId:
        definition = self.runtime.definition
        return InstrumentId(f"{definition.exchange}:{definition.underlying_symbol}")


@dataclass(frozen=True, slots=True)
class PlannedLeg:
    """One leg of an entry, resolved to a listed instrument."""

    instrument: InstrumentId
    direction: Direction
    role: LegRole
    #: Which main leg a hedge protects: the hedge correlation id is shared
    #: within a group. "CE" and "PE" for a pair, "LEG" for a single leg.
    group: str
    sequence: int
    option_type: OptionType | None = None
    strike: Decimal | None = None
    ratio: Fraction = Fraction(1)
    #: A leg's own product, where it differs from the strategy's: the cash
    #: leg of a cash-and-carry is delivery while the future is not.
    product: ProductType | None = None
    remarks: str | None = None


@dataclass(frozen=True, slots=True)
class _ComboLeg:
    role: LegRole
    instrument: str
    direction: Direction
    product: StrategyProduct | None
    ratio: Fraction
    sequence: int | None


def parse_combo(strategy: str, spec: Mapping[str, Any]) -> tuple[_ComboLeg, ...]:
    """The reference's ComboSpec: ``legs`` of role, instrument, direction,
    product, quantityRatio, entrySequence. Refused whole if any leg is
    unreadable, with more than one option leg, or with an option leg and
    nothing to price it against -- the reference shape cannot price either."""
    declared = spec.get("legs")
    if not isinstance(declared, list) or not declared:
        raise DomainError(f"{strategy}: the combo declares no legs")
    legs = tuple(_combo_leg(strategy, index, entry) for index, entry in enumerate(declared))
    options = sum(1 for leg in legs if leg.instrument == "OPTION")
    if options > 1:
        raise DomainError(f"{strategy}: a combo may have one option leg")
    if options and options == len(legs):
        raise DomainError(f"{strategy}: an option leg needs a partner leg to price against")
    return legs


def _combo_leg(strategy: str, index: int, entry: object) -> _ComboLeg:
    if not isinstance(entry, Mapping):
        raise DomainError(f"{strategy}: combo leg {index} is not an object")
    try:
        role_text = str(entry.get("role") or "PRIMARY").strip().upper()
        role = LegRole.HEDGE if role_text == "HEDGE" else LegRole.MAIN
        instrument = str(entry.get("instrument") or "").strip().upper()
        if instrument not in ("OPTION", "FUTURE", "EQUITY"):
            raise ValueError(f"instrument {instrument!r} is not OPTION, FUTURE or EQUITY")
        direction = Direction(str(entry.get("direction") or "").strip().upper())
        product_text = str(entry.get("product") or "").strip()
        ratio_text = entry.get("quantityRatio")
        sequence = entry.get("entrySequence")
        ratio = Fraction(str(ratio_text)) if ratio_text not in (None, "") else Fraction(1)
        if ratio <= 0:
            raise ValueError(f"quantityRatio {ratio_text} is not positive")
        return _ComboLeg(
            role=role,
            instrument=instrument,
            direction=direction,
            product=StrategyProduct.parse(product_text) if product_text else None,
            ratio=ratio,
            sequence=int(str(sequence)) if sequence not in (None, "") else None,
        )
    except (ValueError, DomainError) as error:
        raise DomainError(f"{strategy}: combo leg {index}: {error}") from None


@dataclass(frozen=True, slots=True)
class LegPlan:
    legs: tuple[PlannedLeg, ...]
    hedged: bool
    expiry: date | None
    because: str
    #: For WING_WIDTH_MAX_LOSS: the widest wing in points and the net premium
    #: collected, which bound the loss a lot can take.
    wing_width: Decimal | None = None
    net_premium: Decimal | None = None

    @property
    def mains(self) -> tuple[PlannedLeg, ...]:
        return tuple(leg for leg in self.legs if leg.role is not LegRole.HEDGE)


@dataclass(frozen=True)
class Outcome:
    """What one evaluation decided."""

    state: StrategyState
    signals: tuple[TradeSignal, ...] = ()
    #: Why nothing was entered. None when signals were produced.
    stood_down: str | None = None
    #: Whether the stand-down is something an operator should hear about,
    #: rather than an ordinary "not today".
    alert: bool = False
    lots: int = 0
    legs: int = 0
    notes: tuple[str, ...] = field(default_factory=tuple)
    #: Breakout watches armed instead of entering.
    watches: tuple[Watch, ...] = ()
    #: When to evaluate this tranche again, for a breakout range still open.
    retry_at: datetime | None = None

    @property
    def entered(self) -> bool:
        return bool(self.signals)

    @property
    def armed(self) -> bool:
        return bool(self.watches)


class StandDown(Exception):  # noqa: N818 -- a decision, not an error
    """A hook declining to go on. Raised inside the pipeline only."""

    def __init__(self, because: str, *, alert: bool = False) -> None:
        super().__init__(because)
        self.because = because
        self.alert = alert


class BaseStrategy:
    """The configured pipeline. Subclass and override a hook to customise."""

    #: The name a custom subclass registers under. None for the base.
    name: str | None = None

    # -- the order ---------------------------------------------------------

    def on_scheduled(self, ev: Evaluation) -> Outcome:
        state = ev.state.evaluated(ev.env.now)
        ev = replace(ev, state=state)
        notes: list[str] = []
        try:
            self.gate(ev)
            if ev.config.flag("breakout_enabled"):
                return self.arm(ev, state, notes)
            side = self.direction(ev)
            notes.append(f"direction {side.value}")
            plan = self.legs(ev, side)
            notes.append(plan.because)
            decision = self.lots(ev, plan)
            notes.append(decision.because)
            if not decision.tradable:
                raise StandDown(f"zero lots: {decision.because}", alert=True)
            signals = self.emit(ev, plan, decision.lots)
        except StandDown as stand:
            return Outcome(
                state=state, stood_down=stand.because, alert=stand.alert, notes=tuple(notes)
            )
        after = state.tranche_signalled(
            ev.tranche,
            ev.env.now,
            signals=len(signals),
            lots=decision.lots,
            risk=decision.risk_used,
        )
        return Outcome(
            state=after,
            signals=signals,
            lots=decision.lots,
            legs=len(plan.legs),
            notes=tuple(notes),
        )

    # -- breakout ----------------------------------------------------------

    def arm(self, ev: Evaluation, state: StrategyState, notes: list[str]) -> Outcome:
        """Arm the tranche's breakout watches instead of entering."""
        env, definition, config = ev.env, ev.runtime.definition, ev.config
        try:
            settings = BreakoutSettings.of(config, dict(definition.direction_provider_params))
        except DomainError as error:
            raise StandDown(f"breakout: {error}", alert=True) from None
        pending = settings.pending_until()
        local = env.now.astimezone(env.timezone)
        if pending is not None and local.time() < pending:
            return Outcome(
                state=state,
                stood_down=f"breakout range open until {pending:%H:%M}",
                retry_at=datetime.combine(env.trading_day, pending, env.timezone),
                notes=tuple(notes),
            )
        valid_till = (
            datetime.combine(env.trading_day, definition.stop_time, env.timezone)
            if definition.stop_time is not None
            else None
        )
        group = f"Tranch-{ev.tranche}|Breakout"
        client = ev.runtime.subscription.trading_client_id
        paper = ev.runtime.subscription.is_paper_trading

        def make(suffix: str, **values: Any) -> Watch:
            return Watch(
                key=watch_key(client, definition.name, env.trading_day, ev.tranche, suffix),
                trading_client=client,
                strategy=definition.name,
                tranche=ev.tranche,
                kind=settings.kind,
                mode=settings.mode,
                valid_till=valid_till,
                group=group,
                is_paper=paper,
                **values,
            )

        watches: list[Watch] = []
        if settings.kind is BreakoutWatchType.UNDERLYING:
            price = self.reference_price(ev).amount
            if settings.mode is BreakoutTriggerMode.RANGE:
                band = self.band(ev, settings, ev.underlying)
                watches.append(
                    make(
                        "HIGH",
                        watched=ev.underlying,
                        direction=BreakoutDirection.ABOVE,
                        reference_price=price,
                        above=band.high,
                        below=None,
                    )
                )
                watches.append(
                    make(
                        "LOW",
                        watched=ev.underlying,
                        direction=BreakoutDirection.BELOW,
                        reference_price=price,
                        above=None,
                        below=band.low,
                    )
                )
            else:
                above, below = settings.levels(price)
                watches.append(
                    make(
                        "UNDERLYING",
                        watched=ev.underlying,
                        direction=settings.direction,
                        reference_price=price,
                        above=above,
                        below=below,
                    )
                )
            notes.append(f"armed {len(watches)} underlying watch(es)")
        else:
            side = self.direction(ev)
            plan = self.legs(ev, side)
            for main in plan.mains:
                tick = env.quote(main.instrument)
                if tick is None or tick.last_price.amount <= 0:
                    raise StandDown(f"no premium for {main.instrument.value} to watch", alert=True)
                premium = tick.last_price.amount
                legs = tuple(
                    WatchedLeg(
                        instrument=leg.instrument,
                        direction=leg.direction,
                        hedge=leg.role is LegRole.HEDGE,
                        option_type=leg.option_type,
                        strike=leg.strike,
                    )
                    for leg in plan.legs
                    if leg.group == main.group
                )
                if settings.mode is BreakoutTriggerMode.RANGE:
                    band = self.band(ev, settings, main.instrument)
                    above, below = band.high, band.low
                elif settings.mode is BreakoutTriggerMode.CANDLE_LOW:
                    lookback = config.whole("lookback_minutes") or 60
                    bars = env.candles(main.instrument, BarInterval.ONE_MINUTE, lookback)
                    if not bars:
                        raise StandDown(f"no one-minute history for {main.instrument.value}")
                    above, below = None, min(bar.low.amount for bar in bars)
                else:
                    above, below = settings.levels(premium)
                watches.append(
                    make(
                        main.group,
                        watched=main.instrument,
                        direction=settings.direction,
                        reference_price=premium,
                        above=above,
                        below=below,
                        legs=legs,
                    )
                )
            notes.append(f"armed {len(watches)} option watch(es)")
        return Outcome(state=state, watches=tuple(watches), notes=tuple(notes))

    def band(self, ev: Evaluation, settings: BreakoutSettings, instrument: InstrumentId) -> Band:
        assert settings.range_spec is not None
        env = ev.env
        band = resolve_range(
            settings.range_spec,
            now=env.now,
            timezone=env.timezone,
            today=env.trading_day,
            minute_bars=env.candles(instrument, BarInterval.ONE_MINUTE, 400),
            day_bars=env.candles(instrument, BarInterval.ONE_DAY, settings.range_spec.lookback + 2),
        )
        if isinstance(band, str):
            raise StandDown(f"breakout range: {band}", alert=True)
        return band

    def on_breakout(self, ev: Evaluation, watch: Watch, side: BreakoutSide) -> Outcome:
        """A watch was breached: enter as the reference's `onBreakoutEvent` does."""
        state = ev.state.evaluated(ev.env.now)
        ev = replace(ev, state=state)
        notes: list[str] = [f"breakout {side.value} on {watch.watched.value}"]
        try:
            if watch.kind is BreakoutWatchType.UNDERLYING:
                reversal = BreakoutSettings.of(
                    ev.config, dict(ev.runtime.definition.direction_provider_params)
                ).reversal
                self.gate(ev, signalled_ok=reversal is BreakoutReversalMode.PARALLEL)
                settings = BreakoutSettings.of(ev.config)
                trade = settings.on_high if side is BreakoutSide.LONG else settings.on_low
                plan = self.legs(ev, Side(trade.value))
            else:
                self.gate(ev, signalled_ok=True)
                plan = self.watched_plan(ev, watch)
            notes.append(plan.because)
            decision = self.lots(ev, plan)
            notes.append(decision.because)
            if not decision.tradable:
                raise StandDown(f"zero lots: {decision.because}", alert=True)
            signals = self.emit(ev, plan, decision.lots)
        except StandDown as stand:
            return Outcome(
                state=state, stood_down=stand.because, alert=stand.alert, notes=tuple(notes)
            )
        if state.has_signalled(ev.tranche):
            after = state.signalled_again(
                signals=len(signals), lots=decision.lots, risk=decision.risk_used, at=ev.env.now
            )
        else:
            after = state.tranche_signalled(
                ev.tranche,
                ev.env.now,
                signals=len(signals),
                lots=decision.lots,
                risk=decision.risk_used,
            )
        return Outcome(
            state=after,
            signals=signals,
            lots=decision.lots,
            legs=len(plan.legs),
            notes=tuple(notes),
        )

    def watched_plan(self, ev: Evaluation, watch: Watch) -> LegPlan:
        definition = ev.runtime.definition
        legs = tuple(
            PlannedLeg(
                instrument=leg.instrument,
                direction=leg.direction,
                role=LegRole.HEDGE if leg.hedge else LegRole.MAIN,
                group="LEG",
                sequence=_sequence(leg.direction, definition.entry_leg_order),
                option_type=leg.option_type,
                strike=leg.strike,
                remarks=f"breakout {'hedge' if leg.hedge else 'entry'} {leg.instrument.value}",
            )
            for leg in watch.legs
        )
        if not legs:
            raise StandDown("the watch carries no legs", alert=True)
        listed = ev.env.instrument(legs[0].instrument)
        return LegPlan(
            legs=legs,
            hedged=any(leg.role is LegRole.HEDGE for leg in legs),
            expiry=listed.expiry if listed is not None else None,
            because=f"watched legs {', '.join(leg.instrument.value for leg in legs)}",
        )

    # -- 1. gate -----------------------------------------------------------

    def gate(self, ev: Evaluation, *, signalled_ok: bool = False) -> None:
        """The reference's `canTradeToday`, `isWithinTradingWindow` and the
        tranche-signalled check, in that order."""
        definition = ev.runtime.definition
        env = ev.env
        if definition.status is not StrategyStatus.ACTIVE:
            raise StandDown(f"status is {definition.status.value}")
        if definition.exclude_monthly_expiry and env.is_monthly_expiry_week(ev.underlying):
            raise StandDown("monthly expiry week is excluded")
        if not definition.can_trade_on(env.conditions):
            raise StandDown(
                f"not a tradable day ({', '.join(sorted(c.value for c in env.conditions))})"
            )
        local = env.now.astimezone(env.timezone).time()
        if definition.start_time is not None and local < definition.start_time:
            raise StandDown(f"before the start time {definition.start_time:%H:%M}")
        cutoff = _clock(ev.config.text("tranch_cutoff_time")) or definition.stop_time
        if cutoff is not None and local > cutoff:
            raise StandDown(f"past the cutoff {cutoff:%H:%M}")
        if not signalled_ok and ev.state.has_signalled(ev.tranche):
            raise StandDown(f"tranche {ev.tranche} has already signalled today")
        if definition.use_indicator_entry and ev.entry_gate is not None:
            blocked = ev.entry_gate(ev.config)
            if blocked is not None:
                raise StandDown(f"entry rules: {blocked}")

    # -- 2. direction ------------------------------------------------------

    def direction(self, ev: Evaluation) -> Side:
        definition = ev.runtime.definition
        if not definition.is_directional:
            return Side.BOTH
        name = definition.direction_provider_type or ""
        params = definition.direction_provider_params
        answer: Answer = build_provider(name, params).decide(ev.env)
        side = applicable(answer.side, params, provider_name=name)
        if side is None:
            raise StandDown(f"no direction: {answer.because}")
        return side

    # -- 3. legs -----------------------------------------------------------

    def legs(self, ev: Evaluation, side: Side) -> LegPlan:
        definition = ev.runtime.definition
        mode = definition.trade_mode
        if definition.is_combo:
            return self.combo_legs(ev, side)
        if mode in (TradeMode.OPTION_SELLING, TradeMode.OPTION_BUYING):
            return self.option_legs(ev, side)
        if mode is TradeMode.FUTURES:
            return self.future_legs(ev, side)
        if mode is TradeMode.FUTURES_OPTIONS:
            raise StandDown("FUTURES_OPTIONS needs its legs declared as a combo", alert=True)
        raise StandDown(f"trade mode {mode.value} is not built yet", alert=True)

    def future_legs(self, ev: Evaluation, side: Side) -> LegPlan:
        """The near future, long unless a direction says short. The reference
        always goes long here and carries a TODO for short futures; a
        directional strategy follows its direction instead of ignoring it."""
        future = ev.env.near_future(ev.underlying)
        if future is None:
            raise StandDown(f"{ev.underlying.value} has no listed future", alert=True)
        direction = Direction.SHORT if side is Side.SHORT else Direction.LONG
        leg = PlannedLeg(
            instrument=future,
            direction=direction,
            role=LegRole.MAIN,
            group="LEG",
            sequence=1,
            remarks=f"{'Buy' if direction is Direction.LONG else 'Sell'} future",
        )
        instrument = ev.env.instrument(future)
        return LegPlan(
            legs=(leg,),
            hedged=False,
            expiry=instrument.expiry if instrument is not None else None,
            because=f"future {future.value}",
        )

    def combo_legs(self, ev: Evaluation, side: Side) -> LegPlan:
        """The reference's `decideComboEntry`: each declared leg resolved to
        the underlying's future, its cash instrument, or an option priced
        against its partner leg. One option leg at most, as the reference
        shape allows; every leg resolved or the entry stands down."""
        del side
        env, definition, config = ev.env, ev.runtime.definition, ev.config
        try:
            legs_in = parse_combo(definition.name, definition.combo_spec or {})
        except DomainError as error:
            raise StandDown(str(error), alert=True) from None
        options = [leg for leg in legs_in if leg.instrument == "OPTION"]

        future = (
            env.near_future(ev.underlying)
            if any(leg.instrument == "FUTURE" for leg in legs_in)
            else None
        )
        if any(leg.instrument == "FUTURE" for leg in legs_in) and future is None:
            raise StandDown(f"{ev.underlying.value} has no listed future", alert=True)
        cash = InstrumentId(f"{definition.exchange}:{definition.underlying_symbol}")
        if any(leg.instrument == "EQUITY" for leg in legs_in) and env.instrument(cash) is None:
            raise StandDown(f"{cash.value} is not in the instrument master", alert=True)

        option_id: InstrumentId | None = None
        option_type: OptionType | None = None
        option_strike: Decimal | None = None
        expiry: date | None = None
        if options:
            leg = options[0]
            partner = next((other for other in legs_in if other.instrument != "OPTION"), None)
            if partner is None:
                raise StandDown("an option leg needs a partner leg to price against", alert=True)
            price = self.reference_price(ev)
            gap = env.strike_gap(ev.underlying)
            if gap is None or gap <= 0:
                raise StandDown(f"{ev.underlying.value} has no strike gap configured", alert=True)
            atm = atm_strike(price, gap)
            if leg.role is LegRole.HEDGE:
                option_type = (
                    OptionType.CALL if partner.direction is Direction.SHORT else OptionType.PUT
                )
                distance = definition.hedge_distance_for(leg.product or definition.product)
                option_strike = hedge_strike(
                    atm,
                    distance,
                    option_type,
                    strike_gap=gap,
                    rounding_multiple=env.hedge_rounding(ev.underlying),
                    rounding_min_distance=config.number("hedge_strike_rounding_min_distance"),
                )
            else:
                covered = leg.direction is Direction.SHORT and partner.direction is Direction.LONG
                option_type = (
                    OptionType.CALL
                    if covered or leg.direction is Direction.LONG
                    else OptionType.PUT
                )
                steps = Moneyness.parse(config.text("strike_value") or "ATM").steps
                option_strike = (
                    atm + steps * gap if option_type is OptionType.CALL else atm - steps * gap
                )
            expiry = self.expiry(ev)
            option_id = env.option(ev.underlying, expiry, option_strike, option_type)
            if option_id is None:
                raise StandDown(
                    f"{ev.underlying.value} {expiry} {option_strike} {option_type} is not listed",
                    alert=True,
                )

        planned: list[PlannedLeg] = []
        for leg in legs_in:
            instrument = {"OPTION": option_id, "FUTURE": future, "EQUITY": cash}[leg.instrument]
            if instrument is None:  # pragma: no cover - guarded above
                raise StandDown(f"combo leg {leg.instrument} could not be resolved", alert=True)
            planned.append(
                PlannedLeg(
                    instrument=instrument,
                    direction=leg.direction,
                    role=leg.role,
                    group="COMBO",
                    sequence=(
                        leg.sequence
                        if leg.sequence is not None
                        else _sequence(leg.direction, definition.entry_leg_order)
                    ),
                    option_type=option_type if leg.instrument == "OPTION" else None,
                    strike=option_strike if leg.instrument == "OPTION" else None,
                    ratio=leg.ratio,
                    product=(
                        _product(
                            leg.product,
                            TradeMode.EQUITY if leg.instrument == "EQUITY" else TradeMode.FUTURES,
                        )
                        if leg.product is not None
                        else (
                            _product(definition.product, TradeMode.EQUITY)
                            if leg.instrument == "EQUITY"
                            else None
                        )
                    ),
                    remarks=f"combo {leg.role.value} {leg.direction.value} {instrument.value}",
                )
            )
        if expiry is None and future is not None:
            listed = env.instrument(future)
            expiry = listed.expiry if listed is not None else None
        planned.sort(key=lambda leg: leg.sequence)
        return LegPlan(
            legs=tuple(planned),
            hedged=any(leg.role is LegRole.HEDGE for leg in planned),
            expiry=expiry,
            because=f"combo of {len(planned)} legs",
        )

    def option_legs(self, ev: Evaluation, side: Side) -> LegPlan:
        """An option pair, or the one leg a directional answer picks, each
        with its hedge when the tranche hedges -- the reference's
        `decideOptionPairOrSingle`, `decideOptionPair` and `legsOf`."""
        env, definition, config = ev.env, ev.runtime.definition, ev.config
        underlying = ev.underlying
        price = self.reference_price(ev)
        gap = env.strike_gap(underlying)
        if gap is None or gap <= 0:
            raise StandDown(f"{underlying.value} has no strike gap configured", alert=True)
        expiry = self.expiry(ev)
        kind = StrikeType.parse(config.text("strike_type") or "MoneyNess", field="strikeType")
        selling = definition.trade_mode is TradeMode.OPTION_SELLING
        main = Direction.SHORT if selling else Direction.LONG
        hedge_direction = main.opposite
        if side is Side.BOTH:
            sides = [(OptionType.CALL, "CE"), (OptionType.PUT, "PE")]
        else:
            bullish = side is Side.LONG
            # Selling: bullish sells the put. Buying: bullish buys the call.
            chosen = (
                (OptionType.PUT if bullish else OptionType.CALL)
                if selling
                else (OptionType.CALL if bullish else OptionType.PUT)
            )
            sides = [(chosen, "LEG")]
        wanted_types = {option_type for option_type, _ in sides}
        try:
            pair = select_strikes(
                kind,
                StrikeRequest(
                    underlying=underlying,
                    expiry=expiry,
                    price=price,
                    gap=gap,
                    config=config,
                    chain=env,
                    direction=main,
                    need_call=OptionType.CALL in wanted_types,
                    need_put=OptionType.PUT in wanted_types,
                    levels=env.option_chain_levels(underlying),
                    use_premium_balancing=definition.use_premium_balancing,
                    straddle_max_diff=(
                        env.straddle_max_diff(underlying) or DEFAULT_STRADDLE_MAX_DIFF
                    ),
                    now=env.now,
                    expires_at=datetime.combine(expiry, env.market_close, env.timezone),
                ),
            )
        except DomainError as error:
            raise StandDown(str(error), alert=True) from None
        if isinstance(pair, str):
            raise StandDown(f"no strikes: {pair}", alert=True)
        wanted: list[tuple[OptionType, Decimal, str]] = []
        for option_type, group in sides:
            strike = pair.call if option_type is OptionType.CALL else pair.put
            if strike is None:
                raise StandDown(f"no {option_type.value} strike: {pair.because}", alert=True)
            wanted.append((option_type, strike, group))

        hedged = config.flag("hedging_enabled") and definition.hedge_distance_intraday > 0
        main_sequence = _sequence(main, definition.entry_leg_order)
        hedge_sequence = _sequence(hedge_direction, definition.entry_leg_order)
        legs: list[PlannedLeg] = []
        hedges: list[PlannedLeg] = []
        for option_type, strike, group in wanted:
            listed = env.option(underlying, expiry, strike, option_type)
            if listed is None:
                raise StandDown(
                    f"{underlying.value} {expiry} {strike} {option_type} is not listed", alert=True
                )
            legs.append(
                PlannedLeg(
                    instrument=listed,
                    direction=main,
                    role=LegRole.MAIN,
                    group=group,
                    sequence=main_sequence,
                    option_type=option_type,
                    strike=strike,
                    remarks=f"{'Sell' if selling else 'Buy'} {option_type.value} at {strike}",
                )
            )
            if hedged:
                at = hedge_strike(
                    strike,
                    definition.hedge_distance_intraday,
                    option_type,
                    strike_gap=gap,
                    rounding_multiple=env.hedge_rounding(underlying),
                    rounding_min_distance=config.number("hedge_strike_rounding_min_distance"),
                )
                protecting = env.option(underlying, expiry, at, option_type)
                if protecting is None:
                    raise StandDown(
                        f"hedge {underlying.value} {expiry} {at} {option_type} is not listed; "
                        "not entering without it",
                        alert=True,
                    )
                hedges.append(
                    PlannedLeg(
                        instrument=protecting,
                        direction=hedge_direction,
                        role=LegRole.HEDGE,
                        group=group,
                        sequence=hedge_sequence,
                        option_type=option_type,
                        strike=at,
                        remarks=(
                            f"hedge - {'Buy' if hedge_direction is Direction.LONG else 'Sell'} "
                            f"{option_type.value} at {at}"
                        ),
                    )
                )
        plan = LegPlan(
            legs=tuple(legs + hedges),
            hedged=hedged,
            expiry=expiry,
            because=f"strikes {pair.because}" + (" (hedged)" if hedged else ""),
        )
        if (
            config.text("risk_calculation_mode") == "WING_WIDTH_MAX_LOSS"
            and hedged
            and len(legs) == 2
        ):
            plan = self.wing(ev, plan, legs, hedges)
        self.check_liquidity(ev, plan)
        return plan

    def wing(
        self,
        ev: Evaluation,
        plan: LegPlan,
        mains: list[PlannedLeg],
        hedges: list[PlannedLeg],
    ) -> LegPlan:
        """The reference's WING_WIDTH_MAX_LOSS capture: the wider wing, and
        what the two sales collect net of the two hedges."""
        widths = []
        net = Decimal(0)
        for main, hedge in zip(mains, hedges, strict=True):
            if main.strike is None or hedge.strike is None:
                return plan
            widths.append(abs(hedge.strike - main.strike))
            sold, bought = ev.env.quote(main.instrument), ev.env.quote(hedge.instrument)
            if sold is None or bought is None:
                return plan
            net += sold.last_price.amount - bought.last_price.amount
        return replace(plan, wing_width=max(widths), net_premium=net)

    def reference_price(self, ev: Evaluation) -> Money:
        """Spot for an index, the near future for a future-based strategy --
        the reference's `getUnderlyingPrice`, including its fallback of the
        spot for a synthetic future."""
        definition = ev.runtime.definition
        if definition.underlying_type is UnderlyingType.FUTURE:
            price = ev.env.future_price(ev.underlying)
            what = "future"
        else:
            price = ev.env.spot(ev.underlying)
            what = "spot"
        if price is None or price.amount <= 0:
            raise StandDown(f"{ev.underlying.value} {what} price is not available", alert=True)
        return price

    def expiry(self, ev: Evaluation) -> date:
        definition = ev.runtime.definition
        kind = (
            ExpiryKind.MONTHLY
            if definition.expiry_type is ExpiryType.MONTHLY
            else ExpiryKind.WEEKLY
        )
        expiry = ev.env.option_expiry(ev.underlying, kind)
        if expiry is None and kind is ExpiryKind.WEEKLY:
            # An underlying with no weekly options trades its monthly, as the
            # symbol's own expiry rule says.
            expiry = ev.env.option_expiry(ev.underlying, ExpiryKind.MONTHLY)
        if expiry is None:
            raise StandDown(f"{ev.underlying.value} has no listed option expiry", alert=True)
        return expiry

    def check_liquidity(self, ev: Evaluation, plan: LegPlan) -> None:
        """The reference's volume and OI filters. A leg with no quote passes:
        the reference fails open here so a market-data hiccup never silently
        blocks a tranche, and the price check in ``emit`` stands the entry
        down anyway if there is truly nothing."""
        config = ev.config
        volume = config.whole("volume_filter") or 0
        oi = config.whole("oi_filter") or 0
        if volume <= 0 and oi <= 0:
            return
        for leg in plan.legs:
            hedge = leg.role is LegRole.HEDGE
            check_volume = volume > 0 and (not hedge or config.flag("apply_volume_filter_to_hedge"))
            check_oi = oi > 0 and (not hedge or config.flag("apply_oi_filter_to_hedge"))
            quote = ev.env.quote(leg.instrument)
            if quote is None:
                continue
            if check_volume and (quote.volume or 0) < volume:
                raise StandDown(
                    f"{leg.instrument.value} volume {quote.volume or 0} is below {volume}",
                    alert=True,
                )
            if check_oi and (quote.open_interest or 0) < oi:
                raise StandDown(
                    f"{leg.instrument.value} open interest {quote.open_interest or 0} "
                    f"is below {oi}",
                    alert=True,
                )

    # -- 4. lots -----------------------------------------------------------

    def lots(self, ev: Evaluation, plan: LegPlan) -> LotDecision:
        margin = self.margin_lots(ev, plan)
        risk = self.risk_lots(ev, plan, margin)
        if risk is None:
            return margin
        return LotDecision(risk.lots, f"{margin.because}; {risk.because}", risk_used=risk.risk_used)

    def risk_lots(self, ev: Evaluation, plan: LegPlan, margin: LotDecision) -> RiskDecision | None:
        """The reference's risk-aware layer, when a risk budget is set: the
        wing-width loss for a hedged pair asked to size that way, else the
        stop-loss distance on the entry premium."""
        runtime, definition, config = ev.runtime, ev.runtime.definition, ev.config
        budget = runtime.max_risk
        if budget is None or budget <= 0:
            return None
        mains = plan.mains
        reference = ev.env.instrument(mains[0].instrument) if mains else None
        if reference is None:
            return None
        per_unit_size = Decimal(reference.lot_size) * reference.multiplier
        total = len(runtime.allocation_tranches) or (runtime.base.whole("max_tranches") or 1)
        firing = ev.state.firing_index(ev.tranche)
        if plan.wing_width is not None and plan.net_premium is not None:
            per_lot = max(Decimal(0), plan.wing_width - plan.net_premium) * per_unit_size
            return risk_aware_lots(
                cap_lots=margin.lots,
                budget=budget,
                used=ev.state.used_risk,
                firing_index=firing,
                total_tranches=total,
                risk_per_lot=per_lot,
            )
        stop = config.percent("sl_percentage") or Decimal(0)
        if stop <= 0:
            stop = config.percent("combined_sl_percentage") or Decimal(0)
        quote = ev.env.quote(mains[0].instrument)
        if stop <= 0 or quote is None or quote.last_price.amount <= 0:
            return None
        premium = quote.last_price.amount
        legs = len(mains)
        if definition.trade_mode is TradeMode.OPTION_BUYING:
            per_lot_capital = definition.capital_per_lot_for(hedged=plan.hedged) or 0
            spendable = Decimal(margin.lots * per_lot_capital)
            cost = premium * per_unit_size * legs
            if spendable <= 0 or cost <= 0:
                return None
            cap = int(spendable // cost)
        else:
            whole = int(runtime.capital) if runtime.capital is not None else 0
            per_lot_capital = definition.capital_per_lot_for(hedged=plan.hedged) or 0
            total_lots = (
                whole // per_lot_capital if whole > 0 and per_lot_capital > 0 else margin.lots
            )
            cap = max(0, total_lots - ev.state.allocated_lots_today)
        return risk_aware_lots(
            cap_lots=cap,
            budget=budget,
            used=ev.state.used_risk,
            firing_index=firing,
            total_tranches=total,
            risk_per_lot=premium * stop / 100 * per_unit_size * legs,
        )

    def margin_lots(self, ev: Evaluation, plan: LegPlan) -> LotDecision:
        runtime, definition = ev.runtime, ev.runtime.definition
        order = runtime.allocation_tranches
        return allocated_lots(
            LotInputs(
                tranche=ev.tranche,
                allocation_tranches=order,
                base_lots=[_lots_of(runtime.tranche(n)) for n in order],
                configured_lots=_lots_of(ev.config),
                capital=int(runtime.capital) if runtime.capital is not None else None,
                capital_per_lot=definition.capital_per_lot_for(hedged=plan.hedged),
                day_percentage=ev.env.day_allocation_percent(definition.name),
                event_day_percentage=ev.env.event_day_percent(definition.name, definition.exchange),
                adaptive=definition.adaptive_tranches_enabled,
            )
        )

    # -- 5. emit -----------------------------------------------------------

    def emit(self, ev: Evaluation, plan: LegPlan, lots: int) -> tuple[TradeSignal, ...]:
        """Freeze slicing, then one signal per leg per slice -- the reference's
        `materializeLegs`. Every leg of a slice shares the slice's quantity
        (times its ratio), its pair and combo id; a main and its hedge share
        a hedge correlation id."""
        env, runtime, config = ev.env, ev.runtime, ev.config
        definition = runtime.definition
        mains = plan.mains
        if not mains:
            raise StandDown("no main leg to enter", alert=True)
        reference = env.instrument(mains[0].instrument)
        if reference is None:
            raise StandDown(
                f"{mains[0].instrument.value} is not in the instrument master", alert=True
            )

        resolved: dict[InstrumentId, tuple[Instrument, Money]] = {}
        for leg in plan.legs:
            instrument = env.instrument(leg.instrument)
            if instrument is None:
                raise StandDown(
                    f"{leg.instrument.value} is not in the instrument master", alert=True
                )
            quote = env.quote(leg.instrument)
            if quote is None or quote.last_price.amount <= 0:
                raise StandDown(
                    f"no price for {instrument.trading_symbol}; its stop cannot be placed",
                    alert=True,
                )
            resolved[leg.instrument] = (instrument, quote.last_price)

        quantity = lots * reference.lot_size
        slices = slice_for_freeze_limit(quantity, reference)
        product = _product(definition.product, definition.trade_mode)
        prefix = (
            ""
            if definition.product is StrategyProduct.INTRADAY
            else f"{env.trading_day.isoformat()}|"
        )
        entry_rules = self.entry_rules(ev)
        square_off_at = exit_at(
            ExitTiming(
                now=env.now,
                today=env.trading_day,
                timezone=env.timezone,
                calendar=env.calendar,
                market_close=env.market_close,
                intraday=definition.product is StrategyProduct.INTRADAY,
                expiry=plan.expiry,
                exit_mode=config.text("exit_mode"),
                exit_time=config.text("exit_time"),
                exit_days=config.whole("exit_days"),
            )
        )
        base = _correlation(ev)
        signals: list[TradeSignal] = []
        for number, slice_quantity in enumerate(slices, start=1):
            pair_id = f"{base}-S{number}"
            hedge_ids = (
                {leg.group: f"{base}-S{number}-{leg.group}" for leg in mains} if plan.hedged else {}
            )
            group = f"{prefix}Tranch-{ev.tranche}|Slice-{number}"
            emitted: list[TradeSignal] = []
            slice_lots = slice_quantity // reference.lot_size
            for index, leg in enumerate(plan.legs):
                instrument, price = resolved[leg.instrument]
                leg_quantity = int(Fraction(slice_lots) * leg.ratio) * instrument.lot_size
                if leg_quantity <= 0:
                    continue
                hedge_id = hedge_ids.get(leg.group)
                emitted.append(
                    TradeSignal(
                        id=_signal_id(
                            definition.name, env.trading_day, ev.tranche, base, number, index
                        ),
                        trading_client=runtime.subscription.trading_client_id,
                        instrument=leg.instrument,
                        strategy=definition.name,
                        signal_type=(
                            SignalType.LONG_ENTRY
                            if leg.direction is Direction.LONG
                            else SignalType.SHORT_ENTRY
                        ),
                        product=leg.product or product,
                        quantity=leg_quantity,
                        generated_at=env.now,
                        quantity_per_lot=instrument.lot_size,
                        contract_multiplier=instrument.multiplier,
                        entry=entry_rules,
                        protection=protection_from(
                            config, direction=leg.direction, instrument=instrument, entry=price
                        ),
                        relationships=Relationships(
                            combo_id=pair_id,
                            hedge_correlation_id=hedge_id,
                            pair_correlation_id=pair_id,
                            leg_role=leg.role,
                            entry_sequence=leg.sequence,
                            hedge_distance_percent=(
                                definition.hedge_distance_intraday if hedge_id else None
                            ),
                        ),
                        group=group,
                        tranche=ev.tranche,
                        slice=number,
                        is_paper=runtime.subscription.is_paper_trading,
                        square_off_at=square_off_at,
                        expiry=instrument.expiry.isoformat() if instrument.expiry else None,
                        remarks=leg.remarks,
                    )
                )
            signals.extend(replace(signal, combo_leg_count=len(emitted)) for signal in emitted)
        if not signals:
            raise StandDown("every leg sized to nothing", alert=True)
        return tuple(signals)

    def entry_rules(self, ev: Evaluation) -> EntryRules:
        """At market, valid ten minutes, cancelled unfilled at the stop time,
        escalated as configured -- the reference's `createBaseTradeSignal`."""
        env, definition, config = ev.env, ev.runtime.definition, ev.config
        mode_text = config.text("order_fill_escalation_mode")
        mode = (
            OrderFillEscalationMode.parse(mode_text, field="orderFillEscalationMode")
            if mode_text
            else OrderFillEscalationMode.MARKET
        )
        cancel_at = (
            datetime.combine(env.trading_day, definition.stop_time, env.timezone)
            if definition.stop_time is not None
            else None
        )
        return EntryRules(
            place_market_order=True,
            valid_till=env.now + SIGNAL_VALIDITY,
            cancel_unfilled_order_at=cancel_at,
            escalation_mode=EscalationMode(mode.value),
            escalation_seconds=config.whole("order_fill_escalation_seconds")
            or DEFAULT_ESCALATION_SECONDS,
            escalation_steps=config.text("order_fill_escalation_steps"),
        )


def _lots_of(config: ResolvedConfig) -> int:
    lots = config.whole("lots_per_tranch")
    return lots if lots is not None and lots > 0 else 1


def _sequence(direction: Direction, policy: str | None) -> int:
    """The reference's `entrySequenceOf`: the protective (long) leg goes on
    first unless the policy says exposure first."""
    protection_first = (policy or "PROTECTION_FIRST").strip().upper() != "EXPOSURE_FIRST"
    protective = direction is Direction.LONG
    return 1 if protective == protection_first else 2


def _product(product: StrategyProduct, mode: TradeMode) -> ProductType:
    if mode is TradeMode.EQUITY:
        return {
            StrategyProduct.INTRADAY: ProductType.MIS,
            StrategyProduct.CASHBUY: ProductType.CNC,
            StrategyProduct.MTF: ProductType.MTF,
            StrategyProduct.POSITIONAL: ProductType.CNC,
        }[product]
    return ProductType.MIS if product is StrategyProduct.INTRADAY else ProductType.NRML


def _clock(text: str | None) -> time | None:
    if not text:
        return None
    try:
        return time.fromisoformat(text.strip())
    except ValueError:
        raise DomainError(f"{text!r} is not a time of day (HH:MM)") from None


def _correlation(ev: Evaluation) -> str:
    """A derived, replayable id for this entry: the same evaluation always
    produces the same ids, and a second entry of the same tranche (a
    re-entry) a different one."""
    seed = "|".join(
        (
            ev.runtime.subscription.trading_client_id.value,
            ev.runtime.definition.name,
            ev.env.trading_day.isoformat(),
            str(ev.tranche),
            str(ev.state.signals_generated_today),
        )
    )
    return hashlib.sha1(seed.encode(), usedforsecurity=False).hexdigest()[:12]


def _signal_id(
    strategy: str, day: date, tranche: int, base: str, slice_number: int, leg: int
) -> str:
    suffix = f"-{day:%y%m%d}-T{tranche}-{base}-S{slice_number}L{leg}"
    room = SIGNAL_ID_LENGTH - len(suffix)
    return f"{strategy[: max(room, 0)]}{suffix}"
