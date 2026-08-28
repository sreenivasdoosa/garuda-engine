"""Intents.

What an evaluator emits. **Not an order** -- an intent carries no quantity and
no price, because sizing is the engine's job, not a strategy's. That separation
is what lets the same strategy run on two accounts with different capital, and
what lets it be tested without a broker.

The engine turns an intent into one or more orders: sized, risk-gated, sliced
if the exchange freeze limit demands it, and routed to whichever broker the
subscription names.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, OrderType, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Money


class IntentKind(StrEnum):
    ENTER = "ENTER"
    EXIT = "EXIT"


class LegRole(StrEnum):
    """What a leg is for.

    A combo's legs are coordinated by role: a main leg exiting pulls its hedge,
    and a hedge exiting leaves the main unprotected -- which is a decision the
    operator makes rather than one the engine assumes.
    """

    MAIN = "MAIN"
    HEDGE = "HEDGE"
    PROTECTIVE = "PROTECTIVE"


@dataclass(frozen=True, slots=True)
class Intent:
    """A strategy's decision, before the engine gives it a size."""

    kind: IntentKind
    strategy: str
    trading_client: TradingClientId
    instrument: InstrumentId
    direction: Direction
    product: ProductType
    #: Ties this intent to the orders, fills and exit that follow from it, so a
    #: decision can be reconstructed end to end months later.
    correlation_id: str
    role: LegRole = LegRole.MAIN
    order_type: OrderType = OrderType.MARKET
    limit_price: Money | None = None
    #: Size relative to the main leg. A hedge at half the main leg's size is
    #: ratio 1/2, expressed as a numerator and denominator so it stays exact.
    ratio_numerator: int = 1
    ratio_denominator: int = 1
    reason: str | None = None

    def __post_init__(self) -> None:
        if not self.strategy:
            raise DomainError("an intent must name its strategy")
        if not self.correlation_id:
            raise DomainError(f"{self.strategy}: an intent must carry a correlation id")
        if self.ratio_numerator < 1 or self.ratio_denominator < 1:
            raise DomainError(
                f"{self.strategy}: leg ratio "
                f"{self.ratio_numerator}/{self.ratio_denominator} must be positive"
            )
        needs_price = self.order_type in (OrderType.LIMIT, OrderType.SL_LIMIT)
        if needs_price and self.limit_price is None:
            raise DomainError(f"{self.strategy}: a {self.order_type} intent needs a limit price")
        if not needs_price and self.limit_price is not None:
            raise DomainError(f"{self.strategy}: a {self.order_type} intent takes no limit price")

    @property
    def is_entry(self) -> bool:
        return self.kind is IntentKind.ENTER

    @property
    def is_exit(self) -> bool:
        return self.kind is IntentKind.EXIT
