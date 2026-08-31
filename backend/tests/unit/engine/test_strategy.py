"""One strategy's tranche, end to end.

Rules, then direction, then legs, then sizing, then delivery — and the tranche
lifecycle wrapped round it so an entry happens once. Everything below is
already tested on its own; these are about the order and the standing down.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.capital import FixedLotAllocator, Sizer
from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    ExerciseStyle,
    ExpiryKind,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.trade import Trade
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.rules.compose import AllOf
from garuda.engine.rules.outcome import RuleOutcome, failed, passed
from garuda.engine.rules.registry import Rule
from garuda.engine.selectors import OptionStrikeSelector
from garuda.engine.signals import SignalBatch, SignalFactory
from garuda.engine.spec import FixedDirection, LegSpec, SideRule, StrategySpec
from garuda.engine.strategy import StrategyRunner, StrategySubscription
from garuda.engine.strikes import Moneyness
from garuda.engine.tranches import TrancheLedger, TrancheState

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 8, 31, 13, 0, tzinfo=IST).astimezone(UTC)
TODAY = date(2026, 8, 31)
EXPIRY = date(2026, 9, 3)
CLIENT = TradingClientId("appa")
NIFTY = InstrumentId("NSE:NIFTY")


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


@dataclass
class World:
    """A context that is both what a rule sees and what a selector needs."""

    nse: Exchange
    now: datetime = NOW
    trading_day: date = TODAY
    timezone: ZoneInfo = IST
    strategy: str = "straddle"
    trading_client: TradingClientId = CLIENT
    tranche: int = 0
    config: ResolvedConfig = field(default_factory=lambda: ResolvedConfig(strategy="straddle"))
    underlying: InstrumentId = NIFTY
    trade: Trade | None = None
    spot_price: Money | None = None
    gap: Decimal | None = Decimal(50)
    listed: set[InstrumentId] = field(default_factory=set)
    premiums: dict[InstrumentId, str] = field(default_factory=dict)
    expiries: dict[ExpiryKind, date] = field(default_factory=lambda: {ExpiryKind.WEEKLY: EXPIRY})

    # -- what a rule sees
    def quote(self, instrument: InstrumentId) -> Tick | None:
        if instrument == NIFTY and self.spot_price is not None:
            return Tick(instrument=instrument, last_price=self.spot_price, timestamp=self.now)
        premium = self.premiums.get(instrument)
        if premium is None:
            return None
        return Tick(instrument=instrument, last_price=rupees(premium), timestamp=self.now)

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> list[Bar]:
        return []

    def indicator(
        self, name: str, instrument: InstrumentId, interval: BarInterval, **params: object
    ) -> Decimal | None:
        return None

    def positions(self) -> list[Trade]:
        return []

    # -- what a selector needs
    def spot(self, underlying: InstrumentId) -> Money | None:
        return self.spot_price

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        return self.gap

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        return self.expiries.get(kind)

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        letters = "CE" if option_type is OptionType.CALL else "PE"
        candidate = InstrumentId(f"NFO:N{int(strike)}{letters}")
        return candidate if candidate in self.listed else None

    def future(self, underlying: InstrumentId, expiry: date) -> InstrumentId | None:
        return None


@dataclass(frozen=True)
class Says:
    """A rule that answers however a test needs."""

    verdict: bool = True

    def evaluate(self, context: object) -> RuleOutcome:
        return passed("the condition holds") if self.verdict else failed("not yet")


@dataclass
class Doorman:
    """Accepts or refuses delivery, and remembers what it saw."""

    accept: bool = True
    batches: list[SignalBatch] = field(default_factory=list)

    async def __call__(self, batch: SignalBatch) -> bool:
        self.batches.append(batch)
        return self.accept


@pytest.fixture
def world(nse: Exchange) -> World:
    call = option(25000, OptionType.CALL, nse)
    put = option(25000, OptionType.PUT, nse)
    return World(
        nse=nse,
        spot_price=rupees("25010"),
        listed={call.id, put.id},
        premiums={call.id: "150", put.id: "120"},
    )


@pytest.fixture
def catalogue(nse: Exchange) -> dict[InstrumentId, Instrument]:
    return {
        option(strike, side, nse).id: option(strike, side, nse)
        for strike in (24900, 25000, 25100)
        for side in (OptionType.CALL, OptionType.PUT)
    }


def straddle() -> StrategySpec:
    """Two legs, both sold, differing only in side."""
    return StrategySpec(
        name="straddle",
        underlying=NIFTY,
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL),
                side=SideRule.ALWAYS_SHORT,
                product=ProductType.NRML,
                sequence=0,
            ),
            LegSpec(
                selector=OptionStrikeSelector(OptionType.PUT),
                side=SideRule.ALWAYS_SHORT,
                product=ProductType.NRML,
                sequence=1,
            ),
        ),
    )


def runner(
    catalogue: dict[InstrumentId, Instrument], world: World, doorman: Doorman
) -> StrategyRunner:
    factory = SignalFactory(Sizer(FixedLotAllocator(2)), catalogue.get, world.quote)
    return StrategyRunner(factory=factory, deliver=doorman, ledger=TrancheLedger(TODAY))


def subscribed(entry: Rule | None = None, **overrides: object) -> StrategySubscription:
    defaults: dict[str, object] = {
        "trading_client": CLIENT,
        "spec": straddle(),
        "capital": rupees("500000"),
        "entry_rules": entry or AllOf((Says(True),)),
    }
    return StrategySubscription(**{**defaults, **overrides})  # type: ignore[arg-type]


# -- the whole path ---------------------------------------------------------


async def test_a_passing_strategy_enters(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    result = await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert result.fired
    assert result.tranche.state is TrancheState.FIRED
    assert len(result.signals) == 2


async def test_both_legs_of_the_straddle_are_sold(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    signals = doorman.batches[0].signals
    assert {s.direction for s in signals} == {Direction.SHORT}
    assert {s.instrument.value for s in signals} == {"NFO:N25000CE", "NFO:N25000PE"}


async def test_the_legs_are_one_combo(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    combos = {s.relationships.combo_id for s in doorman.batches[0].signals}
    assert len(combos) == 1
    assert None not in combos


# -- standing down ----------------------------------------------------------


async def test_a_blocked_rule_set_enters_nothing(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    result = await runner(catalogue, world, doorman).evaluate(
        subscribed(AllOf((Says(False),))), 0, world
    )

    assert not result.fired
    assert doorman.batches == []
    assert result.tranche.state is TrancheState.WAITING


async def test_what_blocked_it_is_kept_on_the_tranche(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    result = await runner(catalogue, world, doorman).evaluate(
        subscribed(AllOf((Says(False),))), 0, world
    )

    assert result.tranche.blocked_by is not None
    assert "not yet" in result.tranche.blocked_by


async def test_a_leg_that_resolves_to_nothing_stands_the_whole_entry_down(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """A partial entry is worse than none, held at the first of three places."""
    doorman = Doorman()
    world.listed = {InstrumentId("NFO:N25000CE")}  # the put is not listed

    result = await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert not result.fired
    assert doorman.batches == []
    assert result.stood_down is not None
    assert "partial entry is worse" in result.stood_down


async def test_no_spot_price_resolves_no_legs(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    world.spot_price = None

    result = await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert not result.fired


async def test_a_leg_that_cannot_be_sized_refuses_the_batch(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """The second of the three places."""
    doorman = Doorman()
    factory = SignalFactory(Sizer(FixedLotAllocator(0)), catalogue.get, world.quote)
    subject = StrategyRunner(factory=factory, deliver=doorman, ledger=TrancheLedger(TODAY))

    result = await subject.evaluate(subscribed(), 0, world)

    assert not result.fired
    assert doorman.batches == []


async def test_a_strategy_with_no_direction_stands_aside(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    @dataclass(frozen=True)
    class Undecided:
        def resolve(self, context: object) -> Direction | None:
            return None

    doorman = Doorman()
    spec = StrategySpec(
        name="straddle",
        underlying=NIFTY,
        direction=Undecided(),
        legs=straddle().legs,
    )

    result = await runner(catalogue, world, doorman).evaluate(subscribed(spec=spec), 0, world)

    assert not result.fired
    assert result.stood_down is not None
    assert "no direction" in result.stood_down


# -- once, and only once ----------------------------------------------------


async def test_a_tranche_that_fired_does_not_fire_again(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """The rule set still passes on the next pass, and must not enter again."""
    doorman = Doorman()
    subject = runner(catalogue, world, doorman)
    subscription = subscribed()

    await subject.evaluate(subscription, 0, world)
    again = await subject.evaluate(subscription, 0, world)

    assert not again.fired
    assert len(doorman.batches) == 1


async def test_a_blocked_tranche_is_tried_again(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    subject = runner(catalogue, world, doorman)

    await subject.evaluate(subscribed(AllOf((Says(False),))), 0, world)
    later = await subject.evaluate(subscribed(), 0, world)

    assert later.fired


async def test_each_tranche_is_its_own_entry(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    subject = runner(catalogue, world, doorman)

    def for_tranche(number: int) -> World:
        world.tranche = number
        return world

    results = await subject.evaluate_all(subscribed(tranches=(0, 1, 2)), for_tranche)

    assert [result.fired for result in results] == [True, True, True]
    assert len(doorman.batches) == 3


async def test_a_tranche_past_its_cutoff_expires_rather_than_entering(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    result = await runner(catalogue, world, doorman).evaluate(
        subscribed(cutoff=NOW - timedelta(minutes=1)), 0, world
    )

    assert result.tranche.state is TrancheState.EXPIRED
    assert doorman.batches == []


async def test_signals_refused_at_the_door_leave_the_tranche_armed(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Marking it fired would hide that something is holding these signals
    while the day is still running."""
    doorman = Doorman(accept=False)

    result = await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert not result.fired
    assert result.tranche.state is TrancheState.ARMED


# -- correlation ------------------------------------------------------------


async def test_one_evaluation_is_one_correlation(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    ids = {s.id for s in doorman.batches[0].signals}
    assert len(ids) == 2


async def test_two_tranches_do_not_share_signal_ids(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Otherwise duplicate detection refuses the second tranche outright."""
    doorman = Doorman()
    subject = runner(catalogue, world, doorman)

    await subject.evaluate(subscribed(tranches=(0, 1)), 0, world)
    world.tranche = 1
    await subject.evaluate(subscribed(tranches=(0, 1)), 1, world)

    first = {s.id for s in doorman.batches[0].signals}
    second = {s.id for s in doorman.batches[1].signals}
    assert not (first & second)


async def test_a_signal_is_labelled_with_the_tranche_that_produced_it(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Duplicate detection keys on the label, and trade management records it."""
    doorman = Doorman()
    world.tranche = 2

    await runner(catalogue, world, doorman).evaluate(subscribed(tranches=(2,)), 2, world)

    assert {s.tranche for s in doorman.batches[0].signals} == {2}


async def test_a_context_built_for_another_tranche_is_refused(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Two sources for one number is two chances to disagree: the signals would
    carry one tranche and the entry be recorded against another."""
    doorman = Doorman()
    world.tranche = 0

    with pytest.raises(DomainError, match="context built for tranche"):
        await runner(catalogue, world, doorman).evaluate(subscribed(tranches=(1,)), 1, world)


# -- a strangle, to prove the shape generalises -----------------------------


async def test_a_strangle_is_the_same_runner_with_a_different_moneyness(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    two_out = Moneyness.parse("OTM+2")
    spec = StrategySpec(
        name="strangle",
        underlying=NIFTY,
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL, moneyness=two_out),
                side=SideRule.ALWAYS_SHORT,
                sequence=0,
            ),
            LegSpec(
                selector=OptionStrikeSelector(OptionType.PUT, moneyness=two_out),
                side=SideRule.ALWAYS_SHORT,
                sequence=1,
            ),
        ),
    )
    world.listed = {InstrumentId("NFO:N25100CE"), InstrumentId("NFO:N24900PE")}
    world.premiums = {
        InstrumentId("NFO:N25100CE"): "80",
        InstrumentId("NFO:N24900PE"): "70",
    }

    result = await runner(catalogue, world, doorman).evaluate(subscribed(spec=spec), 0, world)

    assert result.fired
    assert {s.instrument.value for s in doorman.batches[0].signals} == {
        "NFO:N25100CE",
        "NFO:N24900PE",
    }


async def test_a_hedged_leg_is_bought_while_the_main_is_sold(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """One spec, two side rules. No template and no mode."""
    doorman = Doorman()
    spec = StrategySpec(
        name="hedged",
        underlying=NIFTY,
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL, moneyness=Moneyness.parse("OTM+2")),
                side=SideRule.ALWAYS_LONG,
                role=LegRole.HEDGE,
                sequence=0,
            ),
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL),
                side=SideRule.ALWAYS_SHORT,
                role=LegRole.MAIN,
                sequence=1,
            ),
        ),
    )
    world.listed = {InstrumentId("NFO:N25000CE"), InstrumentId("NFO:N25100CE")}
    world.premiums = {
        InstrumentId("NFO:N25000CE"): "150",
        InstrumentId("NFO:N25100CE"): "60",
    }

    await runner(catalogue, world, doorman).evaluate(subscribed(spec=spec), 0, world)

    by_instrument = {s.instrument.value: s for s in doorman.batches[0].signals}
    assert by_instrument["NFO:N25000CE"].direction is Direction.SHORT
    assert by_instrument["NFO:N25100CE"].direction is Direction.LONG


async def test_the_hedge_goes_on_first(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Protection first on entry, so the main comes off first on exit."""
    doorman = Doorman()
    spec = StrategySpec(
        name="hedged",
        underlying=NIFTY,
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL, moneyness=Moneyness.parse("OTM+2")),
                side=SideRule.ALWAYS_LONG,
                role=LegRole.HEDGE,
                sequence=0,
            ),
            LegSpec(
                selector=OptionStrikeSelector(OptionType.CALL),
                side=SideRule.ALWAYS_SHORT,
                role=LegRole.MAIN,
                sequence=1,
            ),
        ),
    )
    world.listed = {InstrumentId("NFO:N25000CE"), InstrumentId("NFO:N25100CE")}
    world.premiums = {
        InstrumentId("NFO:N25000CE"): "150",
        InstrumentId("NFO:N25100CE"): "60",
    }

    await runner(catalogue, world, doorman).evaluate(subscribed(spec=spec), 0, world)

    sequences = {
        s.instrument.value: s.relationships.entry_sequence for s in doorman.batches[0].signals
    }
    assert sequences["NFO:N25100CE"] < sequences["NFO:N25000CE"]


# -- configuration reaches the trade ----------------------------------------


async def test_the_tranche_s_configured_stop_reaches_the_signal(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Without this the loop would place live trades with no stop-loss, which
    is the worst thing this engine could ship."""
    doorman = Doorman()
    world.config = resolve(
        "straddle",
        [ConfigLayer(values={"sl_percentage": Decimal(30), "target_percentage": Decimal(50)})],
    )

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    sold_call = next(s for s in doorman.batches[0].signals if s.instrument.value == "NFO:N25000CE")
    assert sold_call.protection.stop_loss == rupees("195")  # 150 sold, stopped 30% up
    assert sold_call.protection.target == rupees("75")


async def test_each_leg_is_protected_at_its_own_premium(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    world.config = resolve("straddle", [ConfigLayer(values={"sl_percentage": Decimal(20)})])

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    stops = {s.instrument.value: s.protection.stop_loss for s in doorman.batches[0].signals}
    assert stops["NFO:N25000CE"] == rupees("180")  # 150 + 20%
    assert stops["NFO:N25000PE"] == rupees("144")  # 120 + 20%


async def test_a_strategy_configured_without_a_stop_says_so(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    world.config = resolve("straddle", [ConfigLayer(values={"no_stop_loss": True})])

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert doorman.batches[0].signals[0].protection.no_stop_loss


async def test_configuration_that_says_nothing_leaves_a_signal_unprotected(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    """Not silently: `no_stop_loss` is False, so the difference between "none
    configured" and "deliberately none" survives to the trade."""
    doorman = Doorman()

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    protection = doorman.batches[0].signals[0].protection
    assert protection.stop_loss is None
    assert not protection.no_stop_loss


async def test_trailing_is_carried_from_the_tranche_s_configuration(
    catalogue: dict[InstrumentId, Instrument], world: World
) -> None:
    doorman = Doorman()
    world.config = resolve(
        "straddle",
        [ConfigLayer(values={"sl_percentage": Decimal(30), "trail_sl": True})],
    )

    await runner(catalogue, world, doorman).evaluate(subscribed(), 0, world)

    assert doorman.batches[0].signals[0].protection.is_trailing
