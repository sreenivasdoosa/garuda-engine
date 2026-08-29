"""Turning intents into signals trade management can act on.

The seam where a strategy's decision acquires a size. Most of what matters is
what it refuses.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from garuda.capital import CapitalLotAllocator, FixedLotAllocator, Sizer
from garuda.domain import Currency, Direction, DomainError, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import Intent, IntentKind, LegRole
from garuda.domain.market import Tick
from garuda.domain.trade import Protection
from garuda.domain.trade_signal import EntryRules, SignalType
from garuda.engine.signals import SignalBatch, SignalFactory

NOW = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa")
OTHER = TradingClientId("amma")

SOLD_CALL = InstrumentId("NFO:NIFTY26AUG25000CE")
HEDGE_CALL = InstrumentId("NFO:NIFTY26AUG25500CE")
NIFTY = InstrumentId("NSE:NIFTY")

CORRELATION = "eval-2026-08-31-000042"


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def option(
    instrument_id: InstrumentId,
    nse: Exchange,
    strike: str,
    *,
    lot_size: int = 75,
    freeze: int | None = None,
) -> Instrument:
    return Instrument(
        id=instrument_id,
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol=instrument_id.value.split(":")[1],
        lot_size=lot_size,
        tick_size=Decimal("0.05"),
        freeze_quantity=freeze,
        underlying=NIFTY,
        expiry=date(2026, 8, 27),
        strike=Decimal(strike),
        option_type=OptionType.CALL,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


def intent(
    instrument: InstrumentId = SOLD_CALL,
    *,
    role: LegRole = LegRole.MAIN,
    direction: Direction = Direction.SHORT,
    ratio: tuple[int, int] = (1, 1),
    client: TradingClientId = CLIENT,
    correlation: str = CORRELATION,
    kind: IntentKind = IntentKind.ENTER,
    reason: str | None = None,
    limit: Money | None = None,
) -> Intent:
    return Intent(
        kind=kind,
        strategy="short-strangle",
        trading_client=client,
        instrument=instrument,
        direction=direction,
        product=ProductType.NRML,
        correlation_id=correlation,
        role=role,
        ratio_numerator=ratio[0],
        ratio_denominator=ratio[1],
        reason=reason,
        order_type=OrderType.LIMIT if limit is not None else OrderType.MARKET,
        limit_price=limit,
    )


@pytest.fixture
def catalogue(nse: Exchange) -> dict[InstrumentId, Instrument]:
    return {
        SOLD_CALL: option(SOLD_CALL, nse, "25000"),
        HEDGE_CALL: option(HEDGE_CALL, nse, "25500"),
    }


@pytest.fixture
def prices() -> dict[InstrumentId, Tick]:
    return {
        SOLD_CALL: Tick(instrument=SOLD_CALL, last_price=rupees("120"), timestamp=NOW),
        HEDGE_CALL: Tick(instrument=HEDGE_CALL, last_price=rupees("30"), timestamp=NOW),
    }


@pytest.fixture
def factory(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> SignalFactory:
    return SignalFactory(Sizer(FixedLotAllocator(2)), catalogue.get, prices.get)


def build(factory: SignalFactory, *intents: Intent, capital: str = "500000") -> SignalBatch:
    return factory.build(list(intents), capital=rupees(capital), now=NOW)


# -- the ordinary case ------------------------------------------------------


def test_a_single_intent_becomes_one_signal(factory: SignalFactory) -> None:
    batch = build(factory, intent())

    assert batch.accepted
    assert len(batch.signals) == 1
    assert batch.signals[0].instrument == SOLD_CALL


def test_the_signal_carries_the_size_the_sizer_decided(factory: SignalFactory) -> None:
    batch = build(factory, intent())

    assert batch.signals[0].quantity == 150  # two lots of seventy-five
    assert batch.signals[0].quantity_per_lot == 75


def test_a_short_intent_becomes_a_short_entry(factory: SignalFactory) -> None:
    batch = build(factory, intent(direction=Direction.SHORT))

    assert batch.signals[0].signal_type is SignalType.SHORT_ENTRY


def test_a_long_intent_becomes_a_long_entry(factory: SignalFactory) -> None:
    batch = build(factory, intent(direction=Direction.LONG))

    assert batch.signals[0].signal_type is SignalType.LONG_ENTRY


def test_the_expiry_is_carried_because_a_symbol_cannot_recover_it(
    factory: SignalFactory,
) -> None:
    batch = build(factory, intent())

    assert batch.signals[0].expiry == "2026-08-27"


def test_the_strategy_s_own_words_reach_the_signal(factory: SignalFactory) -> None:
    batch = build(factory, intent(reason="IV above the band"))

    assert batch.signals[0].remarks == "IV above the band"


def test_nothing_in_means_nothing_out(factory: SignalFactory) -> None:
    batch = factory.build([], capital=rupees("500000"), now=NOW)

    assert batch.signals == ()
    assert batch.refusal is None


# -- refusals ---------------------------------------------------------------


def test_a_leg_that_sizes_to_nothing_refuses_the_whole_entry(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    """A leg dropped for want of a lot makes a different position, not a smaller one."""
    factory = SignalFactory(Sizer(CapitalLotAllocator()), catalogue.get, prices.get)

    batch = factory.build(
        [intent(), intent(HEDGE_CALL, role=LegRole.HEDGE)],
        capital=rupees("100"),
        now=NOW,
    )

    assert not batch.accepted
    assert batch.signals == ()
    assert batch.refusal is not None
    assert "sized to nothing" in batch.refusal


def test_a_hedge_that_will_not_size_takes_the_main_leg_with_it(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    """A short option whose hedge was dropped is a different margin requirement."""
    factory = SignalFactory(Sizer(FixedLotAllocator(1)), catalogue.get, prices.get)

    batch = factory.build(
        [intent(), intent(HEDGE_CALL, role=LegRole.HEDGE, ratio=(1, 2))],
        capital=rupees("500000"),
        now=NOW,
    )

    assert not batch.accepted
    assert batch.refusal is not None
    assert "HEDGE" in batch.refusal


def test_an_instrument_not_in_the_master_refuses_the_entry(factory: SignalFactory) -> None:
    batch = build(factory, intent(InstrumentId("NFO:NOTLISTED")))

    assert not batch.accepted
    assert batch.refusal is not None
    assert "instrument master" in batch.refusal


def test_a_leg_with_no_price_cannot_be_sized(
    catalogue: dict[InstrumentId, Instrument],
) -> None:
    factory = SignalFactory(Sizer(FixedLotAllocator(2)), catalogue.get, lambda i: None)

    batch = build(factory, intent())

    assert not batch.accepted
    assert batch.refusal is not None
    assert "no price" in batch.refusal


def test_the_sizings_survive_a_refusal(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    """ "Why did nothing trade" is the question an operator actually asks."""
    factory = SignalFactory(Sizer(FixedLotAllocator(1)), catalogue.get, prices.get)

    batch = factory.build(
        [intent(), intent(HEDGE_CALL, role=LegRole.HEDGE, ratio=(1, 2))],
        capital=rupees("500000"),
        now=NOW,
    )

    assert batch.sizings[0].lots == 1


# -- batches that are not one position --------------------------------------


def test_an_exit_does_not_travel_as_a_signal(factory: SignalFactory) -> None:
    """An exit matched back to a position by symbol exits the wrong one."""
    with pytest.raises(DomainError, match="names a trade by id"):
        build(factory, intent(kind=IntentKind.EXIT))


def test_legs_for_two_accounts_are_not_one_position(factory: SignalFactory) -> None:
    with pytest.raises(DomainError, match="not one position"):
        build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE, client=OTHER))


def test_legs_from_two_evaluations_would_not_be_linked(factory: SignalFactory) -> None:
    with pytest.raises(DomainError, match="correlation ids"):
        build(
            factory,
            intent(),
            intent(HEDGE_CALL, role=LegRole.HEDGE, correlation="a-different-one"),
        )


# -- combos -----------------------------------------------------------------


def test_the_legs_of_a_combo_share_a_combo_id(factory: SignalFactory) -> None:
    batch = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))

    combo_ids = {s.relationships.combo_id for s in batch.signals}
    assert combo_ids == {CORRELATION}


def test_a_single_leg_is_not_a_combo(factory: SignalFactory) -> None:
    batch = build(factory, intent())

    assert batch.signals[0].relationships.combo_id is None
    assert batch.signals[0].combo_leg_count == 0


def test_a_combo_says_how_many_legs_it_actually_emitted(factory: SignalFactory) -> None:
    batch = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))

    assert {s.combo_leg_count for s in batch.signals} == {2}


def test_the_hedge_knows_it_is_one(factory: SignalFactory) -> None:
    batch = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))

    hedge = next(s for s in batch.signals if s.instrument == HEDGE_CALL)
    main = next(s for s in batch.signals if s.instrument == SOLD_CALL)
    assert hedge.relationships.is_hedge
    assert hedge.relationships.hedge_correlation_id == CORRELATION
    assert main.relationships.hedge_correlation_id is None


def test_entry_order_survives_as_a_sequence(factory: SignalFactory) -> None:
    """Nothing downstream can recover the evaluator's ordering once flattened."""
    batch = build(factory, intent(HEDGE_CALL, role=LegRole.HEDGE), intent())

    by_instrument = {s.instrument: s.relationships.entry_sequence for s in batch.signals}
    assert by_instrument[HEDGE_CALL] == 0
    assert by_instrument[SOLD_CALL] == 1


def test_a_hedge_is_sized_against_the_main_leg(factory: SignalFactory) -> None:
    batch = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE, ratio=(1, 2)))

    hedge = next(s for s in batch.signals if s.instrument == HEDGE_CALL)
    main = next(s for s in batch.signals if s.instrument == SOLD_CALL)
    assert main.quantity == 150
    assert hedge.quantity == 75


# -- slicing ----------------------------------------------------------------


def test_a_position_over_the_freeze_limit_becomes_several_signals(
    nse: Exchange, prices: dict[InstrumentId, Tick]
) -> None:
    """One signal becomes one order, so the split has to happen here."""
    catalogue = {SOLD_CALL: option(SOLD_CALL, nse, "25000", freeze=1800)}
    factory = SignalFactory(Sizer(FixedLotAllocator(50)), catalogue.get, prices.get)

    batch = factory.build([intent()], capital=rupees("5000000"), now=NOW)

    assert [s.quantity for s in batch.signals] == [1800, 1800, 150]
    assert sum(s.quantity for s in batch.signals) == 3750


def test_each_slice_is_numbered_so_they_are_not_duplicates_of_each_other(
    nse: Exchange, prices: dict[InstrumentId, Tick]
) -> None:
    """Two equal slices differ only in their ordinal, and dedup keys on it."""
    catalogue = {SOLD_CALL: option(SOLD_CALL, nse, "25000", freeze=1800)}
    factory = SignalFactory(Sizer(FixedLotAllocator(48)), catalogue.get, prices.get)

    batch = factory.build([intent()], capital=rupees("5000000"), now=NOW)

    assert [s.quantity for s in batch.signals] == [1800, 1800]
    assert [s.slice for s in batch.signals] == [1, 2]
    assert len({s.id for s in batch.signals}) == 2


def test_slicing_does_not_multiply_the_leg_count(
    nse: Exchange, prices: dict[InstrumentId, Tick]
) -> None:
    """A sliced leg is still one leg, and a coordinator waiting on legs must
    not wait for slices that are not separate legs."""
    catalogue = {
        SOLD_CALL: option(SOLD_CALL, nse, "25000", freeze=1800),
        HEDGE_CALL: option(HEDGE_CALL, nse, "25500"),
    }
    factory = SignalFactory(Sizer(FixedLotAllocator(48)), catalogue.get, prices.get)

    batch = factory.build(
        [intent(), intent(HEDGE_CALL, role=LegRole.HEDGE)],
        capital=rupees("5000000"),
        now=NOW,
    )

    assert len(batch.signals) == 3
    assert batch.leg_count == 2
    assert {s.combo_leg_count for s in batch.signals} == {2}


# -- ids --------------------------------------------------------------------


def test_the_same_evaluation_produces_the_same_ids(factory: SignalFactory) -> None:
    """A replay that renames everything proves nothing about duplicates."""
    first = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))
    second = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))

    assert [s.id for s in first.signals] == [s.id for s in second.signals]


def test_the_legs_of_one_combo_get_different_ids(factory: SignalFactory) -> None:
    batch = build(factory, intent(), intent(HEDGE_CALL, role=LegRole.HEDGE))

    assert len({s.id for s in batch.signals}) == 2


def test_an_id_fits_the_column_it_is_stored_in(factory: SignalFactory) -> None:
    long_correlation = "x" * 200
    batch = build(
        factory,
        intent(correlation=long_correlation),
        intent(HEDGE_CALL, role=LegRole.HEDGE, correlation=long_correlation),
    )

    assert all(len(s.id) <= 50 for s in batch.signals)
    assert len({s.id for s in batch.signals}) == 2


# -- policies ---------------------------------------------------------------


def test_without_a_policy_a_signal_enters_at_market(factory: SignalFactory) -> None:
    batch = build(factory, intent())

    assert batch.signals[0].entry.place_market_order


def test_a_limit_intent_enters_on_its_own_price_not_at_market(
    factory: SignalFactory,
) -> None:
    """A strategy that named a price meant it; sending market ignores the ask."""
    batch = build(factory, intent(limit=rupees("118")))

    assert batch.signals[0].entry.trigger == rupees("118")
    assert not batch.signals[0].entry.place_market_order


def test_a_protection_policy_decides_the_levels(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    def stop_at_double(placed: Intent, price: Money) -> Protection:
        return Protection(stop_loss=price * Decimal(2))

    factory = SignalFactory(
        Sizer(FixedLotAllocator(2)), catalogue.get, prices.get, protection=stop_at_double
    )

    batch = factory.build([intent()], capital=rupees("500000"), now=NOW)

    assert batch.signals[0].protection.stop_loss == rupees("240")


def test_an_entry_policy_decides_how_the_order_is_placed(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    def on_a_trigger(placed: Intent, price: Money) -> EntryRules:
        return EntryRules(trigger=price)

    factory = SignalFactory(
        Sizer(FixedLotAllocator(2)), catalogue.get, prices.get, entry=on_a_trigger
    )

    batch = factory.build([intent()], capital=rupees("500000"), now=NOW)

    assert batch.signals[0].entry.trigger == rupees("120")
    assert not batch.signals[0].entry.place_market_order


def test_the_policy_sees_the_price_the_leg_was_sized_at(
    catalogue: dict[InstrumentId, Instrument], prices: dict[InstrumentId, Tick]
) -> None:
    """A percentage stop means nothing without the price it is a percentage of."""
    seen: list[tuple[InstrumentId, Money]] = []

    def record(placed: Intent, price: Money) -> Protection:
        seen.append((placed.instrument, price))
        return Protection()

    factory = SignalFactory(
        Sizer(FixedLotAllocator(2)), catalogue.get, prices.get, protection=record
    )
    factory.build(
        [intent(), intent(HEDGE_CALL, role=LegRole.HEDGE)],
        capital=rupees("500000"),
        now=NOW,
    )

    assert seen == [(SOLD_CALL, rupees("120")), (HEDGE_CALL, rupees("30"))]
