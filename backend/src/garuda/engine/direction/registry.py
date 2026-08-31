"""Direction rules by name.

The same plug-in machinery rules and selectors use. A direction rule is a
different shape — it answers a direction rather than a verdict — so it gets
its own registry, and nothing else differs.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from typing import Protocol, runtime_checkable

from garuda.core.plugins import Registration, Registry
from garuda.domain.enums import Direction
from garuda.engine.rules.context import RuleContext

logger = logging.getLogger(__name__)


@runtime_checkable
class DirectionRule(Protocol):
    """Which way to trade, or no opinion."""

    def resolve(self, context: RuleContext) -> Direction | None: ...


_DIRECTIONS: Registry[DirectionRule] = Registry("direction rule")


def direction(name: str) -> Callable[[type[DirectionRule]], type[DirectionRule]]:
    return _DIRECTIONS.register(name)


def build(config: object) -> DirectionRule:
    return _DIRECTIONS.build(config)


def build_all(configs: object) -> tuple[DirectionRule, ...]:
    return _DIRECTIONS.build_all(configs)


def registered() -> Mapping[str, Registration]:
    return _DIRECTIONS.known()


def first_answer(rules: Sequence[DirectionRule], context: RuleContext) -> Direction | None:
    """The first rule with an opinion, or None when none has one.

    A rule that raises is treated as having no opinion and the next is tried:
    the alternative is a broken provider standing a strategy down for the day
    when a perfectly good fallback was configured behind it.
    """
    for rule in rules:
        try:
            answer = rule.resolve(context)
        except Exception:
            logger.exception(
                "%s: %s could not decide a direction", context.strategy, type(rule).__name__
            )
            continue
        if answer is not None:
            return answer
    return None
