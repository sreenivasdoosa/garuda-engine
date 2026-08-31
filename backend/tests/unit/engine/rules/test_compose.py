"""Boolean logic, as rules.

The interesting behaviour is what happens to UNAVAILABLE. Not knowing whether
something is true is not the same as knowing it is false, and every combinator
has to answer that question its own way.
"""

from __future__ import annotations

import pytest

from garuda.domain.errors import DomainError
from garuda.engine.rules.compose import AllOf, AnyOf, AtLeast, Not
from garuda.engine.rules.outcome import Verdict
from garuda.engine.rules.registry import build

from .conftest import Always, Explodes, FakeContext, Never, Unreadable

# -- all --------------------------------------------------------------------


def test_all_passes_when_every_member_does(context: FakeContext) -> None:
    outcome = AllOf((Always(), Always())).evaluate(context)

    assert outcome.is_pass


def test_all_fails_on_the_first_that_does_not_hold(context: FakeContext) -> None:
    ran: list[str] = []
    outcome = AllOf((Never(ran, "first"), Always(ran, "second"))).evaluate(context)

    assert outcome.verdict is Verdict.FAIL
    assert ran == ["first"]


def test_all_reports_the_member_that_blocked(context: FakeContext) -> None:
    outcome = AllOf((Always(), Never(label="vix"))).evaluate(context)

    assert "vix does not hold" in outcome.because


def test_all_is_blocked_by_a_member_it_cannot_read(context: FakeContext) -> None:
    outcome = AllOf((Always(), Unreadable())).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE
    assert outcome.blocks


def test_an_empty_all_is_a_strategy_with_no_conditions(context: FakeContext) -> None:
    """A real thing to configure, and not to be mistaken for a broken one."""
    outcome = AllOf(()).evaluate(context)

    assert outcome.is_pass


# -- any --------------------------------------------------------------------


def test_any_passes_on_the_first_member_that_holds(context: FakeContext) -> None:
    ran: list[str] = []
    outcome = AnyOf((Always(ran, "first"), Never(ran, "second"))).evaluate(context)

    assert outcome.is_pass
    assert ran == ["first"]


def test_any_fails_only_when_nothing_held(context: FakeContext) -> None:
    outcome = AnyOf((Never(), Never())).evaluate(context)

    assert outcome.verdict is Verdict.FAIL


def test_a_dead_feed_does_not_stop_any_when_a_sibling_passes(
    context: FakeContext,
) -> None:
    """ "VIX below 14 or ATR contracting" should still work with one feed down."""
    outcome = AnyOf((Unreadable(), Always())).evaluate(context)

    assert outcome.is_pass


def test_any_reports_unreadable_when_nothing_held_and_something_was_unreadable(
    context: FakeContext,
) -> None:
    """The difference between a quiet strategy and a broken feed."""
    outcome = AnyOf((Never(), Unreadable())).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE
    assert "could not be read" in outcome.because


def test_an_empty_any_can_never_pass_and_is_refused() -> None:
    with pytest.raises(DomainError, match="can never pass"):
        AnyOf(())


# -- not --------------------------------------------------------------------


def test_not_inverts_a_pass(context: FakeContext) -> None:
    outcome = Not(Always()).evaluate(context)

    assert outcome.verdict is Verdict.FAIL


def test_not_inverts_a_fail(context: FakeContext) -> None:
    outcome = Not(Never()).evaluate(context)

    assert outcome.is_pass


def test_not_does_not_invert_what_it_cannot_read(context: FakeContext) -> None:
    """Not knowing whether something is true is not knowing it is false, and
    turning one into the other makes a dead feed a passing condition."""
    outcome = Not(Unreadable()).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


# -- at least ---------------------------------------------------------------


def test_a_quorum_passes_when_enough_members_do(context: FakeContext) -> None:
    outcome = AtLeast(2, (Always(), Never(), Always())).evaluate(context)

    assert outcome.is_pass


def test_a_quorum_fails_when_too_few_hold(context: FakeContext) -> None:
    outcome = AtLeast(2, (Always(), Never(), Never())).evaluate(context)

    assert outcome.verdict is Verdict.FAIL


def test_a_quorum_stops_once_it_cannot_be_reached(context: FakeContext) -> None:
    ran: list[str] = []
    AtLeast(3, (Never(ran, "a"), Never(ran, "b"), Always(ran, "c"))).evaluate(context)

    assert "c" not in ran


def test_a_quorum_stops_as_soon_as_it_is_reached(context: FakeContext) -> None:
    ran: list[str] = []
    AtLeast(1, (Always(ran, "a"), Always(ran, "b"))).evaluate(context)

    assert ran == ["a"]


def test_a_quorum_that_might_have_been_reached_is_unreadable(
    context: FakeContext,
) -> None:
    outcome = AtLeast(2, (Always(), Unreadable(), Never())).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_a_quorum_larger_than_its_members_is_refused() -> None:
    with pytest.raises(DomainError, match="can never be reached"):
        AtLeast(3, (Always(), Always()))


def test_a_quorum_of_none_is_not_a_quorum() -> None:
    with pytest.raises(DomainError, match="not a quorum"):
        AtLeast(0, (Always(),))


# -- built from configuration ----------------------------------------------


def test_a_tree_is_built_from_one_fragment(context: FakeContext) -> None:
    built = build(
        {
            "type": "all",
            "rules": [
                {"type": "any", "rules": [{"type": "test_everything"}]},
                {"type": "not", "of": {"type": "not", "of": {"type": "test_everything"}}},
            ],
        }
    )

    assert built.evaluate(context).is_pass


def test_composition_needs_no_engine_code_to_nest(context: FakeContext) -> None:
    """`all`, `any` and `not` are rules taking rules, so arbitrary structure
    costs nothing."""
    built = build(
        {
            "type": "at_least",
            "count": 1,
            "rules": [{"type": "all", "rules": []}, {"type": "test_everything"}],
        }
    )

    assert built.evaluate(context).is_pass


# -- cost ordering ----------------------------------------------------------


def test_a_broken_member_still_raises_out_of_a_bare_tree(context: FakeContext) -> None:
    """Composition does not swallow faults; the runner does that, on purpose,
    so that a bare tree stays easy to reason about in a test."""
    with pytest.raises(RuntimeError):
        AllOf((Explodes(),)).evaluate(context)
