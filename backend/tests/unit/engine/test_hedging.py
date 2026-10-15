"""Where a hedge goes, by the reference's arithmetic."""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.engine.hedging import hedge_strike, nearest_strike


def test_nearest_strike_truncates_then_rounds_half_up() -> None:
    assert nearest_strike(Decimal("22524.9"), Decimal(50)) == Decimal(22500)
    assert nearest_strike(Decimal("22525.4"), Decimal(50)) == Decimal(22550)
    assert nearest_strike(Decimal(22550), Decimal(50)) == Decimal(22550)


def test_a_call_hedge_is_further_up_and_a_put_hedge_further_down() -> None:
    # 4% of 22500 is 900: call 23400, put 21600, both on the 50 grid.
    assert (
        hedge_strike(Decimal(22500), Decimal(4), OptionType.CALL, strike_gap=Decimal(50)) == 23400
    )
    assert hedge_strike(Decimal(22500), Decimal(4), OptionType.PUT, strike_gap=Decimal(50)) == 21600


def test_the_offset_is_truncated_before_snapping() -> None:
    # 1% of 22550 is 225.5 -> 225 -> 22775 -> nearest 50 is 22800 (remainder 25 rounds up).
    assert (
        hedge_strike(Decimal(22550), Decimal(1), OptionType.CALL, strike_gap=Decimal(50)) == 22800
    )


def test_wide_hedges_round_to_the_coarser_multiple() -> None:
    at = hedge_strike(
        Decimal(22500),
        Decimal(4),
        OptionType.CALL,
        strike_gap=Decimal(50),
        rounding_multiple=Decimal(500),
        rounding_min_distance=Decimal(3),
    )
    assert at == Decimal(23500)


def test_narrow_hedges_keep_the_strike_gap() -> None:
    at = hedge_strike(
        Decimal(22500),
        Decimal(1),
        OptionType.CALL,
        strike_gap=Decimal(50),
        rounding_multiple=Decimal(500),
        rounding_min_distance=Decimal(3),
    )
    assert at == Decimal(22725) or at == Decimal(22750)
    assert at % Decimal(50) == 0


def test_a_zero_distance_is_refused() -> None:
    with pytest.raises(DomainError):
        hedge_strike(Decimal(22500), Decimal(0), OptionType.CALL, strike_gap=Decimal(50))
