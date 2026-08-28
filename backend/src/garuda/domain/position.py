"""Positions, folded from fills.

A position is never mutated. Each fill produces a new position, which is what
lets the same sequence of journalled fills be replayed to the same state --
the property the whole recovery and replay story rests on.

Realized P&L accumulates unrounded. Rounding on each fill compounds the error
across a sliced entry instead of containing it; the rounding happens once, at
a reporting boundary.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from garuda.domain.enums import Direction
from garuda.domain.errors import CurrencyMismatchError, DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.order import Fill, Side


@dataclass(frozen=True, slots=True)
class Position:
    """A net position in one instrument.

    ``quantity`` is signed: positive is long, negative is short, zero is flat.
    ``average_price`` is the entry price of the open quantity, and is zero
    whenever the position is flat.
    """

    instrument: InstrumentId
    currency: Currency
    quantity: int
    average_price: Money
    realized_pnl: Money
    multiplier: Decimal = Decimal(1)

    @classmethod
    def flat(
        cls,
        instrument: InstrumentId,
        currency: Currency,
        multiplier: Decimal = Decimal(1),
    ) -> Position:
        """A position with nothing in it. The starting point of every fold."""
        zero = Money.zero(currency)
        return cls(
            instrument=instrument,
            currency=currency,
            quantity=0,
            average_price=zero,
            realized_pnl=zero,
            multiplier=multiplier,
        )

    def __post_init__(self) -> None:
        for name, money in (
            ("average price", self.average_price),
            ("realized P&L", self.realized_pnl),
        ):
            if money.currency is not self.currency:
                raise CurrencyMismatchError(
                    f"{self.instrument}: {name} is {money.currency}, position is {self.currency}"
                )
        if self.quantity == 0 and not self.average_price.is_zero:
            raise DomainError(f"{self.instrument}: a flat position has no average price")
        if self.multiplier <= 0:
            raise DomainError(f"{self.instrument}: multiplier must be positive")

    # -- state --------------------------------------------------------------

    @property
    def is_flat(self) -> bool:
        return self.quantity == 0

    @property
    def is_long(self) -> bool:
        return self.quantity > 0

    @property
    def is_short(self) -> bool:
        return self.quantity < 0

    @property
    def direction(self) -> Direction | None:
        if self.quantity == 0:
            return None
        return Direction.LONG if self.quantity > 0 else Direction.SHORT

    # -- valuation ----------------------------------------------------------

    def unrealized_pnl(self, mark: Money) -> Money:
        """Open P&L at a mark price. Zero when flat, whatever the mark."""
        if mark.currency is not self.currency:
            raise CurrencyMismatchError(
                f"{self.instrument}: mark is {mark.currency}, position is {self.currency}"
            )
        if self.quantity == 0:
            return Money.zero(self.currency)
        return (mark - self.average_price) * Decimal(self.quantity) * self.multiplier

    def total_pnl(self, mark: Money) -> Money:
        return self.realized_pnl + self.unrealized_pnl(mark)

    def exposure(self, mark: Money) -> Money:
        """Absolute contract value at a mark price."""
        return abs(mark * Decimal(self.quantity) * self.multiplier)

    # -- the fold -----------------------------------------------------------

    def apply(self, fill: Fill) -> Position:
        """Fold one fill in, returning the resulting position.

        Three cases, and the third is the one that gets written wrongly:

        1. **Opening or adding** — the average price moves to the
           quantity-weighted mean. Nothing is realized.
        2. **Reducing or closing** — P&L is realized on the closed quantity at
           the existing average. The average of what remains does not change.
        3. **Crossing through zero** — the whole existing position is closed
           and realized, and the remainder opens *at the fill price*, not at a
           blend of the two. Treating this as a simple reduction produces a
           position with a nonsensical average and a P&L that never reconciles.
        """
        if fill.instrument != self.instrument:
            raise DomainError(f"{self.instrument}: fill is for {fill.instrument}")
        if fill.price.currency is not self.currency:
            raise CurrencyMismatchError(
                f"{self.instrument}: fill is {fill.price.currency}, position is {self.currency}"
            )

        signed = fill.quantity * fill.side.sign
        new_quantity = self.quantity + signed

        opening_or_adding = self.quantity == 0 or (self.quantity > 0) == (signed > 0)

        if opening_or_adding:
            value = self.average_price * Decimal(abs(self.quantity)) + fill.price * Decimal(
                fill.quantity
            )
            average = value / Decimal(abs(new_quantity))
            realized = self.realized_pnl
        else:
            closed = min(abs(signed), abs(self.quantity))
            gain_per_unit = (
                fill.price - self.average_price
                if self.quantity > 0
                else self.average_price - fill.price
            )
            realized = self.realized_pnl + gain_per_unit * Decimal(closed) * self.multiplier

            if new_quantity == 0:
                average = Money.zero(self.currency)
            elif abs(signed) < abs(self.quantity):
                average = self.average_price  # a reduction leaves the rest untouched
            else:
                average = fill.price  # crossed through zero; the remainder is new

        return Position(
            instrument=self.instrument,
            currency=self.currency,
            quantity=new_quantity,
            average_price=average,
            realized_pnl=realized,
            multiplier=self.multiplier,
        )

    def apply_all(self, fills: Iterable[Fill]) -> Position:
        """Fold a sequence of fills. Equivalent to applying each in turn."""
        position = self
        for fill in fills:
            position = position.apply(fill)
        return position

    def __str__(self) -> str:
        if self.is_flat:
            return f"{self.instrument} flat"
        return f"{self.instrument} {self.quantity:+d} @ {self.average_price}"


def opening_side(direction: Direction) -> Side:
    """The side that opens a position in a given direction."""
    return Side.BUY if direction is Direction.LONG else Side.SELL
