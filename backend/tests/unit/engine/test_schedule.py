"""The day's tranche times, and the strategy state that remembers firings."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.engine.schedule import TrancheSchedule
from garuda.engine.strategy_state import StrategyState

IST = ZoneInfo("Asia/Kolkata")
DAY = dt.date(2026, 10, 15)


def at(hour: int, minute: int, second: int = 0) -> dt.datetime:
    return dt.datetime.combine(DAY, dt.time(hour, minute, second), IST)


def build(now: dt.datetime) -> TrancheSchedule:
    return TrancheSchedule.build(
        DAY,
        IST,
        {
            "straddle": [(1, "09:20", None), (2, "10:00", "11:00"), (3, None, None)],
            "strangle": [(1, "09:20", None)],
        },
        now=now,
    )


class TestTheSchedule:
    def test_a_tranche_without_a_time_is_not_scheduled_and_says_why(self) -> None:
        schedule = build(at(9, 0))
        assert len(schedule.slots) == 3
        (unscheduled,) = schedule.unscheduled
        assert (unscheduled.strategy, unscheduled.tranche) == ("straddle", 3)

    def test_tranches_come_due_at_their_time_and_fire_once(self) -> None:
        schedule = build(at(9, 0))
        assert schedule.due(at(9, 19, 59)) == []
        due = schedule.due(at(9, 20))
        assert {(slot.strategy, slot.tranche) for slot in due} == {("straddle", 1), ("strangle", 1)}
        assert schedule.due(at(9, 20, 1)) == []
        assert [slot.tranche for slot in schedule.due(at(10, 0, 5))] == [2]
        assert schedule.pending == []

    def test_a_time_past_when_the_day_is_built_is_missed_not_fired(self) -> None:
        schedule = build(at(9, 45))
        assert {slot.key for slot in schedule.missed} == {("straddle", 1), ("strangle", 1)}
        assert [slot.tranche for slot in schedule.due(at(10, 0))] == [2]

    def test_catch_up_re_times_missed_tranches_a_minute_apart(self) -> None:
        schedule = build(at(10, 30))
        retimed = schedule.catch_up("straddle", at(10, 30))
        assert [(slot.tranche, slot.at) for slot in retimed] == [(1, at(10, 30)), (2, at(10, 31))]
        assert [slot.tranche for slot in schedule.due(at(10, 31))] == [1, 2]

    def test_catch_up_leaves_signalled_and_cut_off_tranches_alone(self) -> None:
        schedule = build(at(11, 30))
        retimed = schedule.catch_up("straddle", at(11, 30), skip={1})
        assert retimed == []  # tranche 1 signalled, tranche 2 past its 11:00 cutoff

    def test_a_timing_that_is_not_a_time_is_refused(self) -> None:
        with pytest.raises(DomainError, match="not a time"):
            TrancheSchedule.build(DAY, IST, {"s": [(1, "nine", None)]}, now=at(9, 0))


class TestStrategyState:
    def state(self) -> StrategyState:
        return StrategyState(TradingClientId("appa"), "straddle", DAY)

    def test_a_tranche_signals_once(self) -> None:
        state = self.state().tranche_signalled(1, at(9, 20), signals=4, lots=2)
        assert state.has_signalled(1)
        assert (state.signals_generated_today, state.allocated_lots_today) == (4, 2)
        with pytest.raises(DomainError, match="already signalled"):
            state.tranche_signalled(1, at(9, 21), signals=4, lots=2)

    def test_signalling_is_critical_and_evaluating_is_not(self) -> None:
        before = self.state()
        assert not before.evaluated(at(9, 20)).critical_change(before)
        assert before.tranche_signalled(1, at(9, 20), signals=1, lots=1).critical_change(before)

    def test_it_round_trips_through_its_stored_shape(self) -> None:
        state = self.state().tranche_signalled(2, at(10, 0), signals=2, lots=3)
        state = StrategyState(
            **{**state.__dict__, "used_risk": Decimal("1250.50"), "data": {"fixed": {"n": 1}}}
        )
        back = StrategyState.from_json(TradingClientId("appa"), "straddle", DAY, state.to_json())
        assert back.signalled == {2: at(10, 0)}
        assert back.used_risk == Decimal("1250.50")
        assert back.data == {"fixed": {"n": 1}}
        assert back.last_tranche_signalled == 2
