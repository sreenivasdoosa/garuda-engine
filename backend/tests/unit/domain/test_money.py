"""Money arithmetic.

Property-based where the claim is universal ("no addition ever loses
precision"), example-based where a specific value is the point.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import given
from hypothesis import strategies as st

from garuda.domain import Currency, CurrencyMismatchError, FloatInMoneyPathError, Money

amounts = st.decimals(
    min_value=Decimal("-1e9"),
    max_value=Decimal("1e9"),
    allow_nan=False,
    allow_infinity=False,
    places=4,
)
currencies = st.sampled_from(list(Currency))


@st.composite
def money(draw: st.DrawFn, currency: Currency | None = None) -> Money:
    return Money(draw(amounts), currency or draw(currencies))


class TestExactness:
    @given(a=amounts, b=amounts)
    def test_addition_then_subtraction_returns_the_original_amount(self, a, b):
        """The round trip is exact. With floats it is not."""
        x, y = Money(a, Currency.INR), Money(b, Currency.INR)
        assert (x + y) - y == x

    @given(a=amounts, b=amounts)
    def test_addition_is_commutative(self, a, b):
        x, y = Money(a, Currency.INR), Money(b, Currency.INR)
        assert x + y == y + x

    @given(a=amounts, b=amounts, c=amounts)
    def test_addition_is_associative(self, a, b, c):
        x, y, z = (Money(v, Currency.INR) for v in (a, b, c))
        assert (x + y) + z == x + (y + z)

    def test_a_tenth_three_times_is_exactly_three_tenths(self):
        """0.1 + 0.1 + 0.1 == 0.3. In binary floating point it is not."""
        tenth = Money.of("0.10", Currency.INR)
        assert tenth + tenth + tenth == Money.of("0.30", Currency.INR)

    @given(m=money(Currency.INR), factor=st.integers(min_value=1, max_value=10_000))
    def test_multiply_then_divide_returns_the_original_amount(self, m, factor):
        assert (m * factor) / factor == m


class TestCurrencySafety:
    @pytest.mark.parametrize(
        "operation",
        [
            lambda a, b: a + b,
            lambda a, b: a - b,
            lambda a, b: a < b,
            lambda a, b: a >= b,
            lambda a, b: a.ratio_to(b),
        ],
    )
    def test_mixing_currencies_raises(self, operation):
        rupees = Money.of(100, Currency.INR)
        dollars = Money.of(100, Currency.USD)
        with pytest.raises(CurrencyMismatchError):
            operation(rupees, dollars)

    def test_equal_amounts_in_different_currencies_are_not_equal(self):
        assert Money.of(100, Currency.INR) != Money.of(100, Currency.USD)


class TestFloatRejection:
    @pytest.mark.parametrize("value", [0.1, 1.0, -3.5, 1e10])
    def test_constructing_from_a_float_raises(self, value):
        with pytest.raises(FloatInMoneyPathError):
            Money.of(value, Currency.INR)

    def test_multiplying_by_a_float_raises(self):
        with pytest.raises(FloatInMoneyPathError):
            Money.of(100, Currency.INR) * 1.5  # type: ignore[operator]

    def test_dividing_by_a_float_raises(self):
        with pytest.raises(FloatInMoneyPathError):
            Money.of(100, Currency.INR) / 1.5  # type: ignore[operator]

    def test_a_bool_is_not_an_amount(self):
        with pytest.raises(FloatInMoneyPathError):
            Money.of(True, Currency.INR)

    def test_an_integer_is_accepted_because_it_converts_exactly(self):
        assert Money.of(100, Currency.INR).amount == Decimal(100)


class TestQuantization:
    @given(m=money(Currency.INR))
    def test_quantizing_twice_is_the_same_as_once(self, m):
        assert m.quantized().quantized() == m.quantized()

    @given(m=money(Currency.INR))
    def test_quantizing_leaves_at_most_the_currency_minor_units(self, m):
        assert -m.quantized().amount.as_tuple().exponent <= Currency.INR.minor_units

    def test_yen_has_no_minor_units(self):
        assert Money.of("1234.56", Currency.JPY).quantized().amount == Decimal(1235)

    def test_rupees_round_half_up(self):
        assert Money.of("0.125", Currency.INR).quantized().amount == Decimal("0.13")

    def test_accumulation_is_not_rounded_along_the_way(self):
        """Rounding each fill compounds the error; rounding at the end contains it."""
        third = Money.of("0.3333", Currency.INR)
        total = third + third + third
        assert total.amount == Decimal("0.9999")
        assert total.quantized().amount == Decimal("1.00")


class TestSigns:
    @given(m=money(Currency.INR))
    def test_negating_twice_returns_the_original(self, m):
        negated = -m
        assert -negated == m

    @given(m=money(Currency.INR))
    def test_absolute_value_is_never_negative(self, m):
        assert not abs(m).is_negative

    def test_zero_is_zero(self):
        assert Money.zero(Currency.INR).is_zero
