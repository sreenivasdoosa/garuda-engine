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
from garuda.domain.trailing import GapUnit, TrailConfig, TrailingMode
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


class TestHowTheStopFollows:
    """`trail_sl_type` names the mode and `trail_config` is free JSON holding
    the gaps. The reference's Console writes both from a named policy in
    `trailing_sl_policy`, which is a template rather than a reference: there is
    no key from a strategy to a policy, so what a strategy trails on is
    whatever was copied into its own row.
    """

    def test_trailing_off_carries_no_configuration(self, option: Instrument) -> None:
        """Distinguishable from a leg marked as trailing without a mode."""
        protection = protection_from(
            configured(sl_percentage=Decimal(30)),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is None

    def test_trailing_on_without_a_mode_is_the_risk_multiple(self, option: Instrument) -> None:
        protection = protection_from(
            configured(trail_sl=True),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail == TrailConfig()

    def test_gaps_are_in_points_unless_the_row_says_otherwise(self, option: Instrument) -> None:
        """A row that names gaps and not their unit means points, which is
        what the reference's own absolute rows are."""
        protection = protection_from(
            configured(trail_sl=True, trail_config='{"profitGap": 10}'),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is not None
        assert protection.trail.gap_unit is GapUnit.ABSOLUTE

    def test_the_break_even_gap_is_read_too(self, option: Instrument) -> None:
        """Trail-to-cost is a separate gap with a separate unit: profit at
        which the stop moves to break even, once."""
        protection = protection_from(
            configured(trail_sl=True, trail_config='{"trailToCostGap": 2}'),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is not None
        assert protection.trail.trail_to_cost_gap == Decimal(2)

    def test_the_gaps_are_read_from_the_json_column(self, option: Instrument) -> None:
        """The spellings are the reference engine's own, camelCase and all."""
        protection = protection_from(
            configured(
                trail_sl=True,
                trail_sl_type="RISK_MULTIPLE",
                trail_config='{"profitGap": 10, "slMoveGap": 5, "trailMode": "absolute"}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail == TrailConfig(
            mode=TrailingMode.RISK_MULTIPLE,
            profit_gap=Decimal(10),
            stop_move_gap=Decimal(5),
            gap_unit=GapUnit.ABSOLUTE,
        )

    def test_a_percentage_gap_unit_is_read(self, option: Instrument) -> None:
        protection = protection_from(
            configured(
                trail_sl=True,
                trail_config='{"profitGap": 2, "trailMode": "percentage"}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is not None
        assert protection.trail.gap_unit is GapUnit.PERCENTAGE

    def test_a_mode_this_engine_cannot_compute_is_kept_not_dropped(
        self, option: Instrument
    ) -> None:
        """Falling back to the risk-multiple arithmetic would trail a position
        a way nobody configured. The trailing pass refuses it by name."""
        protection = protection_from(
            configured(trail_sl=True, trail_sl_type="SUPER_TREND"),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is not None
        assert protection.trail.mode is TrailingMode.SUPER_TREND

    def test_a_mode_nobody_recognises_is_refused(self, option: Instrument) -> None:
        with pytest.raises(DomainError, match="not a trailing mode"):
            protection_from(
                configured(trail_sl=True, trail_sl_type="PARABOLIC"),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )

    def test_unreadable_json_is_refused_rather_than_ignored(self, option: Instrument) -> None:
        """A strategy whose gaps could not be parsed would trail on the
        defaults, which is a different strategy, silently."""
        with pytest.raises(DomainError, match="not readable JSON"):
            protection_from(
                configured(trail_sl=True, trail_config="{profitGap: 10}"),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )

    def test_json_that_is_not_an_object_is_refused(self, option: Instrument) -> None:
        with pytest.raises(DomainError, match="not an object"):
            protection_from(
                configured(trail_sl=True, trail_config="[10, 5]"),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )

    def test_a_gap_of_zero_is_refused(self, option: Instrument) -> None:
        """A zero step would move the stop on every tick and never anywhere."""
        with pytest.raises(DomainError, match="above zero"):
            protection_from(
                configured(trail_sl=True, trail_config='{"profitGap": 0}'),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )

    def test_a_gap_that_is_not_a_number_is_refused(self, option: Instrument) -> None:
        with pytest.raises(DomainError, match="not a number"):
            protection_from(
                configured(trail_sl=True, trail_config='{"profitGap": "wide"}'),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )

    def test_a_gap_unit_nobody_recognises_is_refused(self, option: Instrument) -> None:
        with pytest.raises(DomainError, match="not a gap unit"):
            protection_from(
                configured(trail_sl=True, trail_config='{"trailMode": "sideways"}'),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )


class TestHowTheGroupsStopFollows:
    """Out of the same `trail_config` column the per-leg trail reads, under
    its own keys -- which is where the reference engine writes them."""

    def test_the_group_trail_is_off_unless_asked_for(self, option: Instrument) -> None:
        protection = protection_from(
            configured(
                combined_sl_percentage=Decimal(10),
                trail_config='{"combinedProfitGap": 10, "combinedSlMoveGap": 5}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_trail_profit_gap is None
        assert protection.combined_trail_stop_move_gap is None

    def test_the_group_gaps_are_read_under_their_own_keys(self, option: Instrument) -> None:
        protection = protection_from(
            configured(
                combined_trail_sl=True,
                combined_sl_percentage=Decimal(10),
                trail_config='{"combinedProfitGap": 10, "combinedSlMoveGap": 5}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_trail_profit_gap == Decimal(10)
        assert protection.combined_trail_stop_move_gap == Decimal(5)

    def test_the_group_trail_is_in_per_cent_by_default(self, option: Instrument) -> None:
        """The opposite of the per-leg trail, where a gap is in points unless
        the row says otherwise. This is the reference's default for each."""
        protection = protection_from(
            configured(
                combined_trail_sl=True,
                trail_config='{"combinedProfitGap": 10, "combinedSlMoveGap": 5}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_trail_unit is GapUnit.PERCENTAGE

    def test_the_group_trail_can_be_in_money(self, option: Instrument) -> None:
        protection = protection_from(
            configured(
                combined_trail_sl=True,
                trail_config='{"combinedProfitGap": 1000, "combinedTrailMode": "absolute"}',
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.combined_trail_unit is GapUnit.ABSOLUTE

    def test_the_two_trails_do_not_share_a_gap(self, option: Instrument) -> None:
        """One column, two trails. A leg trailing on points has nothing to say
        about a group trailing on per cent of its premium."""
        protection = protection_from(
            configured(
                trail_sl=True,
                combined_trail_sl=True,
                trail_config=(
                    '{"profitGap": 10, "slMoveGap": 5, '
                    '"combinedProfitGap": 25, "combinedSlMoveGap": 20}'
                ),
            ),
            direction=Direction.SHORT,
            instrument=option,
            entry=rupees("150"),
        )

        assert protection.trail is not None
        assert protection.trail.profit_gap == Decimal(10)
        assert protection.combined_trail_profit_gap == Decimal(25)

    def test_a_group_trail_mode_nobody_recognises_is_refused(self, option: Instrument) -> None:
        with pytest.raises(DomainError, match="not a gap unit"):
            protection_from(
                configured(
                    combined_trail_sl=True,
                    trail_config='{"combinedTrailMode": "sideways"}',
                ),
                direction=Direction.SHORT,
                instrument=option,
                entry=rupees("150"),
            )
