"""Reading the rule JSON the Console writes.

The trees here are the shape the reference engine's own rule builder emits,
which is what the copied Console still emits. Two of them are the shapes its
real strategies are actually configured with: an ATR contraction, and a
SuperTrend read against the close.
"""

from __future__ import annotations

import pytest

from garuda.domain.errors import DomainError
from garuda.engine.direction import RulesDirection
from garuda.engine.direction import build_all as build_directions
from garuda.engine.rules.indicator import Comparator, IndicatorCompare
from garuda.engine.rules.registry import build as build_rule
from garuda.engine.rules.translate import (
    is_console_directions,
    is_console_shape,
    translate,
    translate_directions,
)

#: The rule the reference's CTS strategies carry, verbatim.
ATR_CONTRACTION = {
    "children": [
        {
            "condition": {
                "indicator": "ATR",
                "comparator": "LESS_THAN",
                "referenceParams": {"period": 100},
                "referenceInterval": "5minute",
                "referenceIndicator": "ATR",
                "interval": "5minute",
                "params": {"period": 20},
            },
            "type": "condition",
        }
    ],
    "type": "operator",
    "operator": "AND",
}

#: The rule the reference's REBOUND strategy carries, verbatim.
SUPERTREND_AGAINST_CLOSE = {
    "longRules": {
        "children": [
            {
                "condition": {
                    "indicator": "SUPERTREND",
                    "comparator": "GREATER_THAN",
                    "referenceParams": {"type": "CLOSE"},
                    "referenceInterval": "60minute",
                    "referenceIndicator": "PRICE",
                    "interval": "60minute",
                    "params": {"period": 10, "multiplier": 2},
                },
                "type": "condition",
            }
        ],
        "type": "operator",
        "operator": "AND",
    }
}

#: The rule the reference's RSI strategies carry, verbatim.
RSI_EITHER_WAY = {
    "longRules": {
        "children": [
            {
                "condition": {
                    "indicator": "RSI",
                    "comparator": "GREATER_THAN",
                    "interval": "60minute",
                    "params": {"period": 14},
                    "value": 50,
                },
                "type": "condition",
            }
        ],
        "type": "operator",
        "operator": "AND",
    },
    "shortRules": {
        "children": [
            {
                "condition": {
                    "indicator": "RSI",
                    "comparator": "LESS_THAN_OR_EQUAL",
                    "interval": "60minute",
                    "params": {"period": 14},
                    "value": 50,
                },
                "type": "condition",
            }
        ],
        "type": "operator",
        "operator": "AND",
    },
}


# -- telling the two shapes apart -------------------------------------------


def test_the_consoles_shape_is_recognised() -> None:
    assert is_console_shape(ATR_CONTRACTION)


def test_the_registrys_own_shape_is_left_alone() -> None:
    """The vocabularies do not overlap: nothing in the registry is called
    `operator` or `condition`, and the Console has no rule called `all`."""
    assert not is_console_shape({"type": "all", "rules": []})
    assert not is_console_shape({"type": "indicator", "indicator": "rsi"})


def test_direction_rules_are_recognised_by_either_tree() -> None:
    """A short-only strategy names only shortRules, and is still the
    Console's shape."""
    assert is_console_directions(RSI_EITHER_WAY)
    assert is_console_directions({"longRules": ATR_CONTRACTION})
    assert is_console_directions({"shortRules": ATR_CONTRACTION})
    assert not is_console_directions([{"type": "fixed", "way": "long"}])


def test_a_condition_without_its_type_is_still_recognised() -> None:
    """A hand-written row that names a condition and omits the node type is
    unambiguous, and refusing it would be pedantry rather than safety."""
    assert is_console_shape({"condition": {"indicator": "RSI"}})


def test_a_short_only_strategy_translates() -> None:
    built = build_directions(translate_directions({"shortRules": ATR_CONTRACTION}))
    rule = built[0]

    assert isinstance(rule, RulesDirection)
    assert rule.long_rules is None
    assert rule.short_rules is not None


# -- the real rows ----------------------------------------------------------


def test_an_atr_contraction_becomes_a_buildable_rule() -> None:
    built = build_rule(translate(ATR_CONTRACTION))

    assert isinstance(built, type(build_rule({"type": "all", "rules": []})))


def test_the_atr_condition_keeps_every_part_of_itself() -> None:
    translated = translate(ATR_CONTRACTION)
    condition = translated["rules"][0]

    assert condition == {
        "type": "indicator",
        "indicator": "atr",
        "comparator": "lt",
        "interval": "5m",
        "params": {"period": 20},
        "reference": "atr",
        "reference_params": {"period": 100},
        "reference_interval": "5m",
    }


def test_the_price_field_is_renamed_off_the_reserved_key() -> None:
    """The Console calls the price's field `type`, which is the one name a
    plug-in parameter may not have: `type` is how the registry chooses what to
    build."""
    translated = translate_directions(SUPERTREND_AGAINST_CLOSE)
    condition = translated[0]["long_rules"]["rules"][0]

    assert condition["reference"] == "price"
    assert condition["reference_params"] == {"field": "CLOSE"}


def test_a_supertrend_against_the_close_builds() -> None:
    built = build_directions(translate_directions(SUPERTREND_AGAINST_CLOSE))

    assert len(built) == 1
    assert isinstance(built[0], RulesDirection)


def test_a_strategy_with_only_long_rules_has_no_short_rules() -> None:
    built = build_directions(translate_directions(SUPERTREND_AGAINST_CLOSE))
    rule = built[0]

    assert isinstance(rule, RulesDirection)
    assert rule.long_rules is not None
    assert rule.short_rules is None


def test_rsi_either_way_becomes_one_rule_holding_both_trees() -> None:
    """One rule rather than two, because both passing is a contradiction and
    only a rule holding both trees can tell."""
    built = build_directions(translate_directions(RSI_EITHER_WAY))
    rule = built[0]

    assert isinstance(rule, RulesDirection)
    assert rule.long_rules is not None
    assert rule.short_rules is not None


def test_a_translated_condition_is_the_rule_it_reads_as() -> None:
    built = build_rule(translate(ATR_CONTRACTION))
    inner = built.rules[0]  # type: ignore[attr-defined]

    assert isinstance(inner, IndicatorCompare)
    assert inner.indicator == "atr"
    assert inner.comparator is Comparator.BELOW
    assert inner.reference == "atr"
    assert inner.params == {"period": 20}
    assert inner.reference_params == {"period": 100}


# -- the vocabularies -------------------------------------------------------


@pytest.mark.parametrize(
    ("named", "expected"),
    [
        ("minute", "1m"),
        ("3minute", "3m"),
        ("5minute", "5m"),
        ("15minute", "15m"),
        ("30minute", "30m"),
        ("60minute", "1h"),
        ("day", "1d"),
    ],
)
def test_every_interval_the_engine_carries_is_mapped(named: str, expected: str) -> None:
    translated = translate(_a_condition(interval=named))

    assert translated["interval"] == expected


@pytest.mark.parametrize("named", ["2minute", "10minute", "month"])
def test_an_interval_the_engine_does_not_carry_is_refused(named: str) -> None:
    """Rounding to the nearest is not a smaller version of the strategy, it is
    a different one."""
    with pytest.raises(DomainError, match="not an interval"):
        translate(_a_condition(interval=named))


@pytest.mark.parametrize(
    ("named", "expected"),
    [
        ("GREATER_THAN", "gt"),
        ("GREATER_THAN_OR_EQUAL", "gte"),
        ("LESS_THAN", "lt"),
        ("LESS_THAN_OR_EQUAL", "lte"),
        ("EQUAL", "eq"),
        ("NOT_EQUAL", "ne"),
        ("CROSS_ABOVE", "cross_above"),
        ("CROSS_BELOW", "cross_below"),
    ],
)
def test_every_comparator_is_mapped(named: str, expected: str) -> None:
    translated = translate(_a_condition(comparator=named))

    assert translated["comparator"] == expected


def test_a_comparator_this_engine_does_not_implement_is_refused() -> None:
    """FLIP is SuperTrend state rather than a comparison, and is not built."""
    with pytest.raises(DomainError, match="not a comparator"):
        translate(_a_condition(comparator="FLIP"))


def test_an_or_node_becomes_any() -> None:
    tree = {"type": "operator", "operator": "OR", "children": [_a_condition()]}

    assert translate(tree)["type"] == "any"


def test_an_operator_nobody_recognises_is_refused() -> None:
    """The Console's evaluator treats anything that is not AND as OR, so a
    third operator would silently become an OR there. Refused here instead."""
    tree = {"type": "operator", "operator": "XOR", "children": [_a_condition()]}

    with pytest.raises(DomainError, match="not a rule operator"):
        translate(tree)


# -- what it refuses --------------------------------------------------------


def test_an_operator_with_no_conditions_is_refused() -> None:
    """The Console reads an empty AND as never true and this engine reads an
    empty `all` as nothing asked for, which passes. Mapping it either way
    silently flips a strategy between never entering and always entering."""
    with pytest.raises(DomainError, match="no conditions under it"):
        translate({"type": "operator", "operator": "AND", "children": []})


def test_a_condition_comparing_against_nothing_is_refused() -> None:
    condition = {"indicator": "RSI", "comparator": "GREATER_THAN", "interval": "5minute"}

    with pytest.raises(DomainError, match="neither a value nor another indicator"):
        translate({"type": "condition", "condition": condition})


def test_a_condition_naming_no_indicator_is_refused() -> None:
    with pytest.raises(DomainError, match="names no indicator"):
        translate({"type": "condition", "condition": {"comparator": "GREATER_THAN"}})


def test_direction_rules_naming_neither_side_are_refused() -> None:
    with pytest.raises(DomainError, match="neither longRules nor shortRules"):
        translate_directions({"somethingElse": {}})


def test_a_node_that_is_neither_is_refused() -> None:
    with pytest.raises(DomainError, match="neither a condition nor an operator"):
        translate({"type": "something", "value": 1})


def test_an_indicator_nobody_registered_is_refused_by_the_registry() -> None:
    """Left to the registry, which refuses by name when the rule is read --
    so a typo is a configuration error rather than something that throws on
    every tick."""
    with pytest.raises(DomainError, match="vibes"):
        build_rule(translate(_a_condition(indicator="VIBES")))


def _a_condition(
    *,
    indicator: str = "RSI",
    comparator: str = "GREATER_THAN",
    interval: str = "5minute",
) -> dict[str, object]:
    return {
        "type": "condition",
        "condition": {
            "indicator": indicator,
            "comparator": comparator,
            "interval": interval,
            "params": {"period": 14},
            "value": 50,
        },
    }
