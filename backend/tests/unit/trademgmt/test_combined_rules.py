"""Where a group of legs gets out, taken together.

The worked example throughout is the one in `docs/TRADE_MANAGEMENT.md`: a
short call at 150 and a short put at 120, equal size, 270 taken in. A 10%
combined stop is 27 against that, so the position comes out when closing it
would cost 297, and a 10% target is the mirror at 243.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

import pytest

from garuda.domain import Direction, Money
from garuda.domain.errors import DomainError
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.domain.trailing import GapUnit
from garuda.trademgmt.combined_rules import (
    CombinedDecision,
    CombinedOutcome,
    GroupLevels,
    PriceOf,
    combinable,
    evaluate,
    levels_of,
    net_premium,
    trailing_floor,
)

from .conftest import CALL, PUT, TODAY, a_trade, rupees

TEN_PERCENT = GroupLevels(stop_loss_percent=Decimal(10), target_percent=Decimal(10))


def filled(trade: Trade, quantity: int = 75, entry: str = "1") -> Trade:
    """A trade as it is once its entry has executed: ACTIVE, not OPEN."""
    return replace(trade, quantity=quantity).with_entry_fill(quantity, rupees(entry), TODAY)


def straddle() -> list[Trade]:
    """Two short legs of the same size. Entry premium 150 and 120."""
    return [
        filled(a_trade("t-call", instrument=CALL)),
        filled(a_trade("t-put", instrument=PUT, signal_id="sig-2")),
    ]


ENTRIES = {CALL: rupees("150"), PUT: rupees("120")}


def entry_of(trade: Trade) -> Money | None:
    return ENTRIES.get(trade.instrument)


def priced(**prices: str) -> PriceOf:
    """Current prices, by the tail of the instrument id."""
    table = {CALL: rupees(prices["call"]), PUT: rupees(prices["put"])}
    return lambda trade: table.get(trade.instrument)


# -- the net premium --------------------------------------------------------


def test_the_net_is_what_the_group_took_in() -> None:
    """Two shorts at 150 and 120, 75 units each: 270 points, 20,250 rupees."""
    assert net_premium(straddle(), entry_of) == rupees("20250")


def test_a_long_leg_pays_out_rather_than_takes_in() -> None:
    """A hedge reduces the net premium, which moves both levels. That is the
    reason it is counted rather than excused as negligible."""
    legs = [*straddle(), filled(a_trade("t-hedge", instrument=CALL, direction=Direction.LONG))]
    prices = {CALL: rupees("150"), PUT: rupees("120")}

    net = net_premium(legs, lambda trade: prices.get(trade.instrument))

    assert net == rupees("9000")  # (150 + 120 - 150) * 75


def test_a_leg_of_a_different_size_is_weighted_not_counted() -> None:
    """Points would silently misweight a hedge at half the ratio."""
    legs = [
        filled(a_trade("t-call", instrument=CALL)),
        filled(a_trade("t-hedge", instrument=PUT, direction=Direction.LONG), quantity=25),
    ]
    prices = {CALL: rupees("150"), PUT: rupees("120")}

    net = net_premium(legs, lambda trade: prices.get(trade.instrument))

    assert net == rupees("8250")  # 150 * 75 - 120 * 25


def test_a_leg_with_no_price_makes_the_whole_group_unpriceable() -> None:
    """A straddle valued on one side is not a smaller straddle, it is a number
    that would trip a stop."""
    assert (
        net_premium(
            straddle(),
            lambda trade: ENTRIES.get(trade.instrument) if trade.instrument == CALL else None,
        )
        is None
    )


# -- the levels -------------------------------------------------------------


def test_a_group_that_has_not_moved_holds() -> None:
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="150", put="120")
    )

    assert decision.outcome is CombinedOutcome.HOLD


def test_the_stop_fires_when_closing_would_cost_the_allowance() -> None:
    """297 to close against 270 taken in: down 27, which is the 10%."""
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="170", put="127")
    )

    assert decision.outcome is CombinedOutcome.STOP
    assert decision.exit_reason is TradeExitReason.GROUP_STOP_LOSS


def test_one_point_short_of_the_allowance_holds() -> None:
    """296 to close is down 26 against 270. The allowance is 27."""
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="170", put="126")
    )

    assert decision.outcome is CombinedOutcome.HOLD


def test_a_leg_far_past_its_own_stop_does_not_stop_the_group() -> None:
    """The reason combined levels exist. The call is at 200 against an entry
    of 150 -- a third against it, three times its own 10% stop -- while the
    put has collapsed to 65. Closing costs 265 against 270 taken in, so the
    group is ahead, and stopping either leg on its own premium would break up
    a position that is fine."""
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="200", put="65")
    )

    assert decision.outcome is CombinedOutcome.HOLD


def test_the_target_fires_when_closing_would_cost_that_much_less() -> None:
    """243 to close against 270 taken in: up 27."""
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="130", put="113")
    )

    assert decision.outcome is CombinedOutcome.TARGET
    assert decision.exit_reason is TradeExitReason.GROUP_TARGET


def test_a_stop_alone_never_reads_as_a_target() -> None:
    levels = GroupLevels(stop_loss_percent=Decimal(10))

    decision = evaluate(
        straddle(), levels, entry_of=entry_of, current_of=priced(call="100", put="100")
    )

    assert decision.outcome is CombinedOutcome.HOLD


def test_a_target_alone_never_reads_as_a_stop() -> None:
    levels = GroupLevels(target_percent=Decimal(10))

    decision = evaluate(
        straddle(), levels, entry_of=entry_of, current_of=priced(call="300", put="300")
    )

    assert decision.outcome is CombinedOutcome.HOLD


def test_nothing_configured_is_not_an_exit() -> None:
    decision = evaluate(
        straddle(), GroupLevels(), entry_of=entry_of, current_of=priced(call="900", put="900")
    )

    assert decision.outcome is CombinedOutcome.HOLD


# -- a debit group, where the naive arithmetic goes wrong -------------------


def debit_spread() -> list[Trade]:
    """Bought for 100 net: long the call at 150, short the far put at 50."""
    return [
        filled(a_trade("t-long", instrument=CALL, direction=Direction.LONG)),
        filled(a_trade("t-short", instrument=PUT, signal_id="sig-2")),
    ]


def debit_entry(trade: Trade) -> Money | None:
    return {CALL: rupees("150"), PUT: rupees("50")}.get(trade.instrument)


def test_a_debit_group_is_not_stopped_the_moment_it_opens() -> None:
    """Scaling a negative net by 1.1 moves the level the wrong way, and this
    position would come out at the price it was opened at."""
    decision = evaluate(debit_spread(), TEN_PERCENT, entry_of=debit_entry, current_of=debit_entry)

    assert decision.outcome is CombinedOutcome.HOLD


def test_a_debit_group_stops_when_it_has_lost_that_much_of_what_it_paid() -> None:
    """Paid 100, worth 90: down 10, which is the 10%."""
    decision = evaluate(
        debit_spread(),
        TEN_PERCENT,
        entry_of=debit_entry,
        current_of=priced(call="140", put="50"),
    )

    assert decision.outcome is CombinedOutcome.STOP


def test_a_debit_group_reaches_its_target_when_it_is_worth_that_much_more() -> None:
    decision = evaluate(
        debit_spread(),
        TEN_PERCENT,
        entry_of=debit_entry,
        current_of=priced(call="160", put="50"),
    )

    assert decision.outcome is CombinedOutcome.TARGET


# -- when the arithmetic cannot be done -------------------------------------


def test_a_leg_that_has_not_filled_leaves_the_group_unavailable() -> None:
    """Not HOLD. An operator reading "held all day" needs to know whether that
    was an answer or the absence of one."""
    decision = evaluate(
        straddle(),
        TEN_PERCENT,
        entry_of=lambda trade: None,
        current_of=priced(call="150", put="120"),
    )

    assert decision.outcome is CombinedOutcome.UNAVAILABLE


def test_a_missing_current_price_leaves_the_group_unavailable() -> None:
    decision = evaluate(straddle(), TEN_PERCENT, entry_of=entry_of, current_of=lambda trade: None)

    assert decision.outcome is CombinedOutcome.UNAVAILABLE


def test_legs_that_offset_exactly_have_nothing_to_measure() -> None:
    """A percentage of nothing is nothing, and a level at nothing exits at
    once, every time."""
    legs = [
        filled(a_trade("t-long", instrument=CALL, direction=Direction.LONG)),
        filled(a_trade("t-short", instrument=PUT, signal_id="sig-2")),
    ]
    same = lambda trade: rupees("100")  # noqa: E731

    decision = evaluate(legs, TEN_PERCENT, entry_of=same, current_of=same)

    assert decision.outcome is CombinedOutcome.UNAVAILABLE


def test_an_empty_group_holds() -> None:
    decision = evaluate([], TEN_PERCENT, entry_of=entry_of, current_of=entry_of)

    assert decision.outcome is CombinedOutcome.HOLD


# -- which legs count -------------------------------------------------------


def test_a_leg_on_its_way_out_is_no_longer_being_protected() -> None:
    leaving = replace(filled(a_trade("t-call")), exiting_for=TradeExitReason.SQUARE_OFF)

    assert not combinable(leaving)


def test_a_leg_still_waiting_to_fill_is_part_of_the_group() -> None:
    """Deliberately. It has no entry price, so the group comes back
    UNAVAILABLE rather than being valued on the legs that did fill -- a
    straddle with one side still resting is not a one-legged straddle."""
    assert combinable(a_trade("t-call"))


def test_a_group_with_a_leg_still_waiting_cannot_be_valued() -> None:
    legs = [filled(a_trade("t-call", instrument=CALL), entry="150"), a_trade("t-put")]

    decision = evaluate(
        legs,
        TEN_PERCENT,
        entry_of=lambda trade: trade.entry,
        current_of=priced(call="200", put="1"),
    )

    assert decision.outcome is CombinedOutcome.UNAVAILABLE


# -- which levels the group is on -------------------------------------------


def test_legs_agreeing_give_the_group_its_levels() -> None:
    protection = Protection(combined_stop_loss_percent=Decimal(10))
    legs = [replace(trade, protection=protection) for trade in straddle()]

    assert levels_of(legs) == GroupLevels(stop_loss_percent=Decimal(10))


def test_a_leg_without_levels_does_not_turn_the_group_off() -> None:
    """The book indexes by set, so "the first leg" is whichever iteration
    yielded. A hedge added without combined percentages would otherwise turn
    the group's stop off on some ticks and not others."""
    call, put = straddle()
    legs = [
        replace(call, protection=Protection(combined_stop_loss_percent=Decimal(10))),
        put,
    ]

    assert levels_of(legs) == GroupLevels(stop_loss_percent=Decimal(10))
    assert levels_of(list(reversed(legs))) == GroupLevels(stop_loss_percent=Decimal(10))


def test_legs_disagreeing_leave_the_group_with_no_level() -> None:
    """A real misconfiguration. Picking a winner would apply a stop nobody
    configured to half the legs."""
    call, put = straddle()
    legs = [
        replace(call, protection=Protection(combined_stop_loss_percent=Decimal(10))),
        replace(put, protection=Protection(combined_stop_loss_percent=Decimal(25))),
    ]

    assert levels_of(legs) is None


def test_no_leg_carrying_levels_is_simply_unconfigured() -> None:
    assert levels_of(straddle()) == GroupLevels()


def test_an_open_filled_leg_counts() -> None:
    assert combinable(filled(a_trade("t-call")))


def test_a_leg_that_has_already_closed_is_not_counted() -> None:
    """It is not held any more. Valuing it at the current price would measure
    a position the account does not have."""
    closed = filled(a_trade("t-call"), entry="150").closed(
        rupees("170"), TradeExitReason.STOP_LOSS, TODAY
    )

    assert not combinable(closed)


def test_a_group_is_valued_on_what_is_left_after_a_leg_closes() -> None:
    """The straddle's call was stopped out on its own level. What remains is
    the put, at 120 taken in, and the group's stop is 10% of that."""
    call = filled(a_trade("t-call", instrument=CALL), entry="150").closed(
        rupees("170"), TradeExitReason.STOP_LOSS, TODAY
    )
    put = filled(a_trade("t-put", instrument=PUT, signal_id="sig-2"), entry="120")
    legs = [leg for leg in (call, put) if combinable(leg)]

    decision = evaluate(
        legs,
        TEN_PERCENT,
        entry_of=lambda trade: trade.entry,
        current_of=priced(call="170", put="132"),
    )

    assert decision.outcome is CombinedOutcome.STOP


# -- the group's stop, moved by the group's own profit ----------------------

#: 10% of the 20,250 taken in is 2,025: one step of profit, and one step of
#: stop movement. Percentages of the group's premium, which is the reference
#: engine's default for this trail.
TRAILING = GroupLevels(
    stop_loss_percent=Decimal(10),
    target_percent=Decimal(50),
    trail_profit_gap=Decimal(10),
    trail_stop_move_gap=Decimal(10),
)


def at(call: str, put: str, high_water: str | None = None) -> CombinedDecision:
    return evaluate(
        straddle(),
        TRAILING,
        entry_of=entry_of,
        current_of=priced(call=call, put=put),
        high_water=rupees(high_water) if high_water is not None else None,
    )


def test_below_the_first_step_the_configured_stop_stands() -> None:
    """That is what makes it a trail rather than a second stop."""
    assert trailing_floor(rupees("20250"), TRAILING, rupees("2024")) is None


def test_one_step_earned_moves_the_stop_one_step() -> None:
    """Down 2,025 at the start; one step of 2,025 earned puts the floor at
    nothing, which is break even."""
    floor = trailing_floor(rupees("20250"), TRAILING, rupees("2025"))

    assert floor == rupees("0")


def test_two_steps_earned_puts_the_floor_in_profit() -> None:
    floor = trailing_floor(rupees("20250"), TRAILING, rupees("4050"))

    assert floor == rupees("2025")


def test_steps_are_whole_so_the_floor_does_not_jitter() -> None:
    """A stop that drifts on noise is one that fires on noise."""
    assert trailing_floor(rupees("20250"), TRAILING, rupees("4049")) == rupees("0")


def test_a_group_with_no_trail_configured_has_no_floor() -> None:
    assert trailing_floor(rupees("20250"), TEN_PERCENT, rupees("9999")) is None


def test_a_trail_with_no_fixed_stop_has_nothing_to_move() -> None:
    """The trail walks the configured level up rather than inventing one."""
    levels = GroupLevels(
        target_percent=Decimal(50),
        trail_profit_gap=Decimal(10),
        trail_stop_move_gap=Decimal(10),
    )

    assert not levels.is_trailing
    assert trailing_floor(rupees("20250"), levels, rupees("9999")) is None


def test_a_profit_gap_with_no_move_gap_never_moves_the_stop() -> None:
    """Half a trail is not a trail: nothing says how far the stop goes."""
    levels = GroupLevels(stop_loss_percent=Decimal(10), trail_profit_gap=Decimal(10))

    assert not levels.is_trailing
    assert trailing_floor(rupees("20250"), levels, rupees("9999")) is None


def test_a_move_gap_with_no_profit_gap_never_earns_a_step() -> None:
    """The other half: nothing says what earns the move."""
    levels = GroupLevels(stop_loss_percent=Decimal(10), trail_stop_move_gap=Decimal(10))

    assert not levels.is_trailing
    assert trailing_floor(rupees("20250"), levels, rupees("9999")) is None


def test_a_gap_in_money_rather_than_per_cent() -> None:
    """The reference's absolute mode: the gaps are rupees, not percentages of
    the premium."""
    levels = GroupLevels(
        stop_loss_percent=Decimal(10),
        trail_profit_gap=Decimal(1000),
        trail_stop_move_gap=Decimal(500),
        trail_unit=GapUnit.ABSOLUTE,
    )

    # Two whole steps of 1,000 earned, so the stop moves 1,000 off the 2,025.
    assert trailing_floor(rupees("20250"), levels, rupees("2500")) == rupees("-1025")


def test_a_trail_measured_in_risk_multiples_is_refused() -> None:
    """A multiple of the initial risk measures from a leg's entry to its first
    stop, and a group has neither."""
    with pytest.raises(DomainError):
        GroupLevels(
            stop_loss_percent=Decimal(10),
            trail_profit_gap=Decimal(1),
            trail_stop_move_gap=Decimal(1),
            trail_unit=GapUnit.RISK_MULTIPLE,
        )


def test_a_gap_of_nothing_is_refused() -> None:
    with pytest.raises(DomainError):
        GroupLevels(stop_loss_percent=Decimal(10), trail_profit_gap=Decimal(0))


# -- the trail in an evaluation --------------------------------------------


def test_a_group_that_has_earned_nothing_is_not_trailed() -> None:
    decision = at("150", "120")

    assert decision.outcome is CombinedOutcome.HOLD
    assert decision.high_water == rupees("0")


def test_the_high_water_mark_rises_with_the_group() -> None:
    """Carried back rather than kept, so the caller can put it on the legs."""
    decision = at("140", "110")

    assert decision.result == rupees("1500")
    assert decision.high_water == rupees("1500")


def test_the_high_water_mark_never_falls() -> None:
    decision = at("150", "120", high_water="5000")

    assert decision.result == rupees("0")
    assert decision.high_water == rupees("5000")


def test_giving_back_a_gain_past_the_trailed_floor_exits() -> None:
    """Up 2,025 at its best, so the floor is break even. Back to a loss and
    the group comes out on the trail, well inside the fixed stop."""
    decision = at("152", "122", high_water="2025")

    assert decision.outcome is CombinedOutcome.TRAIL_STOP
    assert decision.exit_reason is TradeExitReason.GROUP_STOP_LOSS


def test_sitting_exactly_on_the_trailed_floor_exits() -> None:
    """A floor is a level the group may not be at, the same way its stop is.
    One step earned puts the floor at break even; back to exactly break even
    and it comes out."""
    decision = at("150", "120", high_water="2025")

    assert decision.result == rupees("0")
    assert decision.outcome is CombinedOutcome.TRAIL_STOP


def test_a_group_only_ever_in_loss_remembers_no_gain() -> None:
    """The watermark floors at nothing, which is what the reference means by
    starting it at zero rather than at the first reading. A negative one would
    be written to the legs and persisted for no purpose."""
    decision = at("160", "130")

    assert decision.result == rupees("-1500")
    assert decision.high_water == rupees("0")


def test_holding_above_the_trailed_floor_stays_in() -> None:
    decision = at("145", "118", high_water="2025")

    assert decision.outcome is CombinedOutcome.HOLD


def test_the_fixed_stop_is_checked_before_the_trailed_one() -> None:
    """A group past its configured stop is out on that, whatever the trail
    says -- which is the order the reference checks them in."""
    decision = at("170", "127", high_water="2025")

    assert decision.outcome is CombinedOutcome.STOP


def test_the_trail_is_checked_before_the_target() -> None:
    """A group walking away from its target is out on the trail rather than
    left to run at it."""
    levels = GroupLevels(
        stop_loss_percent=Decimal(10),
        target_percent=Decimal(1),
        trail_profit_gap=Decimal(10),
        trail_stop_move_gap=Decimal(20),
    )
    # The floor after one step is +2,025, and the target is only 202.50, so
    # both are true at once and the trail has to win.
    decision = evaluate(
        straddle(),
        levels,
        entry_of=entry_of,
        current_of=priced(call="140", put="118"),
        high_water=rupees("2100"),
    )

    assert decision.outcome is CombinedOutcome.TRAIL_STOP


def test_a_group_with_no_trail_still_reports_no_high_water() -> None:
    """Nothing to remember, so nothing is written back to the legs."""
    decision = evaluate(
        straddle(), TEN_PERCENT, entry_of=entry_of, current_of=priced(call="140", put="110")
    )

    assert decision.high_water is None
