"""Delivering a batch of signals to the account it names."""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from garuda.composition.engine import Engine
from garuda.composition.routing import deliver
from garuda.domain import Currency, Money, ProductType
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.trade import Relationships
from garuda.domain.trade_signal import SignalType, TradeSignal
from garuda.engine.signals import SignalBatch
from garuda.marketdata.registry import InstrumentRegistry

from .conftest import AMMA, APPA, NOW, EngineBuilder, account, session

CALL = InstrumentId("NFO:NIFTY26AUG25000CE")
PUT = InstrumentId("NFO:NIFTY26AUG25000PE")


def option(instrument_id: InstrumentId, nse: Exchange, option_type: OptionType) -> Instrument:
    return Instrument(
        id=instrument_id,
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol=instrument_id.value.split(":")[1],
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=InstrumentId("NSE:NIFTY"),
        expiry=date(2026, 8, 27),
        strike=Decimal(25000),
        option_type=option_type,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


def signal(
    identity: str,
    *,
    instrument: InstrumentId = CALL,
    client: object = APPA,
    combo: str | None = None,
    role: LegRole = LegRole.MAIN,
    quantity: int = 150,
    slice_ordinal: int = 1,
) -> TradeSignal:
    return TradeSignal(
        id=identity,
        trading_client=client,  # type: ignore[arg-type]
        instrument=instrument,
        strategy="short-strangle",
        signal_type=SignalType.SHORT_ENTRY,
        product=ProductType.NRML,
        quantity=quantity,
        generated_at=NOW,
        quantity_per_lot=75,
        slice=slice_ordinal,
        relationships=Relationships(combo_id=combo, leg_role=role),
        combo_leg_count=2 if combo else 0,
    )


def batch(*signals: TradeSignal, legs: int = 1) -> SignalBatch:
    """A batch as the factory would have produced it."""
    from garuda.capital.sizing import Sizing

    nothing = Sizing(
        lots=2, quantity=150, slices=(150,), notional=Money.of(Decimal(1), Currency.INR)
    )
    return SignalBatch(signals=signals, sizings=tuple(nothing for _ in range(legs)))


@pytest.fixture
def engine(build_with: EngineBuilder, nse: Exchange) -> Engine:
    built = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )
    # The books resolve instruments through the broker's registry, so the day's
    # master is published the way the loader would publish it.
    built.parts.instruments.publish(
        "zerodha",
        InstrumentRegistry.build(
            [option(CALL, nse, OptionType.CALL), option(PUT, nse, OptionType.PUT)]
        ),
    )
    return built


async def test_a_signal_reaches_the_account_it_names(engine: Engine) -> None:
    delivery = await deliver(engine, batch(signal("s1")))

    assert delivery.delivered
    assert engine.parts.clients[APPA].book.signal("s1") is not None
    assert list(engine.parts.clients[AMMA].book.signals()) == []


async def test_a_batch_the_factory_refused_is_not_delivered(engine: Engine) -> None:
    delivery = await deliver(engine, SignalBatch(refusal="sized to nothing"))

    assert not delivery.delivered
    assert delivery.refusal == "sized to nothing"


async def test_an_empty_batch_delivers_nothing_and_says_nothing(engine: Engine) -> None:
    delivery = await deliver(engine, SignalBatch())

    assert delivery.accepted == ()
    assert delivery.refusal is None


async def test_signals_for_an_account_that_is_not_trading_are_discarded(
    build_with: EngineBuilder,
) -> None:
    """Better discarded loudly than held for an account that cannot place them."""
    built = build_with([account(APPA, "AB1234")], {APPA: session("AB1234")})

    delivery = await deliver(built, batch(signal("s1", client=AMMA)))

    assert not delivery.delivered
    assert delivery.refusal is not None
    assert delivery.refusal.startswith("amma cannot take signals")


async def test_an_account_that_cannot_trade_is_named_not_numbered(
    build_with: EngineBuilder,
) -> None:
    built = build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")], {APPA: session("AB1234")}
    )

    delivery = await deliver(built, batch(signal("s1", client=AMMA)))

    assert delivery.refusal is not None
    # Leads with the name. Reading "amma cannot take signals" and then having
    # to work out which account that is defeats the point of having labels.
    assert delivery.refusal.startswith("Amma (zerodha:CD5678) cannot take signals")


async def test_a_signal_the_account_already_has_is_reported_not_raised(
    engine: Engine,
) -> None:
    await deliver(engine, batch(signal("s1")))

    delivery = await deliver(engine, batch(signal("s1")))

    assert delivery.accepted == ()
    assert len(delivery.rejected) == 1


async def test_both_legs_of_a_combo_are_delivered(engine: Engine) -> None:
    delivery = await deliver(
        engine,
        batch(
            signal("s1", combo="c1"),
            signal("s2", instrument=PUT, combo="c1", role=LegRole.HEDGE),
            legs=2,
        ),
    )

    assert len(delivery.accepted) == 2


async def test_a_combo_whose_leg_is_already_held_is_withdrawn_whole(
    engine: Engine,
) -> None:
    """A hedge without its main is the orphan the square-off sweep cleans up."""
    await deliver(engine, batch(signal("s1", combo="c1")))

    delivery = await deliver(
        engine,
        batch(
            signal("s1", combo="c1"),
            signal("s2", instrument=PUT, combo="c1", role=LegRole.HEDGE),
            legs=2,
        ),
    )

    assert not delivery.delivered
    assert delivery.refusal is not None
    assert "partial combo" in delivery.refusal
    second_leg = engine.parts.clients[APPA].book.signal("s2")
    assert second_leg is not None
    assert second_leg.disabled


async def test_a_single_leg_already_held_is_not_a_withdrawn_combo(
    engine: Engine,
) -> None:
    """One signal re-emitted is the ordinary case, not something to unwind."""
    await deliver(engine, batch(signal("s1")))

    delivery = await deliver(engine, batch(signal("s1")))

    assert delivery.refusal is None
    assert len(delivery.rejected) == 1


async def test_one_slice_already_held_leaves_the_others_standing(engine: Engine) -> None:
    """Slices of one leg are independent trades, not a combo to unwind.

    A sliced entry re-emitted after the first slice landed should place the
    rest, not withdraw what already went on.
    """
    await deliver(engine, batch(signal("s1", quantity=1800, slice_ordinal=1)))

    delivery = await deliver(
        engine,
        batch(
            signal("s1", quantity=1800, slice_ordinal=1),
            signal("s2", quantity=900, slice_ordinal=2),
            legs=1,
        ),
    )

    assert delivery.refusal is None
    assert [s.id for s in delivery.accepted] == ["s2"]
    second = engine.parts.clients[APPA].book.signal("s2")
    assert second is not None
    assert not second.disabled
