"""Rules by name.

A rule is registered under a name and configured by parameters, so a strategy
stores ``{"type": "price_below", "value": 14}`` and the engine knows nothing
about what any particular rule means. A new rule is a new class with a
decorator; nothing here changes, and nothing above here changes either.

The machinery is :mod:`garuda.core.plugins`, shared with selectors so that a
second kind of pluggable thing cost nothing and a third will not either.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Protocol, runtime_checkable

from garuda.core.plugins import TYPE_KEY, Cost, Registration, Registry
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome

__all__ = [
    "TYPE_KEY",
    "Cost",
    "Registration",
    "Rule",
    "build",
    "build_all",
    "cost_of",
    "registered",
    "rule",
]


@runtime_checkable
class Rule(Protocol):
    """A pure predicate over a context."""

    def evaluate(self, context: RuleContext) -> RuleOutcome: ...


_RULES: Registry[Rule] = Registry("rule")


def rule(name: str, *, cost: Cost = Cost.CHEAP) -> Callable[[type[Rule]], type[Rule]]:
    """Register a rule class under a configuration name."""
    return _RULES.register(name, cost=cost)


def registered() -> Mapping[str, Registration]:
    return _RULES.known()


def cost_of(instance: Rule) -> Cost:
    return _RULES.cost_of(instance)


def build(config: object) -> Rule:
    """One configuration fragment into a rule, children and all."""
    return _RULES.build(config)


def build_all(configs: object) -> tuple[Rule, ...]:
    return _RULES.build_all(configs)
