"""Resolving a strategy's configuration from its layers.

The behaviour that costs money if it is wrong: a field set at a broad scope
must survive a narrower layer that does not mention it. The field that goes
missing most often is the stop.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.domain.errors import DomainError
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.daycondition import DayCondition

EXPIRY = frozenset({DayCondition.EXPIRY})
EXPIRY_THURSDAY = frozenset({DayCondition.EXPIRY, DayCondition.THURSDAY})


def layer(
    tranche: int | None = None, day: DayCondition | None = None, **values: object
) -> ConfigLayer:
    return ConfigLayer(values=values, tranche=tranche, day_condition=day)


# -- merging ----------------------------------------------------------------


def test_a_base_layer_is_used_when_nothing_narrower_exists() -> None:
    resolved = resolve("s", [layer(sl_percentage=Decimal(30))])

    assert resolved.percent("sl_percentage") == Decimal(30)


def test_a_narrower_layer_overrides_a_broader_one() -> None:
    resolved = resolve(
        "s",
        [layer(sl_percentage=Decimal(30)), layer(tranche=2, sl_percentage=Decimal(20))],
        tranche=2,
    )

    assert resolved.percent("sl_percentage") == Decimal(20)


def test_a_field_a_narrower_layer_does_not_mention_survives() -> None:
    """The whole mechanism. Taking the highest-priority *row* instead loses
    the stop, and the position goes on without one."""
    resolved = resolve(
        "s",
        [
            layer(sl_percentage=Decimal(30), target_percentage=Decimal(60)),
            layer(tranche=2, strike_type="MoneyNess"),
        ],
        tranche=2,
    )

    assert resolved.percent("sl_percentage") == Decimal(30)
    assert resolved.percent("target_percentage") == Decimal(60)
    assert resolved.text("strike_type") == "MoneyNess"


def test_the_most_specific_scope_wins_over_both_middle_scopes() -> None:
    resolved = resolve(
        "s",
        [
            layer(lots_per_tranch=1),
            layer(day=DayCondition.EXPIRY, lots_per_tranch=2),
            layer(tranche=3, lots_per_tranch=3),
            layer(tranche=3, day=DayCondition.EXPIRY, lots_per_tranch=4),
        ],
        tranche=3,
        conditions=EXPIRY,
    )

    assert resolved.whole("lots_per_tranch") == 4


def test_a_tranche_layer_outranks_a_day_layer() -> None:
    """The reference weights tranche above day condition, and so does this."""
    resolved = resolve(
        "s",
        [
            layer(day=DayCondition.EXPIRY, lots_per_tranch=2),
            layer(tranche=3, lots_per_tranch=3),
        ],
        tranche=3,
        conditions=EXPIRY,
    )

    assert resolved.whole("lots_per_tranch") == 3


# -- scope ------------------------------------------------------------------


def test_a_layer_for_another_tranche_is_ignored() -> None:
    resolved = resolve(
        "s",
        [layer(lots_per_tranch=1), layer(tranche=7, lots_per_tranch=9)],
        tranche=2,
    )

    assert resolved.whole("lots_per_tranch") == 1


def test_a_layer_for_a_day_that_is_not_today_is_ignored() -> None:
    resolved = resolve(
        "s",
        [layer(lots_per_tranch=1), layer(day=DayCondition.EXPIRY, lots_per_tranch=9)],
        conditions=frozenset({DayCondition.MONDAY}),
    )

    assert resolved.whole("lots_per_tranch") == 1


def test_an_unset_scope_is_a_wildcard() -> None:
    resolved = resolve("s", [layer(sl_percentage=Decimal(30))], tranche=11, conditions=EXPIRY)

    assert resolved.percent("sl_percentage") == Decimal(30)


def test_no_layers_at_all_resolves_to_nothing_rather_than_failing() -> None:
    resolved = resolve("s", [])

    assert resolved.percent("sl_percentage") is None
    assert not resolved.has("sl_percentage")


def test_two_conditions_holding_at_once_both_apply() -> None:
    """An expiry on a Thursday is both, and each may set different fields."""
    resolved = resolve(
        "s",
        [
            layer(day=DayCondition.EXPIRY, sl_percentage=Decimal(20)),
            layer(day=DayCondition.THURSDAY, target_percentage=Decimal(50)),
        ],
        conditions=EXPIRY_THURSDAY,
    )

    assert resolved.percent("sl_percentage") == Decimal(20)
    assert resolved.percent("target_percentage") == Decimal(50)


def test_two_layers_of_equal_priority_resolve_the_same_way_every_time() -> None:
    """Otherwise a strategy's behaviour changes when an index is rebuilt."""
    on_expiry = layer(day=DayCondition.EXPIRY, lots_per_tranch=2)
    on_thursday = layer(day=DayCondition.THURSDAY, lots_per_tranch=5)

    one = resolve("s", [on_expiry, on_thursday], conditions=EXPIRY_THURSDAY)
    other = resolve("s", [on_thursday, on_expiry], conditions=EXPIRY_THURSDAY)

    assert one.whole("lots_per_tranch") == other.whole("lots_per_tranch")


def test_the_layers_that_produced_a_value_are_recorded() -> None:
    """ "Why did it use that strike" is answerable only if they are."""
    resolved = resolve(
        "s",
        [layer(lots_per_tranch=1), layer(tranche=2, lots_per_tranch=3)],
        tranche=2,
    )

    assert [contributed.priority for contributed in resolved.layers] == [2, 0]


# -- layers hold set fields only --------------------------------------------


def test_a_layer_may_not_hold_a_null() -> None:
    """A null is the absence of a field. Keeping it would override a broader
    scope with nothing, which is what the table cannot express."""
    with pytest.raises(DomainError, match="only fields that are set"):
        ConfigLayer(values={"sl_percentage": None})


def test_a_negative_tranche_is_not_a_tranche() -> None:
    with pytest.raises(DomainError, match="is not a tranche"):
        ConfigLayer(values={}, tranche=-1)


# -- reading values ---------------------------------------------------------


def test_a_percentage_is_a_decimal_not_a_float() -> None:
    resolved = resolve("s", [layer(sl_percentage="30.5")])

    value = resolved.percent("sl_percentage")
    assert value == Decimal("30.5")
    assert isinstance(value, Decimal)


def test_a_negative_stop_percentage_is_refused() -> None:
    """It would put the stop on the wrong side of the entry, where it fills
    immediately."""
    resolved = resolve("s", [layer(sl_percentage=Decimal(-5))])

    with pytest.raises(DomainError, match="at or above zero"):
        resolved.percent("sl_percentage")


def test_an_unreadable_number_names_the_field_and_the_strategy() -> None:
    resolved = resolve("straddle", [layer(sl_percentage="thirty")])

    with pytest.raises(DomainError, match="straddle: sl_percentage"):
        resolved.percent("sl_percentage")


def test_an_unreadable_whole_number_is_refused() -> None:
    resolved = resolve("s", [layer(lots_per_tranch="two")])

    with pytest.raises(DomainError, match="a whole number"):
        resolved.whole("lots_per_tranch")


def test_a_flag_is_not_a_number() -> None:
    """True would become 1, which is a plausible tranche count."""
    resolved = resolve("s", [layer(lots_per_tranch=True)])

    with pytest.raises(DomainError, match="a whole number"):
        resolved.whole("lots_per_tranch")


@pytest.mark.parametrize("stored", [True, 1, "1", "true", "YES", "y"])
def test_a_flag_reads_however_it_was_stored(stored: object) -> None:
    resolved = resolve("s", [layer(hedging_enabled=stored)])

    assert resolved.flag("hedging_enabled")


@pytest.mark.parametrize("stored", [False, 0, "0", "false", "no", ""])
def test_a_flag_that_is_off_reads_off(stored: object) -> None:
    resolved = resolve("s", [layer(hedging_enabled=stored)])

    assert not resolved.flag("hedging_enabled")


def test_an_unset_flag_takes_the_default_it_was_given() -> None:
    resolved = resolve("s", [])

    assert resolved.flag("hedging_enabled") is False
    assert resolved.flag("hedging_enabled", default=True) is True


def test_blank_text_reads_as_absent() -> None:
    """A column holding spaces is a column nobody filled in."""
    resolved = resolve("s", [layer(strike_type="   ")])

    assert resolved.text("strike_type") is None


def test_an_empty_config_is_still_a_config() -> None:
    assert ResolvedConfig(strategy="s").text("anything") is None
