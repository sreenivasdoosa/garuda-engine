"""Turning capital into lots.

Sizing is engine-owned. A strategy says what it wants to do; how much of it
happens is a function of the capital allocated to that strategy on that
account, which is why the same strategy trades one lot on one client and ten
on another.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from typing import Protocol, runtime_checkable

from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.money import Money


@dataclass(frozen=True, slots=True)
class AllocationRequest:
    """What an allocator is given."""

    instrument: Instrument
    price: Money
    #: Capital allocated to this strategy on this account.
    capital: Money
    #: Distance to the stop, when the strategy has one. Risk-aware allocators
    #: need it; others ignore it.
    stop_distance: Money | None = None

    def __post_init__(self) -> None:
        if self.price.amount <= 0:
            raise DomainError(f"{self.instrument.id}: cannot size against price {self.price}")
        if self.capital.currency is not self.price.currency:
            raise DomainError(
                f"{self.instrument.id}: capital is {self.capital.currency}, "
                f"price is {self.price.currency}"
            )

    @property
    def cost_per_lot(self) -> Money:
        """What one lot costs at this price."""
        return self.instrument.notional(self.price, self.instrument.lot_size)


@runtime_checkable
class LotAllocator(Protocol):
    """Decides how many lots to trade. Never negative; zero means do nothing."""

    def __call__(self, request: AllocationRequest) -> int: ...


@dataclass(frozen=True, slots=True)
class FixedLotAllocator:
    """A configured number of lots, regardless of capital.

    The simplest thing that works, and what most operators start with.
    """

    lots: int

    def __post_init__(self) -> None:
        if self.lots < 0:
            raise DomainError(f"fixed allocation of {self.lots} lots is negative")

    def __call__(self, request: AllocationRequest) -> int:  # noqa: ARG002
        return self.lots


@dataclass(frozen=True, slots=True)
class CapitalLotAllocator:
    """As many whole lots as the allocated capital affords.

    Rounds down, always. Rounding up would put on a position the account
    cannot fund, and the broker would reject it after the rest of the combo
    had already gone on.
    """

    #: Fraction of the allocated capital to deploy, e.g. 0.5 to hold half back.
    utilisation: Decimal = Decimal(1)

    def __post_init__(self) -> None:
        if not (0 < self.utilisation <= 1):
            raise DomainError(f"utilisation {self.utilisation} must be within (0, 1]")

    def __call__(self, request: AllocationRequest) -> int:
        deployable = request.capital * self.utilisation
        cost = request.cost_per_lot
        if cost.amount <= 0:  # pragma: no cover - the request refuses this
            return 0
        return int(deployable.ratio_to(cost).to_integral_value(rounding=ROUND_DOWN))


@dataclass(frozen=True, slots=True)
class RiskAwareLotAllocator:
    """Sizes so that being stopped out costs a fixed fraction of capital.

    The position is whatever size makes the distance to the stop equal the risk
    budget. A wider stop means a smaller position, which is the point: risk per
    trade stays constant while the market's volatility does not.

    Falls back to nothing when the strategy has no stop, rather than guessing
    one -- a risk-aware allocator with an invented stop is not risk-aware.
    """

    risk_fraction: Decimal = Decimal("0.02")

    def __post_init__(self) -> None:
        if not (0 < self.risk_fraction <= 1):
            raise DomainError(f"risk fraction {self.risk_fraction} must be within (0, 1]")

    def __call__(self, request: AllocationRequest) -> int:
        stop_distance = request.stop_distance
        if stop_distance is None or stop_distance.amount <= 0:
            return 0
        budget = request.capital * self.risk_fraction
        risk_per_lot = request.instrument.notional(stop_distance, request.instrument.lot_size)
        if risk_per_lot.amount <= 0:  # pragma: no cover - guarded above
            return 0
        return int(budget.ratio_to(risk_per_lot).to_integral_value(rounding=ROUND_DOWN))
