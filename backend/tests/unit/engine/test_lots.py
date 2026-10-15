"""Capital to lots, the reference's arithmetic.

Every division rounds down, a tranche's share comes from the sequential
allocator, and a day at 0% trades nothing.
"""

from __future__ import annotations

import pytest

from garuda.domain.errors import DomainError
from garuda.engine.daycondition import DayCondition
from garuda.engine.lots import DayAllocation, LotInputs, allocated_lots, sequential_allocation


class TestSequentialAllocation:
    def test_whole_sets_first_then_the_remainder_from_tranche_one(self) -> None:
        assert sequential_allocation([2, 1, 1], 11) == [6, 3, 2]

    def test_exactly_one_set(self) -> None:
        assert sequential_allocation([1, 1, 1], 3) == [1, 1, 1]

    def test_fewer_lots_than_the_pattern_fills_early_tranches(self) -> None:
        assert sequential_allocation([1, 1, 1], 2) == [1, 1, 0]
        assert sequential_allocation([3, 1], 2) == [2, 0]

    def test_no_lots_means_zero_everywhere(self) -> None:
        assert sequential_allocation([1, 2], 0) == [0, 0]

    def test_an_all_zero_pattern_splits_evenly(self) -> None:
        assert sequential_allocation([0, 0, 0], 7) == [3, 2, 2]

    def test_a_negative_base_is_refused(self) -> None:
        with pytest.raises(DomainError):
            sequential_allocation([1, -1], 4)


def inputs(**overrides: object) -> LotInputs:
    values: dict[str, object] = {
        "tranche": 1,
        "allocation_tranches": (1, 2, 3),
        "base_lots": (1, 1, 1),
        "configured_lots": 1,
        "capital": 600000,
        "capital_per_lot": 100000,
    }
    values.update(overrides)
    return LotInputs(**values)  # type: ignore[arg-type]


class TestAllocatedLots:
    def test_capital_spreads_across_the_tranches(self) -> None:
        assert [allocated_lots(inputs(tranche=n)).lots for n in (1, 2, 3)] == [2, 2, 2]

    def test_capital_rounds_down(self) -> None:
        assert allocated_lots(inputs(capital=650000)).lots == 2  # 6 lots, 2 each
        assert allocated_lots(inputs(capital=99999, tranche=1)).lots == 0

    def test_no_tranche_rows_trades_the_configured_lots(self) -> None:
        decision = allocated_lots(inputs(allocation_tranches=(), base_lots=(), configured_lots=3))
        assert decision.lots == 3
        assert "as configured" in decision.because

    def test_no_capital_per_lot_trades_the_configured_lots(self) -> None:
        assert allocated_lots(inputs(capital_per_lot=None, configured_lots=2)).lots == 2

    def test_day_and_event_percentages_compound_and_floor(self) -> None:
        # 6 lots, 50% day -> 3, 50% event -> 1 (floor of 1.5); tranche 1 of [1,1,1] gets 1
        decision = allocated_lots(inputs(day_percentage=50, event_day_percentage=50))
        assert decision.lots == 1
        assert "day allocation 50%" in decision.because
        assert "event day 50%" in decision.because

    def test_zero_percent_trades_nothing(self) -> None:
        assert allocated_lots(inputs(day_percentage=0)).lots == 0
        assert allocated_lots(inputs(event_day_percentage=0)).lots == 0

    def test_adaptive_gives_every_lot_to_the_tranche(self) -> None:
        assert allocated_lots(inputs(adaptive=True, tranche=2)).lots == 6

    def test_a_tranche_outside_the_allocation_gets_nothing(self) -> None:
        assert allocated_lots(inputs(tranche=4)).lots == 0

    def test_a_percentage_outside_the_range_is_refused(self) -> None:
        with pytest.raises(DomainError):
            allocated_lots(inputs(day_percentage=150))


class TestDayAllocation:
    def test_expiry_beats_dt1_beats_dt2_beats_the_weekday(self) -> None:
        allocation = DayAllocation(thursday=80, expiry_day=40, dt1_day=60, dt2_day=70)
        both = frozenset({DayCondition.EXPIRY, DayCondition.THURSDAY})
        assert allocation.percentage_for(both) == 40
        assert allocation.percentage_for(frozenset({DayCondition.ONE_DAY_TO_EXPIRY})) == 60
        assert allocation.percentage_for(frozenset({DayCondition.TWO_DAYS_TO_EXPIRY})) == 70
        assert allocation.percentage_for(frozenset({DayCondition.THURSDAY})) == 80
        assert allocation.percentage_for(frozenset()) == 100
