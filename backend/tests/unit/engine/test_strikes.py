"""Choosing a strike."""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.engine.strikes import Moneyness, atm_strike, strike_for

GAP = Decimal(50)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


# -- reading a configured value ---------------------------------------------


@pytest.mark.parametrize(
    ("text", "steps"),
    [
        ("ATM", 0),
        ("atm", 0),
        (" ATM ", 0),
        ("OTM", 1),
        ("OTM1", 1),
        ("OTM+1", 1),
        ("OTM +2", 2),
        ("ITM", -1),
        ("ITM1", -1),
        ("ITM+1", -1),
        ("ITM+2", -2),
    ],
)
def test_a_configured_strike_value_is_read(text: str, steps: int) -> None:
    assert Moneyness.parse(text).steps == steps


def test_a_signed_count_is_refused_rather_than_guessed_at() -> None:
    """The reference resolves ITM-1 to one strike *out* of the money, which is
    the opposite side of at-the-money from what it says. Picking either
    reading silently puts a leg on the wrong side at a different premium."""
    with pytest.raises(DomainError, match="ambiguous"):
        Moneyness.parse("ITM-1")


def test_the_refusal_names_both_readings() -> None:
    with pytest.raises(DomainError, match=r"ITM\+1.*or OTM\+1"):
        Moneyness.parse("ITM-1")


def test_a_signed_otm_is_refused_the_same_way() -> None:
    with pytest.raises(DomainError, match="ambiguous"):
        Moneyness.parse("OTM-2")


@pytest.mark.parametrize("text", ["", "   ", "NEAR", "ATM+1", "DEEP OTM", "OTM+"])
def test_something_that_is_not_a_strike_value_is_refused(text: str) -> None:
    with pytest.raises(DomainError):
        Moneyness.parse(text)


def test_a_moneyness_reads_back_as_it_was_written() -> None:
    assert str(Moneyness.parse("OTM+2")) == "OTM+2"
    assert str(Moneyness.parse("ITM+1")) == "ITM+1"
    assert str(Moneyness.parse("ATM")) == "ATM"


# -- at the money -----------------------------------------------------------


@pytest.mark.parametrize(
    ("spot", "expected"),
    [
        ("25000", 25000),
        ("25010", 25000),
        ("25024.99", 25000),
        ("25025", 25050),
        ("25040", 25050),
        ("24999", 25000),
    ],
)
def test_the_nearest_listed_strike(spot: str, expected: int) -> None:
    assert atm_strike(rupees(spot), GAP) == Decimal(expected)


def test_a_tie_always_goes_the_same_way() -> None:
    """At-the-money must be a stable choice: the same spot must always name
    the same strike, however the number happens to fall."""
    assert atm_strike(rupees("25025"), GAP) == Decimal(25050)
    assert atm_strike(rupees("25075"), GAP) == Decimal(25100)


def test_a_hundred_point_gap_rounds_to_hundreds() -> None:
    assert atm_strike(rupees("25040"), Decimal(100)) == Decimal(25000)
    assert atm_strike(rupees("25060"), Decimal(100)) == Decimal(25100)


def test_a_gap_of_nothing_cannot_space_strikes() -> None:
    with pytest.raises(DomainError, match="cannot space strikes"):
        atm_strike(rupees("25000"), Decimal(0))


# -- which strike a leg wants -----------------------------------------------


def test_at_the_money_is_the_same_strike_for_both_sides() -> None:
    at_money = Moneyness(0)

    call = strike_for(at_money, OptionType.CALL, spot=rupees("25010"), gap=GAP)
    put = strike_for(at_money, OptionType.PUT, spot=rupees("25010"), gap=GAP)

    assert call == put == Decimal(25000)


def test_out_of_the_money_is_above_for_a_call_and_below_for_a_put() -> None:
    """Which is why one signed number serves both, and why a strangle's legs
    sit either side of the money rather than together."""
    two_out = Moneyness.parse("OTM+2")

    call = strike_for(two_out, OptionType.CALL, spot=rupees("25000"), gap=GAP)
    put = strike_for(two_out, OptionType.PUT, spot=rupees("25000"), gap=GAP)

    assert call == Decimal(25100)
    assert put == Decimal(24900)


def test_in_the_money_is_the_other_way_round() -> None:
    one_in = Moneyness.parse("ITM+1")

    call = strike_for(one_in, OptionType.CALL, spot=rupees("25000"), gap=GAP)
    put = strike_for(one_in, OptionType.PUT, spot=rupees("25000"), gap=GAP)

    assert call == Decimal(24950)
    assert put == Decimal(25050)


def test_a_call_in_the_money_is_below_the_spot() -> None:
    """The definition, and the check that the sign is not inverted."""
    spot = rupees("25000")

    strike = strike_for(Moneyness.parse("ITM+1"), OptionType.CALL, spot=spot, gap=GAP)

    assert strike < spot.amount


def test_a_call_out_of_the_money_is_above_the_spot() -> None:
    spot = rupees("25000")

    strike = strike_for(Moneyness.parse("OTM+1"), OptionType.CALL, spot=spot, gap=GAP)

    assert strike > spot.amount


def test_a_put_out_of_the_money_is_below_the_spot() -> None:
    spot = rupees("25000")

    strike = strike_for(Moneyness.parse("OTM+1"), OptionType.PUT, spot=spot, gap=GAP)

    assert strike < spot.amount


def test_the_offset_is_measured_from_the_nearest_strike_not_the_spot() -> None:
    """Spot 25040 is at-the-money 25050, so one out is 25100 and not 25090."""
    strike = strike_for(Moneyness.parse("OTM+1"), OptionType.CALL, spot=rupees("25040"), gap=GAP)

    assert strike == Decimal(25100)
