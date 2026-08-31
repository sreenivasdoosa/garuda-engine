"""Building rules from configuration.

The behaviour that matters: a rule nobody recognises must be refused. A rule
silently dropped turns "enter only if volatility is low" into "enter".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time
from decimal import Decimal

import pytest

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, passed
from garuda.engine.rules.registry import Cost, Rule, build, build_all, registered, rule


@rule("test_everything")
@dataclass(frozen=True)
class Everything:
    """A rule with one field of every kind the coercion handles."""

    amount: Decimal = Decimal(0)
    count: int = 0
    flag: bool = False
    label: str = ""
    instrument: InstrumentId | None = None
    interval: BarInterval = BarInterval.ONE_MINUTE
    at: time | None = None

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        return passed("yes")


@rule("test_wrapper")
@dataclass(frozen=True)
class Wrapper:
    of: Rule
    others: tuple[Rule, ...] = field(default_factory=tuple)

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        return self.of.evaluate(context)


# -- naming -----------------------------------------------------------------


def test_a_registered_rule_can_be_built_by_name() -> None:
    built = build({"type": "test_everything", "count": 3})

    assert isinstance(built, Everything)
    assert built.count == 3


def test_a_rule_nobody_registered_is_refused() -> None:
    with pytest.raises(DomainError, match="is not a known rule"):
        build({"type": "enter_if_i_feel_like_it"})


def test_the_refusal_lists_what_the_engine_does_know() -> None:
    with pytest.raises(DomainError, match="test_everything"):
        build({"type": "nonsense"})


def test_a_fragment_with_no_type_is_refused() -> None:
    with pytest.raises(DomainError, match="must name its"):
        build({"count": 3})


def test_something_that_is_not_an_object_is_not_a_rule() -> None:
    with pytest.raises(DomainError, match="must be an object"):
        build("price_below")


def test_the_name_is_case_and_space_insensitive_when_read() -> None:
    assert isinstance(build({"type": "  TEST_EVERYTHING  "}), Everything)


def test_two_rules_may_not_claim_one_name() -> None:
    with pytest.raises(DomainError, match="two rules are registered"):

        @rule("test_everything")
        @dataclass(frozen=True)
        class Impostor:
            def evaluate(self, context: RuleContext) -> RuleOutcome:
                return passed("no")


def test_a_rule_that_is_not_a_dataclass_cannot_be_configured() -> None:
    with pytest.raises(DomainError, match="must be a dataclass"):

        @rule("test_not_a_dataclass")
        class Loose:
            def evaluate(self, context: RuleContext) -> RuleOutcome:
                return passed("no")


def test_a_registered_rule_appears_in_the_catalogue() -> None:
    assert "test_everything" in registered()


# -- parameters -------------------------------------------------------------


def test_a_parameter_nobody_recognises_is_refused() -> None:
    """A typo must be a configuration error, not a condition that quietly
    stopped applying."""
    with pytest.raises(DomainError, match="takes no parameter 'kount'"):
        build({"type": "test_everything", "kount": 3})


def test_the_refusal_says_what_it_does_take() -> None:
    with pytest.raises(DomainError, match="amount"):
        build({"type": "test_everything", "nope": 1})


def test_a_number_becomes_a_decimal_not_a_float() -> None:
    built = build({"type": "test_everything", "amount": 0.1})

    assert isinstance(built, Everything)
    assert built.amount == Decimal("0.1")


def test_a_price_written_as_text_is_read_exactly() -> None:
    built = build({"type": "test_everything", "amount": "1234.55"})

    assert isinstance(built, Everything)
    assert built.amount == Decimal("1234.55")


def test_an_unreadable_number_is_refused() -> None:
    with pytest.raises(DomainError, match="not a number"):
        build({"type": "test_everything", "amount": "cheap"})


def test_a_flag_is_not_a_number() -> None:
    with pytest.raises(DomainError, match="not a whole number"):
        build({"type": "test_everything", "count": True})


def test_an_instrument_is_read_from_its_id() -> None:
    built = build({"type": "test_everything", "instrument": "NSE:NIFTY"})

    assert isinstance(built, Everything)
    assert built.instrument == InstrumentId("NSE:NIFTY")


def test_an_interval_is_read_by_name() -> None:
    built = build({"type": "test_everything", "interval": "5m"})

    assert isinstance(built, Everything)
    assert built.interval is BarInterval.FIVE_MINUTES


def test_an_interval_nobody_publishes_is_refused_with_the_list() -> None:
    with pytest.raises(DomainError, match="expected one of"):
        build({"type": "test_everything", "interval": "7m"})


def test_a_time_is_read_from_the_clock_face() -> None:
    built = build({"type": "test_everything", "at": "13:00"})

    assert isinstance(built, Everything)
    assert built.at == time(13, 0)


def test_something_that_is_not_a_time_is_refused() -> None:
    with pytest.raises(DomainError, match="not a time"):
        build({"type": "test_everything", "at": "lunchtime"})


# -- nesting ----------------------------------------------------------------


def test_a_rule_taking_a_rule_builds_its_child() -> None:
    built = build({"type": "test_wrapper", "of": {"type": "test_everything", "count": 7}})

    assert isinstance(built, Wrapper)
    assert isinstance(built.of, Everything)
    assert built.of.count == 7


def test_a_rule_taking_a_list_of_rules_builds_them_all() -> None:
    built = build(
        {
            "type": "test_wrapper",
            "of": {"type": "test_everything"},
            "others": [{"type": "test_everything", "count": 1}, {"type": "test_everything"}],
        }
    )

    assert isinstance(built, Wrapper)
    assert len(built.others) == 2


def test_a_broken_child_is_refused_along_with_its_parent() -> None:
    with pytest.raises(DomainError, match="is not a known rule"):
        build({"type": "test_wrapper", "of": {"type": "imaginary"}})


def test_a_list_of_rules_that_is_not_a_list_is_refused() -> None:
    with pytest.raises(DomainError, match="expected a list of rules"):
        build_all({"type": "test_everything"})


def test_a_missing_required_parameter_is_refused() -> None:
    with pytest.raises(DomainError, match="test_wrapper"):
        build({"type": "test_wrapper"})


def test_an_enum_parameter_becomes_the_enum_not_the_string() -> None:
    """Every module here uses postponed annotations, so a field's declared type
    arrives as text. Coercing against text leaves the value a plain string, and
    an `is` comparison against the enum member is then quietly False for a
    perfectly valid configuration — the rule takes its other branch and nothing
    looks wrong."""
    built = build({"type": "test_everything", "interval": "5m"})

    assert isinstance(built, Everything)
    assert built.interval is BarInterval.FIVE_MINUTES
    assert not isinstance(built.interval, str) or type(built.interval) is not str


def test_a_cost_hint_is_recorded() -> None:
    assert registered()["test_everything"].cost is Cost.CHEAP


@dataclass(frozen=True)
class Corner:
    """Data, not a plug-in. Nothing registers it."""

    depth: int = 0
    amount: Decimal = Decimal(0)


@rule("test_nested")
@dataclass(frozen=True)
class Nested:
    """A rule with a value object inside it."""

    where: Corner = field(default_factory=Corner)

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        return passed("yes")


def test_a_nested_value_object_is_built_not_left_a_dict() -> None:
    """The third time this bug appeared: a field left as the mapping it
    arrived as compares unequal to everything and takes the other branch."""
    built = build({"type": "test_nested", "where": {"depth": 3, "amount": "1.5"}})

    assert isinstance(built, Nested)
    assert isinstance(built.where, Corner)
    assert built.where.depth == 3
    assert built.where.amount == Decimal("1.5")


def test_a_nested_value_object_refuses_what_it_does_not_take() -> None:
    with pytest.raises(DomainError, match="takes no 'deth'"):
        build({"type": "test_nested", "where": {"deth": 3}})
