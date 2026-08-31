"""Option pricing, and the volatility implied by a price.

Pinned to textbook values. Everything downstream reads these numbers as
percentages an operator compares against a screen, so being close is not the
same as being right.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.marketdata.pricing import (
    MAX_VOLATILITY,
    black_scholes,
    implied_volatility,
    intrinsic,
    normal_cdf,
    years_to_expiry,
)

RATE = Decimal("0.05")


def near(value: Decimal | None, expected: str, places: str = "0.0001") -> bool:
    assert value is not None
    return abs(value - Decimal(expected)) < Decimal(places)


# -- the normal distribution ------------------------------------------------


def test_the_distribution_is_a_half_at_the_middle() -> None:
    assert near(normal_cdf(Decimal(0)), "0.5")


def test_the_published_value_at_one_point_nine_six() -> None:
    """The one every table has, because it is the two-tailed 5% point."""
    assert near(normal_cdf(Decimal("1.96")), "0.975002")


def test_the_distribution_is_symmetric_about_zero() -> None:
    """The approximation is only defined on the positive side, so the negative
    side is reflected — and getting the reflection wrong puts every put price
    on the wrong side of its call."""
    assert near(normal_cdf(Decimal(-1)), "0.158655")
    assert near(normal_cdf(Decimal(-1)) + normal_cdf(Decimal(1)), "1")


def test_the_far_tails_are_nearly_certain() -> None:
    assert normal_cdf(Decimal(5)) > Decimal("0.9999")
    assert normal_cdf(Decimal(-5)) < Decimal("0.0001")


# -- pricing ----------------------------------------------------------------


def test_a_call_matches_the_textbook() -> None:
    """Spot 100, strike 100, a year, 5% and 20% volatility."""
    price = black_scholes(
        option_type=OptionType.CALL,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        volatility=Decimal("0.2"),
        rate=RATE,
    )

    assert near(price, "10.4506")


def test_a_put_matches_the_textbook() -> None:
    price = black_scholes(
        option_type=OptionType.PUT,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        volatility=Decimal("0.2"),
        rate=RATE,
    )

    assert near(price, "5.5735")


def test_put_call_parity_holds() -> None:
    """Call minus put equals spot minus the discounted strike. If it does not,
    one of the two is wrong and the synthetic future built on it is wrong."""
    common = {
        "spot": Decimal(100),
        "strike": Decimal(95),
        "years": Decimal("0.5"),
        "volatility": Decimal("0.25"),
        "rate": RATE,
    }
    call = black_scholes(option_type=OptionType.CALL, **common)
    put = black_scholes(option_type=OptionType.PUT, **common)

    discounted = Decimal(95) * (-RATE * Decimal("0.5")).exp()
    assert near(call - put, str(Decimal(100) - discounted))


def test_no_time_left_leaves_only_what_it_is_worth_exercised() -> None:
    """The model degenerates at expiry, and pretending otherwise prices a
    contract with no time as though it had some."""
    price = black_scholes(
        option_type=OptionType.CALL,
        spot=Decimal(110),
        strike=Decimal(100),
        years=Decimal(0),
        volatility=Decimal("0.2"),
    )

    assert price == Decimal(10)


def test_no_volatility_leaves_only_what_it_is_worth_exercised() -> None:
    price = black_scholes(
        option_type=OptionType.PUT,
        spot=Decimal(90),
        strike=Decimal(100),
        years=Decimal(1),
        volatility=Decimal(0),
    )

    assert price == Decimal(10)


def test_an_option_on_nothing_is_not_priceable() -> None:
    with pytest.raises(DomainError, match="not priceable"):
        black_scholes(
            option_type=OptionType.CALL,
            spot=Decimal(0),
            strike=Decimal(100),
            years=Decimal(1),
            volatility=Decimal("0.2"),
        )


# -- what an option is worth exercised --------------------------------------


def test_an_option_out_of_the_money_is_worth_nothing_exercised() -> None:
    """Never below nothing: an option is a right, not an obligation, and a
    negative intrinsic value would make a worthless option a liability."""
    assert intrinsic(OptionType.CALL, spot=Decimal(90), strike=Decimal(100)) == Decimal(0)
    assert intrinsic(OptionType.PUT, spot=Decimal(110), strike=Decimal(100)) == Decimal(0)


def test_an_option_in_the_money_is_worth_the_difference() -> None:
    assert intrinsic(OptionType.CALL, spot=Decimal(110), strike=Decimal(100)) == Decimal(10)
    assert intrinsic(OptionType.PUT, spot=Decimal(90), strike=Decimal(100)) == Decimal(10)


# -- solving ----------------------------------------------------------------


def test_the_volatility_a_price_was_made_with_is_recovered() -> None:
    """The round trip that says the model and the solver agree."""
    price = black_scholes(
        option_type=OptionType.CALL,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        volatility=Decimal("0.2"),
        rate=RATE,
    )

    implied = implied_volatility(
        option_type=OptionType.CALL,
        price=price,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        rate=RATE,
    )

    assert near(implied, "0.2", "0.000001")


def test_a_put_solves_as_readily_as_a_call() -> None:
    price = black_scholes(
        option_type=OptionType.PUT,
        spot=Decimal(100),
        strike=Decimal(105),
        years=Decimal("0.25"),
        volatility=Decimal("0.35"),
        rate=RATE,
    )

    implied = implied_volatility(
        option_type=OptionType.PUT,
        price=price,
        spot=Decimal(100),
        strike=Decimal(105),
        years=Decimal("0.25"),
        rate=RATE,
    )

    assert near(implied, "0.35", "0.000001")


def test_a_price_at_intrinsic_implies_nothing() -> None:
    """There is nothing left for volatility to account for."""
    implied = implied_volatility(
        option_type=OptionType.CALL,
        price=Decimal(10),
        spot=Decimal(110),
        strike=Decimal(100),
        years=Decimal(1),
    )

    assert implied is None


def test_a_price_no_volatility_could_explain_implies_nothing() -> None:
    """Above what the widest volatility the solver considers would produce.
    Answering the ceiling would be answering noise precisely."""
    beyond = black_scholes(
        option_type=OptionType.CALL,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        volatility=MAX_VOLATILITY,
        rate=RATE,
    ) * Decimal("1.01")

    implied = implied_volatility(
        option_type=OptionType.CALL,
        price=beyond,
        spot=Decimal(100),
        strike=Decimal(100),
        years=Decimal(1),
        rate=RATE,
    )

    assert implied is None


@pytest.mark.parametrize(
    ("price", "years"),
    [(Decimal(0), Decimal(1)), (Decimal(-1), Decimal(1)), (Decimal(5), Decimal(0))],
)
def test_a_price_or_a_life_of_nothing_implies_nothing(price: Decimal, years: Decimal) -> None:
    implied = implied_volatility(
        option_type=OptionType.CALL,
        price=price,
        spot=Decimal(100),
        strike=Decimal(100),
        years=years,
    )

    assert implied is None


# -- time -------------------------------------------------------------------


def test_a_year_is_counted_in_calendar_days() -> None:
    """An option decays over the weekend, as anyone holding one over a long
    weekend has noticed."""
    assert years_to_expiry(Decimal(365)) == Decimal(1)
    assert near(years_to_expiry(Decimal(30)), "0.0821918")


@pytest.mark.parametrize(
    ("spot", "strike"), [(Decimal(0), Decimal(100)), (Decimal(100), Decimal(0))]
)
def test_an_unpriceable_option_answers_nothing_rather_than_raising(
    spot: Decimal, strike: Decimal
) -> None:
    """Pricing one raises, and rightly. Solving for one must not: this answers
    a caller asking what a price implies, and the answer is "nothing" — a
    stale instrument master should not take a sweep down with it."""
    implied = implied_volatility(
        option_type=OptionType.CALL,
        price=Decimal(5),
        spot=spot,
        strike=strike,
        years=Decimal(1),
    )

    assert implied is None
