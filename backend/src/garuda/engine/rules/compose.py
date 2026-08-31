"""Boolean logic, as rules.

`all`, `any` and `not` take rules as parameters and are rules themselves. So
there is one concept rather than two, and arbitrary boolean structure costs
the engine no code at all.

Short-circuiting matters here for cost, not for meaning: rules are pure, so
stopping early can only save work.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from garuda.domain.errors import DomainError
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, Verdict, failed, passed, unavailable
from garuda.engine.rules.registry import Cost, Rule, cost_of, rule


def _cheapest_first(rules: tuple[Rule, ...]) -> tuple[Rule, ...]:
    """Free checks before expensive ones.

    Sound only because rules are pure: reordering cannot change what the tree
    answers, only how much it costs to find out. A stable sort keeps the
    configured order among equals, so a log reads the way the strategy was
    written.
    """
    order = {Cost.FREE: 0, Cost.CHEAP: 1, Cost.EXPENSIVE: 2}
    return tuple(sorted(rules, key=lambda member: order[cost_of(member)]))


@rule("all", cost=Cost.FREE)
@dataclass(frozen=True)
class AllOf:
    """Every member must pass. The usual shape of an entry rule set."""

    rules: tuple[Rule, ...] = field(default_factory=tuple)

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        if not self.rules:
            # Nothing asked for, so nothing withheld. An empty entry rule set
            # is a strategy with no conditions, which is a real thing to
            # configure and must not be mistaken for a broken one.
            return passed("no conditions were configured")

        for member in _cheapest_first(self.rules):
            outcome = member.evaluate(context)
            if outcome.blocks:
                return outcome
        return passed(f"all {len(self.rules)} conditions hold")


@rule("any", cost=Cost.FREE)
@dataclass(frozen=True)
class AnyOf:
    """One member passing is enough.

    An `UNAVAILABLE` member is not fatal here if a sibling passes -- "VIX below
    14 or ATR contracting" should still work when one of the two feeds is
    down. It only decides the answer when nothing passed, because then the
    difference between "no condition held" and "we could not tell" is the
    difference between a quiet strategy and a broken feed.
    """

    rules: tuple[Rule, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        # Refused when it is built, not when it runs, so a rule set that can
        # never pass is a save-time error rather than a 13:00 surprise.
        if not self.rules:
            raise DomainError("an 'any' of nothing can never pass; configure at least one rule")

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        blocked: list[RuleOutcome] = []
        for member in _cheapest_first(self.rules):
            outcome = member.evaluate(context)
            if outcome.is_pass:
                return outcome
            blocked.append(outcome)

        if any(outcome.verdict is Verdict.UNAVAILABLE for outcome in blocked):
            unreadable = [o.because for o in blocked if o.verdict is Verdict.UNAVAILABLE]
            return unavailable(
                f"none of {len(self.rules)} conditions held, and "
                f"{len(unreadable)} could not be read: {'; '.join(unreadable)}"
            )
        return failed(f"none of {len(self.rules)} conditions held")


@rule("not", cost=Cost.FREE)
@dataclass(frozen=True)
class Not:
    """The inverse of one rule.

    `UNAVAILABLE` is **not** inverted. Not knowing whether something is true is
    not the same as knowing it is false, and turning one into the other is how
    a dead feed becomes a passing condition.
    """

    of: Rule

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        outcome = self.of.evaluate(context)
        if outcome.verdict is Verdict.UNAVAILABLE:
            return outcome
        if outcome.is_pass:
            return failed(f"not: {outcome.because}")
        return passed(f"not: {outcome.because}")


@rule("at_least", cost=Cost.FREE)
@dataclass(frozen=True)
class AtLeast:
    """A quorum: at least ``count`` of the members must pass."""

    count: int
    rules: tuple[Rule, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.count < 1:
            raise DomainError(f"at_least {self.count} is not a quorum")
        if self.count > len(self.rules):
            raise DomainError(
                f"at_least {self.count} of {len(self.rules)} rules can never be reached"
            )

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        passes = 0
        unreadable = 0
        remaining = len(self.rules)

        for member in _cheapest_first(self.rules):
            outcome = member.evaluate(context)
            remaining -= 1
            if outcome.is_pass:
                passes += 1
                if passes >= self.count:
                    return passed(f"{passes} of {len(self.rules)} conditions hold")
            elif outcome.verdict is Verdict.UNAVAILABLE:
                unreadable += 1
            if passes + remaining < self.count:
                break

        if unreadable:
            return unavailable(
                f"only {passes} of {len(self.rules)} conditions held and "
                f"{unreadable} could not be read, so {self.count} may or may not be reachable"
            )
        return failed(f"only {passes} of {len(self.rules)} conditions held, needing {self.count}")
