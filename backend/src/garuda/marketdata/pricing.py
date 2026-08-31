"""Option pricing, and the volatility implied by a price.

Black-Scholes for European options, which is what index options here are.
Nothing prices an American option, and nothing should pretend to.

**In Decimal, not float.** Not because a volatility is money — it is not — but
because a recorded day has to replay identically, and a solver that iterates
on floats can land on a different last bit under a different build. The normal
distribution has no closed form in either, so it uses a rational approximation
good to about eight decimal places, which is four more than anyone reads.

**Solved by bisection.** Newton's method converges faster and diverges near
expiry, where vega goes to nothing and the correction it divides by is noise.
An option about to expire is exactly when a wrong number does the most damage,
so the slower method that cannot diverge is the right one — and fifty halvings
of a bracket is not slow.
"""

from __future__ import annotations

from decimal import Decimal, getcontext
from enum import StrEnum

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError

#: Enough precision that the approximations are the limit, not the arithmetic.
_PRECISION = 34

#: Coefficients of Abramowitz and Stegun 26.2.17, the standard rational
#: approximation to the normal distribution.
_P = Decimal("0.2316419")
_B = (
    Decimal("0.319381530"),
    Decimal("-0.356563782"),
    Decimal("1.781477937"),
    Decimal("-1.821255978"),
    Decimal("1.330274429"),
)

ONE = Decimal(1)
TWO = Decimal(2)
HALF = Decimal("0.5")

#: The widest volatility the solver will consider. An option implying more
#: than this is mispriced, illiquid, or being quoted at a stub price, and
#: answering 40 would be answering noise precisely.
MAX_VOLATILITY = Decimal(5)

#: The narrowest. Below it a price is indistinguishable from intrinsic value.
MIN_VOLATILITY = Decimal("0.0001")

#: How many halvings. Fifty takes a bracket of five down to about 4e-15.
BISECTIONS = 50

#: Days in a year, for turning a date difference into the fraction Black and
#: Scholes wants. Calendar days, not trading days: an option decays over the
#: weekend, as anyone holding one over a long weekend has noticed.
DAYS_IN_YEAR = Decimal(365)


class Moneyness(StrEnum):
    """Where an option sits relative to the money."""

    IN = "IN"
    AT = "AT"
    OUT = "OUT"


def normal_cdf(value: Decimal) -> Decimal:
    """The standard normal distribution function.

    Symmetric about zero and evaluated on the positive side, because the
    approximation is only defined there.
    """
    getcontext().prec = _PRECISION
    if value < 0:
        return ONE - normal_cdf(-value)

    t = ONE / (ONE + _P * value)
    polynomial = Decimal(0)
    for power, coefficient in enumerate(_B, start=1):
        polynomial += coefficient * t**power
    density = (-value * value / TWO).exp() / (TWO * _pi()).sqrt()
    return ONE - density * polynomial


def _pi() -> Decimal:
    return Decimal("3.14159265358979323846264338327950288")


def black_scholes(
    *,
    option_type: OptionType,
    spot: Decimal,
    strike: Decimal,
    years: Decimal,
    volatility: Decimal,
    rate: Decimal = Decimal("0.065"),
) -> Decimal:
    """What the model says an option is worth."""
    getcontext().prec = _PRECISION
    if spot <= 0 or strike <= 0:
        raise DomainError(f"an option on {spot} at {strike} is not priceable")
    if years <= 0 or volatility <= 0:
        # At or past expiry, or with no volatility, the model degenerates to
        # what the option is worth if exercised now.
        return intrinsic(option_type, spot=spot, strike=strike)

    spread = volatility * years.sqrt()
    d1 = ((spot / strike).ln() + (rate + volatility * volatility / TWO) * years) / spread
    d2 = d1 - spread
    discounted = strike * (-rate * years).exp()

    if option_type is OptionType.CALL:
        return spot * normal_cdf(d1) - discounted * normal_cdf(d2)
    return discounted * normal_cdf(-d2) - spot * normal_cdf(-d1)


def intrinsic(option_type: OptionType, *, spot: Decimal, strike: Decimal) -> Decimal:
    """What the option is worth exercised now, which is never below nothing."""
    difference = spot - strike if option_type is OptionType.CALL else strike - spot
    return max(difference, Decimal(0))


def implied_volatility(
    *,
    option_type: OptionType,
    price: Decimal,
    spot: Decimal,
    strike: Decimal,
    years: Decimal,
    rate: Decimal = Decimal("0.065"),
) -> Decimal | None:
    """The volatility that would produce this price, or None.

    None when the price cannot be explained by any volatility: at or below
    intrinsic value there is nothing left for volatility to account for, and
    above the widest the solver considers the quote is not a price anyone
    traded at.
    """
    getcontext().prec = _PRECISION
    if price <= 0 or spot <= 0 or strike <= 0 or years <= 0:
        return None
    if price <= intrinsic(option_type, spot=spot, strike=strike):
        return None

    def priced(volatility: Decimal) -> Decimal:
        return black_scholes(
            option_type=option_type,
            spot=spot,
            strike=strike,
            years=years,
            volatility=volatility,
            rate=rate,
        )

    low, high = MIN_VOLATILITY, MAX_VOLATILITY
    if priced(high) < price:
        # Beyond anything the model can explain at a sane volatility.
        return None

    for _ in range(BISECTIONS):
        middle = (low + high) / TWO
        if priced(middle) < price:
            low = middle
        else:
            high = middle
    return (low + high) / TWO


def years_to_expiry(days: Decimal) -> Decimal:
    """Calendar days as the fraction of a year the model wants."""
    return days / DAYS_IN_YEAR
