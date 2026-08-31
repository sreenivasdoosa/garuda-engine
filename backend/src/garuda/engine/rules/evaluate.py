"""Running a rule set safely.

A rule may be third-party code, and it runs inside the loop that decides
whether money moves. Three promises:

* **An exception is never a pass.** It becomes `UNAVAILABLE`, which blocks.
* **A broken rule never stops another strategy.** It is contained here.
* **A rule that keeps failing is disabled**, loudly, and the strategy stops
  trading. A rule set with a hole in it is not a weaker rule set; it is a
  different one, and running it would be running something nobody configured.

Nothing here decides anything about trading. It runs one rule set and reports
what happened, which is what the caller journals and what the operator reads
when they ask why a tranche never went on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, Verdict, unavailable
from garuda.engine.rules.registry import Rule

logger = logging.getLogger(__name__)

#: How many times a rule may raise before it is taken out of service for the
#: day. One is a transient; a handful in a row is a defect, and retrying it
#: every second until the close only fills the log.
FAILURES_BEFORE_DISABLED = 5


@dataclass(frozen=True, slots=True)
class Evaluation:
    """What running one rule set produced."""

    outcome: RuleOutcome
    #: The rule that decided the answer, when one did.
    decided_by: Rule | None = None

    @property
    def passed(self) -> bool:
        return self.outcome.is_pass


@dataclass
class RuleRunner:
    """Runs rule sets, and remembers which rules are misbehaving.

    Stateful on purpose, and the state is about faults rather than about
    trading: which rules have raised, and how often. Nothing here affects what
    a healthy rule answers.
    """

    _failures: dict[int, int] = field(default_factory=dict)
    _disabled: dict[int, str] = field(default_factory=dict)

    def evaluate(self, subject: Rule, context: RuleContext, *, label: str = "") -> Evaluation:
        """Run one rule set. Never raises."""
        key = id(subject)
        disabled = self._disabled.get(key)
        if disabled is not None:
            return Evaluation(unavailable(f"this rule is out of service for the day: {disabled}"))

        try:
            # Deliberately typed as object: the protocol promises a
            # RuleOutcome, and a third-party rule does not have to keep that
            # promise. Trusting the annotation here is how something truthy
            # gets read as a pass.
            outcome: object = subject.evaluate(context)
        except Exception as error:  # a rule may be third-party code
            return Evaluation(self._faulted(subject, error, label))

        self._failures.pop(key, None)
        if not isinstance(outcome, RuleOutcome):
            # A rule that answers with something else is broken in a way that
            # would otherwise be read as a pass by anything checking
            # truthiness.
            return Evaluation(
                self._faulted(
                    subject,
                    TypeError(f"answered with {type(outcome).__name__}, not a RuleOutcome"),
                    label,
                )
            )
        return Evaluation(outcome, decided_by=subject)

    def _faulted(self, subject: Rule, error: Exception, label: str) -> RuleOutcome:
        key = id(subject)
        count = self._failures.get(key, 0) + 1
        self._failures[key] = count
        name = type(subject).__name__
        detail = f"{type(error).__name__}: {error}"

        logger.exception("%s: rule %s failed (%d in a row)", label or "rules", name, count)

        if count >= FAILURES_BEFORE_DISABLED:
            self._disabled[key] = detail
            return unavailable(
                f"{name} failed {count} times and is out of service for the day ({detail})"
            )
        return unavailable(f"{name} could not be evaluated ({detail})")

    @property
    def out_of_service(self) -> int:
        return len(self._disabled)

    def reset(self) -> None:
        """Forget every fault. Called at day-init, not during a session."""
        self._failures.clear()
        self._disabled.clear()


def blocking_reason(evaluation: Evaluation) -> str | None:
    """The sentence to show an operator, or None when nothing blocked."""
    if evaluation.passed:
        return None
    prefix = "cannot tell" if evaluation.outcome.verdict is Verdict.UNAVAILABLE else "blocked"
    return f"{prefix}: {evaluation.outcome.because}"
