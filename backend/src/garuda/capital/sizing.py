"""Sizing an intent.

Turns "go long this instrument" into a concrete quantity, and then into the
one-or-more orders the exchange will actually accept.

Slicing lives here rather than in the order manager because it is a sizing
decision: an entry above the exchange freeze limit is not one big order, it is
several. By the time the risk gate sees a request, the freeze check should
never trip -- if it does, sizing has a bug, which is exactly what that check is
there to catch.
"""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction

from garuda.capital.allocation import AllocationRequest, LotAllocator
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.intent import Intent
from garuda.domain.money import Money


@dataclass(frozen=True, slots=True)
class Sizing:
    """The result. ``slices`` is what actually gets sent."""

    lots: int
    quantity: int
    slices: tuple[int, ...]
    notional: Money
    refusal: str | None = None

    @property
    def is_tradable(self) -> bool:
        return self.quantity > 0 and self.refusal is None

    @property
    def order_count(self) -> int:
        return len(self.slices)


def slice_for_freeze_limit(quantity: int, instrument: Instrument) -> tuple[int, ...]:
    """Split a quantity into exchange-acceptable orders.

    Every slice is a whole number of lots. A freeze limit that is not itself a
    multiple of the lot size rounds **down** to one: sending a part-lot would be
    rejected, and rounding up would breach the limit the slicing exists to
    respect.
    """
    if quantity <= 0:
        return ()
    if quantity % instrument.lot_size:
        raise DomainError(
            f"{instrument.id}: {quantity} is not a whole number of "
            f"{instrument.lot_size}-unit lots; the exchange would reject it, so a "
            "quantity that reaches slicing unaligned is a sizing defect"
        )
    limit = instrument.freeze_quantity
    if limit is None or quantity <= limit:
        return (quantity,)

    lot_size = instrument.lot_size
    per_slice = (limit // lot_size) * lot_size
    if per_slice <= 0:
        raise DomainError(
            f"{instrument.id}: freeze limit {limit} is below one lot of {lot_size}; "
            "no order of this instrument can be placed"
        )

    slices: list[int] = []
    remaining = quantity
    while remaining > per_slice:
        slices.append(per_slice)
        remaining -= per_slice
    slices.append(remaining)
    return tuple(slices)


class Sizer:
    """Sizes intents using a configured allocator."""

    def __init__(self, allocator: LotAllocator, *, max_lots: int | None = None) -> None:
        if max_lots is not None and max_lots < 0:
            raise DomainError(f"max_lots of {max_lots} is negative")
        self._allocator = allocator
        self._max_lots = max_lots

    def size(
        self,
        intent: Intent,
        instrument: Instrument,
        price: Money,
        capital: Money,
        *,
        stop_distance: Money | None = None,
    ) -> Sizing:
        if intent.instrument != instrument.id:
            raise DomainError(
                f"{intent.strategy}: intent is for {intent.instrument}, "
                f"sizing against {instrument.id}"
            )

        request = AllocationRequest(
            instrument=instrument,
            price=price,
            capital=capital,
            stop_distance=stop_distance,
        )
        lots = self._allocator(request)
        if lots < 0:  # pragma: no cover - allocators are documented not to
            raise DomainError(f"{intent.strategy}: allocator returned {lots} lots")

        lots = self._apply_leg_ratio(lots, intent)
        if self._max_lots is not None:
            lots = min(lots, self._max_lots)

        if lots == 0:
            return Sizing(
                lots=0,
                quantity=0,
                slices=(),
                notional=Money.zero(price.currency),
                refusal=(
                    f"capital {capital} affords no whole lot of "
                    f"{instrument.trading_symbol} at {price}"
                ),
            )

        quantity = instrument.lots_to_quantity(lots)
        return Sizing(
            lots=lots,
            quantity=quantity,
            slices=slice_for_freeze_limit(quantity, instrument),
            notional=instrument.notional(price, quantity),
        )

    @staticmethod
    def _apply_leg_ratio(lots: int, intent: Intent) -> int:
        """Scale a leg against the main leg, rounding down.

        Exact rational arithmetic, not float: a hedge at one third of eleven
        lots is three, and a float would make that a question about binary
        representation rather than about trading.
        """
        ratio = Fraction(intent.ratio_numerator, intent.ratio_denominator)
        if ratio == 1:
            return lots
        return int(Fraction(lots) * ratio)
