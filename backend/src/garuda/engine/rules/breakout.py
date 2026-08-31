"""Breaking a level.

The reference engine gave this its own table and its own service, with its own
triggered/expired lifecycle and a copy of the resolved trade. Here it is a
rule: what makes a breakout special is only *when* the condition holds, and
the tranche lifecycle already owns arming and expiry.

**Confirmation is configurable because the choice costs money.** A touch reacts
first and is wrong most often; a close is slow and right more often. Neither is
the correct default for every strategy, so the strategy says.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed, unavailable
from garuda.engine.rules.registry import Cost, rule


class Way(StrEnum):
    UP = "up"
    DOWN = "down"


class Confirm(StrEnum):
    """What counts as having broken the level."""

    #: The latest tick is beyond it. Fastest, and the most easily faked out.
    TOUCH = "touch"
    #: The last closed bar closed beyond it.
    CLOSE = "close"
    #: The last ``bars`` closed bars all closed beyond it.
    CONSECUTIVE = "consecutive"


@rule("breakout", cost=Cost.CHEAP)
@dataclass(frozen=True)
class Breakout:
    """A price has broken a level, the configured way."""

    level: Decimal
    way: Way = Way.UP
    confirm: Confirm = Confirm.TOUCH
    interval: BarInterval = BarInterval.ONE_MINUTE
    #: How many closed bars must agree, for ``consecutive``.
    bars: int = 2
    instrument: InstrumentId | None = None

    def __post_init__(self) -> None:
        if self.bars < 1:
            raise DomainError(f"a breakout confirmed by {self.bars} bars is not confirmed")

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        subject = self.instrument or context.underlying

        if self.confirm is Confirm.TOUCH:
            quote = context.quote(subject)
            if quote is None:
                return unavailable(f"{subject} has no price")
            return self._judge(subject, [quote.last_price.amount], "the last price")

        wanted = 1 if self.confirm is Confirm.CLOSE else self.bars
        closes = context.candles(subject, self.interval, wanted)
        if len(closes) < wanted:
            return unavailable(
                f"{subject} has {len(closes)} closed {self.interval.value} bars, needing {wanted}"
            )
        return self._judge(subject, [bar.close.amount for bar in closes], self._describe(closes))

    def _describe(self, closes: Sequence[Bar]) -> str:
        if len(closes) == 1:
            return f"the last closed {closes[0].interval.value} bar"
        return f"the last {len(closes)} closed {closes[0].interval.value} bars"

    def _judge(self, subject: InstrumentId, prices: Sequence[Decimal], what: str) -> RuleOutcome:
        beyond = (
            all(price > self.level for price in prices)
            if self.way is Way.UP
            else all(price < self.level for price in prices)
        )
        direction = "above" if self.way is Way.UP else "below"
        if beyond:
            return passed(f"{subject}: {what} broke {direction} {self.level}")
        return failed(f"{subject}: {what} has not broken {direction} {self.level}")
