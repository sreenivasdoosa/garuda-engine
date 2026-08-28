"""Exact monetary arithmetic.

Every amount in this engine is a :class:`decimal.Decimal`. A ``float`` in a
money or price path is a defect, and the constructor raises rather than
silently accepting one -- binary floating point cannot represent 0.1, so it
cannot represent a paisa.

Arithmetic between different currencies raises. Conversion happens only at an
explicit reporting boundary, with a named rate source and timestamp recorded
alongside the result.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from enum import StrEnum
from typing import Final

from garuda.domain.errors import CurrencyMismatchError, FloatInMoneyPathError

#: Rounding used whenever an amount is reduced to a currency's minor units.
#: Stated here rather than left to the ambient Decimal context, which any
#: caller could change.
MONEY_ROUNDING: Final = ROUND_HALF_UP


class Currency(StrEnum):
    """ISO 4217 currencies the engine knows about."""

    INR = "INR"
    USD = "USD"
    EUR = "EUR"
    GBP = "GBP"
    JPY = "JPY"
    AED = "AED"
    SGD = "SGD"
    HKD = "HKD"
    AUD = "AUD"

    @property
    def minor_units(self) -> int:
        """Decimal places in the currency's minor unit. Yen has none."""
        return _MINOR_UNITS.get(self, 2)


_MINOR_UNITS: Final[dict[Currency, int]] = {Currency.JPY: 0}

Numeric = Decimal | int | str


def to_decimal(value: Numeric) -> Decimal:
    """Coerce to Decimal, refusing float and bool.

    ``int`` and ``str`` convert exactly, so both are accepted. ``float`` never
    is: ``Decimal(0.1)`` is 0.1000000000000000055511151231257827, and one such
    value anywhere upstream of a P&L figure makes that figure wrong in a way
    that is very hard to trace back.
    """
    if isinstance(value, bool):
        raise FloatInMoneyPathError("bool is not a monetary amount")
    if isinstance(value, float):
        raise FloatInMoneyPathError(
            f"float {value!r} cannot be used as a monetary amount; "
            f'pass a Decimal or a string, e.g. Decimal("{value}")'
        )
    if isinstance(value, Decimal):
        return value
    return Decimal(value)


@dataclass(frozen=True, slots=True)
class Money:
    """An exact amount in a single currency."""

    amount: Decimal
    currency: Currency

    def __post_init__(self) -> None:
        amount = to_decimal(self.amount)
        if not amount.is_finite():
            raise FloatInMoneyPathError(f"{amount} is not a finite monetary amount")
        object.__setattr__(self, "amount", amount)

    # -- construction -------------------------------------------------------

    @classmethod
    def of(cls, value: Numeric, currency: Currency) -> Money:
        return cls(to_decimal(value), currency)

    @classmethod
    def zero(cls, currency: Currency) -> Money:
        return cls(Decimal(0), currency)

    # -- invariants ---------------------------------------------------------

    def _same_currency(self, other: Money) -> None:
        if self.currency is not other.currency:
            raise CurrencyMismatchError(
                f"cannot combine {self.currency} and {other.currency}; "
                "convert explicitly at a reporting boundary"
            )

    # -- arithmetic ---------------------------------------------------------

    def __add__(self, other: Money) -> Money:
        self._same_currency(other)
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        self._same_currency(other)
        return Money(self.amount - other.amount, self.currency)

    def __mul__(self, factor: Numeric) -> Money:
        return Money(self.amount * to_decimal(factor), self.currency)

    __rmul__ = __mul__

    def __truediv__(self, divisor: Numeric) -> Money:
        return Money(self.amount / to_decimal(divisor), self.currency)

    def ratio_to(self, other: Money) -> Decimal:
        """This amount as a fraction of another in the same currency."""
        self._same_currency(other)
        return self.amount / other.amount

    def __neg__(self) -> Money:
        return Money(-self.amount, self.currency)

    def __abs__(self) -> Money:
        return Money(abs(self.amount), self.currency)

    # -- ordering -----------------------------------------------------------

    def __lt__(self, other: Money) -> bool:
        self._same_currency(other)
        return self.amount < other.amount

    def __le__(self, other: Money) -> bool:
        self._same_currency(other)
        return self.amount <= other.amount

    def __gt__(self, other: Money) -> bool:
        self._same_currency(other)
        return self.amount > other.amount

    def __ge__(self, other: Money) -> bool:
        self._same_currency(other)
        return self.amount >= other.amount

    # -- presentation -------------------------------------------------------

    def quantized(self) -> Money:
        """Reduce to the currency's minor units, rounding half up.

        Call this at a display or settlement boundary, never during
        accumulation -- rounding a running P&L on every fill compounds the
        error instead of containing it.
        """
        exponent = Decimal(1).scaleb(-self.currency.minor_units)
        return Money(self.amount.quantize(exponent, rounding=MONEY_ROUNDING), self.currency)

    @property
    def is_zero(self) -> bool:
        return self.amount == 0

    @property
    def is_negative(self) -> bool:
        return self.amount < 0

    def __str__(self) -> str:
        return f"{self.quantized().amount} {self.currency.value}"

    def __repr__(self) -> str:
        return f"Money({self.amount!s}, {self.currency.value})"
