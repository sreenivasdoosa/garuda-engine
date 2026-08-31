"""What a rule answers.

Three-valued, deliberately. `FAIL` and `UNAVAILABLE` both stop an entry, and
collapsing them is how a feed outage becomes "the strategy just did not get a
signal today".

A rule that fails all day is a strategy waiting for its condition, which is
ordinary. A rule that is *unavailable* all day is a broken data path, and the
operator has to be told.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import StrEnum

from garuda.domain.errors import DomainError


class Verdict(StrEnum):
    PASS = "PASS"
    FAIL = "FAIL"
    #: Cannot tell — no quote, not enough candles, no indicator. Blocks like a
    #: FAIL and is reported unlike one.
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class RuleOutcome:
    """A verdict, and a sentence saying why."""

    verdict: Verdict
    #: One sentence an operator can read, naming the numbers compared. This is
    #: the answer to "why didn't it trade", so it is not optional.
    because: str
    #: The values behind the sentence, for the evaluation record.
    detail: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.because.strip():
            raise DomainError("a rule outcome must say why")

    @property
    def is_pass(self) -> bool:
        return self.verdict is Verdict.PASS

    @property
    def blocks(self) -> bool:
        """Whether this stops an entry. Both non-passes do."""
        return self.verdict is not Verdict.PASS


def passed(because: str, **detail: object) -> RuleOutcome:
    return RuleOutcome(Verdict.PASS, because, detail)


def failed(because: str, **detail: object) -> RuleOutcome:
    return RuleOutcome(Verdict.FAIL, because, detail)


def unavailable(because: str, **detail: object) -> RuleOutcome:
    return RuleOutcome(Verdict.UNAVAILABLE, because, detail)
