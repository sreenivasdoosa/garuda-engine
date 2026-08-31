"""Which way, from two rule sets.

The reference engine's own model, and the one its configured strategies use:
a tree of conditions for long and another for short, each an ordinary entry
rule. `RSI(14) > 50` long, `RSI(14) < 50` short is two trees, not one rule
with a level in it.

**Both sets passing is no opinion, not a coin toss.** Rules that contradict
each other are a configuration error, and answering either way would hide it
behind a position. **Neither passing is no opinion too** -- the strategy is
saying it does not have a view right now, which is exactly what a direction
rule is for.

Kept apart from `IndicatorDirection` rather than replacing it. That one says
"long above the level, short below", which has no gap and always answers; this
one has a gap by construction, and the two are different strategies.
"""

from __future__ import annotations

from dataclasses import dataclass

from garuda.domain.enums import Direction
from garuda.engine.direction.registry import direction
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.registry import Rule


@direction("rules")
@dataclass(frozen=True)
class RulesDirection:
    """Long if one rule set passes, short if the other does."""

    long_rules: Rule | None = None
    short_rules: Rule | None = None

    def resolve(self, context: RuleContext) -> Direction | None:
        long_way = self.long_rules is not None and self.long_rules.evaluate(context).is_pass
        short_way = self.short_rules is not None and self.short_rules.evaluate(context).is_pass

        if long_way and not short_way:
            return Direction.LONG
        if short_way and not long_way:
            return Direction.SHORT
        return None
