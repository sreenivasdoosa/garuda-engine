"""Direction rules that need nothing."""

from __future__ import annotations

from dataclasses import dataclass

from garuda.domain.enums import Direction
from garuda.engine.direction.registry import direction
from garuda.engine.rules.context import RuleContext


@direction("fixed")
@dataclass(frozen=True)
class Fixed:
    """Always the same way.

    Which is not the same as a strategy with no direction at all: a short
    strangle is undirectional and its legs say so, while this is a strategy
    that has taken a view and holds it.
    """

    way: Direction = Direction.LONG

    def resolve(self, context: RuleContext) -> Direction | None:
        del context
        return self.way
