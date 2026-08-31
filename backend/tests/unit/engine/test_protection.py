"""Turning configured percentages into the levels a leg is protected by.

Which side a level sits on is the whole test suite. A stop on the wrong side
fills the instant it is sent, at a loss, and looks like a stop that worked.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest

from garuda.domain import Currency, Direction, DomainError, Money
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.trade import Protection
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.protection import protection_from

CALL = InstrumentId("NFO:TESTOPT")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@pytest.fixture
def option(nse: Exchange) -> Instrument:
    return Instrument(
        id=CALL,
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol="TESTOPT",
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=InstrumentId("NSE:TESTIDX"),
        expiry=date(2026, 9, 3),
        strike=Decimal(25000),
        option_type=OptionType.CALL,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


def configured(**values: object) -> ResolvedConfig:
    return resolve("straddle", [ConfigLayer(values=values)])


def levels(option: Instrument, direction: Direction, **values: object) -> Protection:
    return protection_from(
        configured(**values), direction=direction, instrument=option, entry=rupees("100")
    )


# -- which side ------------------------------------------------------------


def test_a_sold_option_is_stopped_above_the_entry(option: Instrument) -> None:
    """It loses when the premium rises."""
    protection = levels(option, Direction.SHORT, sl_percentage=Decimal(30))

    assert protection.stop_loss == rupees("130")


def test_a_sold_option_targets_below_the_entry(option: Instrument) -> None:
    protection = levels(option, Direction.SHORT, target_percentage=Decimal(60))

    assert protection.target == rupees("40")


def test_a_bought_option_is_stopped_below_the_entry(option: Instrument) -> None:
    protection = levels(option, Direction.LONG, sl_percentage=Decimal(30))

    assert protection.stop_loss == rupees("70")


def test_a_bought_option_targets_above_the_entry(option: Instrument) -> None:
    protection = levels(option, Direction.LONG, target_percentage=Decimal(60))

    assert protection.target == rupees("160")


def test_the_stop_is_always_on_the_losing_side(option: Instrument) -> None:
    entry = rupees("100")
    short = levels(option, Direction.SHORT, sl_percentage=Decimal(25))
    long = levels(option, Direction.LONG, sl_percentage=Decimal(25))

    assert short.stop_loss is not None
    assert long.stop_loss is not None
    assert short.stop_loss > entry
    assert long.stop_loss < entry


# -- rounding --------------------------------------------------------------


def test_a_stop_rounds_away_from_the_entry_never_tighter(option: Instrument) -> None:
    """Rounding towards the entry is a tighter stop than was configured."""
    protection = levels(option, Direction.SHORT, sl_percentage=Decimal("33.33"))

    # 133.33 is not on a 0.05 tick; away from a 100 entry is upwards.
    assert protection.stop_loss == rupees("133.35")


def test_a_long_stop_also_rounds_away(option: Instrument) -> None:
    protection = levels(option, Direction.LONG, sl_percentage=Decimal("33.33"))

    assert protection.stop_loss == rupees("66.65")


def test_a_target_rounds_away_so_it_asks_for_no_less_than_configured(
    option: Instrument,
) -> None:
    protection = levels(option, Direction.SHORT, target_percentage=Decimal("33.33"))

    assert protection.target == rupees("66.65")


def test_every_level_lands_on_a_tick(option: Instrument) -> None:
    protection = levels(
        option,
        Direction.SHORT,
        sl_percentage=Decimal("17.77"),
        target_percentage=Decimal("41.11"),
    )

    assert protection.stop_loss is not None
    assert protection.target is not None
    assert option.is_on_tick(protection.stop_loss)
    assert option.is_on_tick(protection.target)


# -- what is not set -------------------------------------------------------


def test_no_configured_stop_means_no_level(option: Instrument) -> None:
    protection = levels(option, Direction.SHORT, target_percentage=Decimal(50))

    assert protection.stop_loss is None
    assert not protection.no_stop_loss


def test_a_strategy_that_wants_no_stop_says_so(option: Instrument) -> None:
    """Distinct from a stop that has not been placed yet."""
    protection = levels(option, Direction.SHORT, no_stop_loss=True, sl_percentage=Decimal(30))

    assert protection.no_stop_loss
    assert protection.stop_loss is None


def test_no_configured_target_is_recorded_as_no_target(option: Instrument) -> None:
    protection = levels(option, Direction.SHORT, sl_percentage=Decimal(30))

    assert protection.no_target


def test_nothing_configured_at_all_protects_nothing(option: Instrument) -> None:
    protection = levels(option, Direction.SHORT)

    assert protection.stop_loss is None
    assert protection.target is None


# -- the initial level -----------------------------------------------------


def test_the_initial_stop_is_recorded_alongside_the_stop(option: Instrument) -> None:
    """Trailing overwrites the stop and must not overwrite where it started."""
    protection = levels(option, Direction.SHORT, sl_percentage=Decimal(30))

    assert protection.initial_stop_loss == protection.stop_loss
    assert not protection.has_moved


# -- flags carried through -------------------------------------------------


def test_trailing_is_carried_from_configuration(option: Instrument) -> None:
    protection = levels(
        option, Direction.SHORT, sl_percentage=Decimal(30), trail_sl=True, trail_sl_to_cost=True
    )

    assert protection.is_trailing
    assert protection.trail_to_cost


def test_the_trigger_to_limit_gap_is_carried(option: Instrument) -> None:
    protection = levels(
        option,
        Direction.SHORT,
        sl_percentage=Decimal(30),
        sl_trigger_to_limit_gap_percentage=Decimal("0.5"),
    )

    assert protection.trigger_to_limit_gap_percent == Decimal("0.5")


# -- refusals --------------------------------------------------------------


def test_a_target_that_would_price_at_zero_is_refused(option: Instrument) -> None:
    """A 100% target on a sold option is a premium of nothing."""
    with pytest.raises(DomainError, match="at or below zero"):
        levels(option, Direction.SHORT, target_percentage=Decimal(100))


def test_a_stop_that_would_price_at_zero_is_refused(option: Instrument) -> None:
    with pytest.raises(DomainError, match="at or below zero"):
        levels(option, Direction.LONG, sl_percentage=Decimal(120))


def test_an_entry_price_of_nothing_is_refused(option: Instrument) -> None:
    with pytest.raises(DomainError, match="entry price"):
        protection_from(
            configured(sl_percentage=Decimal(30)),
            direction=Direction.SHORT,
            instrument=option,
            entry=Money.zero(Currency.INR),
        )


def test_a_negative_percentage_is_refused_before_it_becomes_a_level(
    option: Instrument,
) -> None:
    with pytest.raises(DomainError, match="at or above zero"):
        levels(option, Direction.SHORT, sl_percentage=Decimal(-10))


# -- zero ------------------------------------------------------------------


def test_a_zero_percent_stop_sits_at_the_entry(option: Instrument) -> None:
    """Unusual but expressible, and it must not be mistaken for unset."""
    protection = levels(option, Direction.SHORT, sl_percentage=Decimal(0))

    assert protection.stop_loss == rupees("100")


class TestTheGroupsLevels:
    """A group's levels are percentages of what the group took in, so they
    ride on the leg as percentages rather than as prices: the price cannot be
    known until every leg has filled."""

    def test_the_combined_percentages_are_carried_on_the_leg(self, option: Instrument) -> None:
        protection = protection_from(
            configured(combined_sl_percentage=Decimal(10), combined_target_percentage=Decimal(25)),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_stop_loss_percent == Decimal(10)
        assert protection.combined_target_percent == Decimal(25)

    def test_a_group_stop_without_a_group_target_carries_only_the_stop(
        self, option: Instrument
    ) -> None:
        protection = protection_from(
            configured(combined_sl_percentage=Decimal(10)),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_stop_loss_percent == Decimal(10)
        assert protection.combined_target_percent is None

    def test_nothing_configured_leaves_the_group_without_levels(self, option: Instrument) -> None:
        protection = protection_from(
            configured(sl_percentage=Decimal(30)),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_stop_loss_percent is None
        assert protection.combined_target_percent is None

    def test_the_group_levels_are_not_the_legs_own(self, option: Instrument) -> None:
        """A leg keeps its own stop as well; whichever comes first."""
        protection = protection_from(
            configured(sl_percentage=Decimal(30), combined_sl_percentage=Decimal(10)),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.stop_loss == rupees("195")
        assert protection.combined_stop_loss_percent == Decimal(10)
