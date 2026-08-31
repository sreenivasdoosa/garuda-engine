"""Resolving a strategy's configuration.

A strategy is configured at four scopes, and the more specific one wins:

===================  ==================================  ========
scope                keyed by                            priority
===================  ==================================  ========
base                 strategy                                   0
day                  strategy + day condition                   1
tranche              strategy + tranche                         2
tranche and day      strategy + tranche + day condition         3
===================  ==================================  ========

**Merged per field, not per row.** A base row supplying the stop-loss
percentage and a tranche row supplying only the strike type resolve into one
configuration carrying both; the tranche row does not have to repeat the stop.
Taking the highest-priority *row* instead would silently drop most of a
strategy's settings, and the one it drops most often is the stop.

That is why a field is either present or absent, never "present and null".
Absent means "not set at this scope" and defers to a broader one. Nothing here
can express "set to nothing", because the configuration table cannot either.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation

from garuda.domain.errors import DomainError
from garuda.engine.daycondition import DayCondition

#: One layer's values, keyed by field name. Absent keys defer; there are no
#: null values.
type ConfigValues = Mapping[str, object]


@dataclass(frozen=True)
class ConfigLayer:
    """One configuration row, reduced to its scope and its set fields."""

    values: ConfigValues
    tranche: int | None = None
    day_condition: DayCondition | None = None

    def __post_init__(self) -> None:
        if self.tranche is not None and self.tranche < 0:
            raise DomainError(f"tranche {self.tranche} is not a tranche")
        if any(value is None for value in self.values.values()):
            raise DomainError(
                "a configuration layer holds only fields that are set; a null is "
                "the absence of a field, and keeping it would override a broader "
                "scope with nothing"
            )

    @property
    def priority(self) -> int:
        """How specific this layer is. Higher wins.

        The same arithmetic the database computes, repeated here so a layer
        built in memory sorts identically to one read from a row.
        """
        return (2 if self.tranche is not None else 0) + (1 if self.day_condition is not None else 0)

    def applies_to(self, tranche: int, conditions: frozenset[DayCondition]) -> bool:
        """Whether this layer is in scope for one evaluation.

        An unset scope is a wildcard: a layer with no tranche applies to every
        tranche, and one with no day condition to every day.
        """
        if self.tranche is not None and self.tranche != tranche:
            return False
        return not (self.day_condition is not None and self.day_condition not in conditions)


@dataclass(frozen=True)
class ResolvedConfig:
    """One strategy's settings for one tranche on one day.

    A typed view over the merged values. Reading through accessors rather than
    the mapping is what makes an unusable value fail here, with the field name
    and the strategy in the message, instead of somewhere downstream.
    """

    strategy: str
    values: ConfigValues = field(default_factory=dict)
    #: Which layers contributed, most specific first. Kept for the evaluation
    #: record: "why did it use that strike" is answerable only if the layers
    #: that produced it are known.
    layers: tuple[ConfigLayer, ...] = ()

    def has(self, name: str) -> bool:
        return name in self.values

    def text(self, name: str) -> str | None:
        value = self.values.get(name)
        if value is None:
            return None
        text = str(value).strip()
        return text or None

    def flag(self, name: str, *, default: bool = False) -> bool:
        value = self.values.get(name)
        if value is None:
            return default
        if isinstance(value, bool):
            return value
        if isinstance(value, int):
            return value != 0
        return str(value).strip().lower() in {"1", "true", "yes", "y"}

    def whole(self, name: str) -> int | None:
        value = self.values.get(name)
        if value is None:
            return None
        if isinstance(value, bool):
            # A flag read as a number is a configuration mistake worth naming:
            # True would become 1, which is a plausible tranche count.
            raise self._unusable(name, value, "a whole number")
        if isinstance(value, int):
            return value
        try:
            return int(str(value).strip())
        except (TypeError, ValueError):
            raise self._unusable(name, value, "a whole number") from None

    def number(self, name: str) -> Decimal | None:
        """A decimal. Never a float -- these become prices and quantities."""
        value = self.values.get(name)
        if value is None:
            return None
        if isinstance(value, Decimal):
            return value
        try:
            return Decimal(str(value))
        except (InvalidOperation, TypeError, ValueError):
            raise self._unusable(name, value, "a number") from None

    def percent(self, name: str) -> Decimal | None:
        """A percentage, refused if negative.

        A negative stop-loss percentage puts the stop on the wrong side of the
        entry, where it fills immediately.
        """
        value = self.number(name)
        if value is not None and value < 0:
            raise self._unusable(name, value, "a percentage at or above zero")
        return value

    def _unusable(self, name: str, value: object, wanted: str) -> DomainError:
        return DomainError(f"{self.strategy}: {name} is {value!r}, which is not {wanted}")


def resolve(
    strategy: str,
    layers: Iterable[ConfigLayer],
    *,
    tranche: int = 0,
    conditions: frozenset[DayCondition] = frozenset(),
) -> ResolvedConfig:
    """Merge every layer in scope, most specific value winning per field."""
    in_scope = [layer for layer in layers if layer.applies_to(tranche, conditions)]
    ordered = _most_specific_first(in_scope)

    merged: dict[str, object] = {}
    for layer in reversed(ordered):
        # Broadest first, so a more specific layer overwrites what a broader
        # one set. Iterating the other way would need a presence check per
        # field and get it wrong exactly once.
        merged.update(layer.values)

    return ResolvedConfig(strategy=strategy, values=merged, layers=tuple(ordered))


def _most_specific_first(layers: Sequence[ConfigLayer]) -> tuple[ConfigLayer, ...]:
    """Order by priority, then by day condition, so the result is stable.

    Two layers can share a priority -- a strategy configured for both ``E`` and
    ``TH`` on a day that is both -- and which of them wins would otherwise
    depend on the order rows came back from the database. That is a strategy
    whose behaviour changes when an index is rebuilt.
    """
    return tuple(
        sorted(
            layers,
            key=lambda layer: (
                -layer.priority,
                layer.day_condition.value if layer.day_condition else "",
            ),
        )
    )
