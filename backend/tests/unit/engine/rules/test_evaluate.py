"""Running a rule set safely.

A rule may be third-party code running inside the loop that decides whether
money moves. Nothing it does may become a pass.
"""

from __future__ import annotations

from dataclasses import dataclass

from garuda.engine.rules.compose import AllOf
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.evaluate import (
    FAILURES_BEFORE_DISABLED,
    RuleRunner,
    blocking_reason,
)
from garuda.engine.rules.outcome import RuleOutcome, Verdict

from .conftest import Always, Explodes, FakeContext, Never, Unreadable


@dataclass(frozen=True)
class Lies:
    """Answers with something that is not an outcome at all."""

    answer: object = True

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        return self.answer  # type: ignore[return-value]


def test_a_passing_rule_set_passes(context: FakeContext) -> None:
    evaluation = RuleRunner().evaluate(AllOf((Always(),)), context)

    assert evaluation.passed


def test_a_failing_rule_set_does_not(context: FakeContext) -> None:
    evaluation = RuleRunner().evaluate(AllOf((Never(),)), context)

    assert not evaluation.passed


# -- faults -----------------------------------------------------------------


def test_a_rule_that_raises_never_becomes_a_pass(context: FakeContext) -> None:
    evaluation = RuleRunner().evaluate(Explodes(), context)

    assert not evaluation.passed
    assert evaluation.outcome.verdict is Verdict.UNAVAILABLE


def test_a_rule_that_raises_does_not_take_the_engine_down(context: FakeContext) -> None:
    runner = RuleRunner()

    runner.evaluate(Explodes(), context)

    assert runner.evaluate(AllOf((Always(),)), context).passed


def test_the_fault_is_named_in_the_reason(context: FakeContext) -> None:
    evaluation = RuleRunner().evaluate(Explodes(), context)

    assert "Explodes" in evaluation.outcome.because
    assert "this rule is broken" in evaluation.outcome.because


def test_a_rule_answering_with_something_else_is_a_fault(context: FakeContext) -> None:
    """Truthy nonsense would otherwise be read as a pass by anything checking
    the answer rather than its type."""
    evaluation = RuleRunner().evaluate(Lies(True), context)

    assert not evaluation.passed
    assert evaluation.outcome.verdict is Verdict.UNAVAILABLE


def test_a_rule_that_keeps_raising_is_taken_out_of_service(
    context: FakeContext,
) -> None:
    runner = RuleRunner()
    broken = Explodes()

    for _ in range(FAILURES_BEFORE_DISABLED):
        runner.evaluate(broken, context)

    assert runner.out_of_service == 1
    assert "out of service" in runner.evaluate(broken, context).outcome.because


def test_a_rule_out_of_service_is_not_run_again(context: FakeContext) -> None:
    """Taking it out of service means not calling it, not calling it and
    ignoring the answer. Otherwise a rule that hangs or logs a page of stack
    keeps doing so every second until the close."""

    @dataclass(frozen=True)
    class CountsCalls:
        calls: list[int]

        def evaluate(self, ctx: RuleContext) -> RuleOutcome:
            self.calls.append(1)
            raise RuntimeError("still broken")

    runner = RuleRunner()
    broken = CountsCalls([])
    for _ in range(FAILURES_BEFORE_DISABLED):
        runner.evaluate(broken, context)
    calls_when_disabled = len(broken.calls)

    for _ in range(10):
        runner.evaluate(broken, context)

    assert len(broken.calls) == calls_when_disabled


def test_a_strategy_whose_rule_is_out_of_service_does_not_trade(
    context: FakeContext,
) -> None:
    """A rule set with a hole in it is not a weaker rule set; it is a
    different one."""
    runner = RuleRunner()
    broken = Explodes()

    for _ in range(FAILURES_BEFORE_DISABLED + 3):
        assert not runner.evaluate(broken, context).passed


def test_one_transient_failure_does_not_disable_anything(context: FakeContext) -> None:
    runner = RuleRunner()

    runner.evaluate(Explodes(), context)

    assert runner.out_of_service == 0


def test_a_rule_that_recovers_is_forgiven(context: FakeContext) -> None:
    """The count is consecutive failures, not lifetime ones."""

    @dataclass(frozen=True)
    class Flaky:
        calls: list[int]

        def evaluate(self, ctx: RuleContext) -> RuleOutcome:
            self.calls.append(1)
            if len(self.calls) % 2:
                raise RuntimeError("intermittent")
            return Always().evaluate(ctx)

    runner = RuleRunner()
    flaky = Flaky([])

    for _ in range(FAILURES_BEFORE_DISABLED * 2):
        runner.evaluate(flaky, context)

    assert runner.out_of_service == 0


def test_a_new_day_forgets_every_fault(context: FakeContext) -> None:
    runner = RuleRunner()
    broken = Explodes()
    for _ in range(FAILURES_BEFORE_DISABLED):
        runner.evaluate(broken, context)

    runner.reset()

    assert runner.out_of_service == 0


# -- what the operator reads ------------------------------------------------


def test_nothing_is_reported_when_a_rule_set_passed(context: FakeContext) -> None:
    assert blocking_reason(RuleRunner().evaluate(AllOf((Always(),)), context)) is None


def test_a_blocked_set_says_which_condition_stopped_it(context: FakeContext) -> None:
    reason = blocking_reason(RuleRunner().evaluate(AllOf((Never(label="vix"),)), context))

    assert reason is not None
    assert reason.startswith("blocked:")
    assert "vix" in reason


def test_an_unreadable_set_reads_differently_from_a_blocked_one(
    context: FakeContext,
) -> None:
    """A rule failing all day is a strategy waiting. A rule unavailable all day
    is a broken data path."""
    reason = blocking_reason(RuleRunner().evaluate(AllOf((Unreadable(),)), context))

    assert reason is not None
    assert reason.startswith("cannot tell:")
