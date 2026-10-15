"""Where a hedge goes.

The reference's `HedgeOffsetInstrumentResolver.hedgeStrike`, ported with its
arithmetic intact:

1. the distance is a percentage of the **strike being hedged**, truncated to a
   whole number of points -- further out for a call, further in for a put;
2. the result is snapped to the nearest listed strike;
3. when the distance is at least the strategy's rounding threshold, it is
   rounded again to the symbol's coarser hedge multiple, so wide hedges land
   on the round strikes that carry the liquidity.

Decimal throughout. The reference truncates with an int cast and snaps by
integer remainder; both are reproduced exactly rather than approximated.
"""

from __future__ import annotations

from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError

HUNDRED = Decimal(100)


def nearest_strike(price: Decimal, gap: Decimal) -> Decimal:
    """The reference's `Utils.getNearestStrikePrice`.

    Truncates the price to a whole number first, then rounds half up to the
    gap: a remainder of exactly half the gap goes up.
    """
    if gap <= 0:
        raise DomainError(f"a strike gap of {gap} cannot space strikes")
    whole = price.to_integral_value(rounding=ROUND_DOWN)
    remainder = whole % gap
    if remainder < gap / 2:
        return whole - remainder
    return whole + (gap - remainder)


def hedge_strike(
    reference_strike: Decimal,
    distance_percent: Decimal,
    option_type: OptionType,
    *,
    strike_gap: Decimal,
    rounding_multiple: Decimal | None = None,
    rounding_min_distance: Decimal | None = None,
) -> Decimal:
    """The strike protecting ``reference_strike``, ``distance_percent`` away."""
    if distance_percent <= 0:
        raise DomainError(f"a hedge {distance_percent}% away does not protect anything")
    offset = (reference_strike * distance_percent / HUNDRED).to_integral_value(rounding=ROUND_DOWN)
    raw = reference_strike + offset if option_type is OptionType.CALL else reference_strike - offset
    strike = nearest_strike(raw, strike_gap)
    if (
        rounding_multiple is not None
        and rounding_multiple > 0
        and rounding_min_distance is not None
        and distance_percent >= rounding_min_distance
    ):
        strike = (strike / rounding_multiple).quantize(Decimal(1), rounding=ROUND_HALF_UP) * (
            rounding_multiple
        )
    if strike <= 0:
        raise DomainError(
            f"a {distance_percent}% hedge on the {reference_strike} {option_type} lands at {strike}"
        )
    return strike
