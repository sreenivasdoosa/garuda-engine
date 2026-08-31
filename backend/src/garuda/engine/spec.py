"""Strategy specifications.

A strategy is **data**, not a subclass. What varies between strategies -- what
is traded and which way, how direction is decided, how many legs there are, how
each leg picks its instrument -- are independent axes, and single inheritance
can express one of them. So they live here as a validated spec, and one
evaluator reads it.

A single-leg strategy is a combo with one leg. There is no separate combo type
to inherit from, because ``N = 1`` is not special.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol, runtime_checkable

from garuda.domain.enums import Direction, OrderType, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.engine.selectors import InstrumentSelector

#: Default cap on legs in one spec. A hedged iron condor is exactly eight,
#: which is why this is a setting rather than a constant.
DEFAULT_MAX_LEGS = 8

#: The ceiling the setting itself cannot exceed. Well short of what a venue
#: like CME allows in a user-defined spread, and deliberately so: this engine
#: is not built for forty-leg structures.
MAX_LEGS_CEILING = 16


class SideRule(StrEnum):
    """How a leg's direction relates to the strategy's signal.

    This is where "sell options" and "buy options" live. They are not modes,
    not templates and not subclasses -- they are a field on a leg.
    """

    SAME_AS_SIGNAL = "SAME_AS_SIGNAL"
    OPPOSITE = "OPPOSITE"
    ALWAYS_LONG = "ALWAYS_LONG"
    ALWAYS_SHORT = "ALWAYS_SHORT"

    def resolve(self, signal: Direction) -> Direction:
        match self:
            case SideRule.SAME_AS_SIGNAL:
                return signal
            case SideRule.OPPOSITE:
                return signal.opposite
            case SideRule.ALWAYS_LONG:
                return Direction.LONG
            case SideRule.ALWAYS_SHORT:
                return Direction.SHORT


@dataclass(frozen=True, slots=True)
class LegSpec:
    """One leg of a strategy."""

    selector: InstrumentSelector
    side: SideRule
    role: LegRole = LegRole.MAIN
    product: ProductType = ProductType.NRML
    order_type: OrderType = OrderType.MARKET
    ratio_numerator: int = 1
    ratio_denominator: int = 1
    #: Entry order. Exits reverse it by default, so a hedge that goes on first
    #: comes off last.
    sequence: int = 0

    def __post_init__(self) -> None:
        if self.ratio_numerator < 1 or self.ratio_denominator < 1:
            raise DomainError(
                f"leg ratio {self.ratio_numerator}/{self.ratio_denominator} must be positive"
            )
        if self.sequence < 0:
            raise DomainError(f"leg sequence {self.sequence} is negative")


@dataclass(frozen=True, slots=True)
class FixedDirection:
    """Always the same way. The simplest direction rule there is."""

    direction: Direction

    def resolve(self, context: object) -> Direction | None:  # noqa: ARG002
        return self.direction


@runtime_checkable
class DirectionProvider(Protocol):
    """Decides which way the strategy leans, or None to stand aside."""

    def resolve(self, context: object) -> Direction | None: ...


@dataclass(frozen=True)
class StrategySpec:
    """A whole strategy, as data."""

    name: str
    underlying: InstrumentId
    direction: DirectionProvider
    legs: tuple[LegSpec, ...]
    max_legs: int = DEFAULT_MAX_LEGS

    def __post_init__(self) -> None:
        if not self.name:
            raise DomainError("a strategy spec must be named")
        if not self.legs:
            raise DomainError(f"{self.name}: a strategy with no legs does nothing")
        if self.max_legs > MAX_LEGS_CEILING:
            raise DomainError(
                f"{self.name}: max_legs {self.max_legs} exceeds the ceiling of {MAX_LEGS_CEILING}"
            )
        if len(self.legs) > self.max_legs:
            raise DomainError(
                f"{self.name}: {len(self.legs)} legs exceeds the limit of {self.max_legs}"
            )
        if self.has_hedge and not self.has_main:
            raise DomainError(f"{self.name}: a hedge leg with no main leg protects nothing")

    @property
    def has_main(self) -> bool:
        return any(leg.role is LegRole.MAIN for leg in self.legs)

    @property
    def has_hedge(self) -> bool:
        return any(leg.role is LegRole.HEDGE for leg in self.legs)

    @property
    def entry_order(self) -> tuple[LegSpec, ...]:
        """Legs in the order they go on. Hedges first when sequenced that way."""
        return tuple(sorted(self.legs, key=lambda leg: leg.sequence))

    @property
    def exit_order(self) -> tuple[LegSpec, ...]:
        """The reverse of entry, unless a leg says otherwise."""
        return tuple(reversed(self.entry_order))
