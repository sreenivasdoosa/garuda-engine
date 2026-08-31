"""The trade model and its state machine.

Every claim is about a transition that must or must not be allowed, or about
arithmetic that decides what a position is worth.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.trade import (
    CorporateActionState,
    IllegalTradeTransitionError,
    Protection,
    Trade,
    TradeId,
)
from garuda.domain.trade_state import (
    TradeExitReason,
    TradeState,
    exit_priority,
    more_urgent,
)

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
LATER = T0 + timedelta(hours=2)
CLIENT = TradingClientId("appa-zerodha")
CALL = InstrumentId("NFO:NIFTY26AUG25000CE")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_trade(
    *,
    quantity: int = 75,
    direction: Direction = Direction.LONG,
    multiplier: Decimal = Decimal(1),
) -> Trade:
    return Trade(
        id=TradeId("t-1"),
        trading_client=CLIENT,
        instrument=CALL,
        strategy="straddle",
        direction=direction,
        product=ProductType.NRML,
        quantity=quantity,
        contract_multiplier=multiplier,
    )


class TestTheStateMachine:
    def test_a_new_trade_is_open_with_nothing_at_risk(self) -> None:
        trade = a_trade()
        assert trade.state is TradeState.OPEN
        assert trade.is_live
        assert trade.filled_quantity == 0
        assert trade.entry is None

    def test_the_first_fill_makes_it_active(self) -> None:
        """OPEN and ACTIVE are different situations: one has money at risk."""
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        assert trade.state is TradeState.ACTIVE
        assert trade.entry == rupees("120")
        assert trade.started_at == T0

    def test_an_unfilled_trade_can_be_cancelled(self) -> None:
        trade = a_trade().cancelled(TradeExitReason.ENTRY_FAILED, T0, "the broker refused")
        assert trade.state is TradeState.CANCELLED
        assert trade.failure_reason == "the broker refused"

    def test_a_filled_trade_cannot_be_cancelled(self) -> None:
        """Something executed, so there is a position. A position is closed."""
        trade = a_trade().with_entry_fill(25, rupees("120"), T0)
        with pytest.raises(IllegalTradeTransitionError, match="25 units filled"):
            trade.cancelled(TradeExitReason.ENTRY_FAILED, LATER)

    def test_the_machine_itself_refuses_active_to_cancelled(self) -> None:
        """Not only the guard on the cancel path: the transition is not legal,
        so no future caller can reach it another way."""
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        assert not trade.can_become(TradeState.CANCELLED)
        assert trade.can_become(TradeState.COMPLETED)

    def test_an_open_trade_may_cancel_but_not_complete(self) -> None:
        trade = a_trade()
        assert trade.can_become(TradeState.CANCELLED)
        assert not trade.can_become(TradeState.COMPLETED)

    def test_an_active_trade_completes(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        trade = trade.closed(rupees("135"), TradeExitReason.TARGET, LATER)
        assert trade.state is TradeState.COMPLETED
        assert trade.exit_reason is TradeExitReason.TARGET
        assert trade.ended_at == LATER

    def test_an_open_trade_cannot_complete_without_filling(self) -> None:
        with pytest.raises(IllegalTradeTransitionError):
            a_trade().closed(rupees("135"), TradeExitReason.TARGET, LATER)

    def test_a_completed_trade_goes_nowhere(self) -> None:
        """A later frame claiming otherwise was overtaken in flight."""
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        trade = trade.closed(rupees("135"), TradeExitReason.TARGET, LATER)
        with pytest.raises(IllegalTradeTransitionError):
            trade.closed(rupees("140"), TradeExitReason.SQUARE_OFF, LATER)

    def test_a_terminal_trade_cannot_fill(self) -> None:
        trade = a_trade().cancelled(TradeExitReason.ENTRY_FAILED, T0)
        with pytest.raises(IllegalTradeTransitionError, match="filled after"):
            trade.with_entry_fill(75, rupees("120"), LATER)

    def test_a_terminal_trade_must_say_why(self) -> None:
        with pytest.raises(DomainError, match="without a reason"):
            Trade(
                id=TradeId("t-1"),
                trading_client=CLIENT,
                instrument=CALL,
                strategy="s",
                direction=Direction.LONG,
                product=ProductType.NRML,
                quantity=75,
                state=TradeState.COMPLETED,
            )


class TestFilling:
    def test_fills_accumulate_into_a_weighted_average(self) -> None:
        """A sliced entry is normal above a freeze limit."""
        trade = a_trade(quantity=100)
        trade = trade.with_entry_fill(25, rupees("120"), T0)
        trade = trade.with_entry_fill(75, rupees("124"), T0)

        assert trade.filled_quantity == 100
        assert trade.entry == rupees("123")

    def test_the_average_is_not_rounded_per_fill(self) -> None:
        """Rounding each one compounds the error across the entry."""
        trade = a_trade(quantity=3)
        for price in ("100", "100", "101"):
            trade = trade.with_entry_fill(1, rupees(price), T0)
        assert trade.entry is not None
        assert trade.entry.amount == Decimal(301) / Decimal(3)

    def test_a_partial_fill_leaves_it_active_and_partly_filled(self) -> None:
        trade = a_trade().with_entry_fill(25, rupees("120"), T0)
        assert trade.is_active
        assert trade.filled_quantity == 25
        assert trade.open_quantity == 25

    def test_filling_more_than_ordered_is_refused(self) -> None:
        trade = a_trade(quantity=75).with_entry_fill(50, rupees("120"), T0)
        with pytest.raises(DomainError, match="above the 75 ordered"):
            trade.with_entry_fill(50, rupees("120"), T0)

    def test_the_start_time_is_the_first_fill_not_the_last(self) -> None:
        trade = a_trade(quantity=100).with_entry_fill(50, rupees("120"), T0)
        trade = trade.with_entry_fill(50, rupees("121"), LATER)
        assert trade.started_at == T0

    def test_a_reloaded_trade_keeps_the_time_it_actually_started(self) -> None:
        """After a restart the trade is rebuilt with the moment it began, and
        the next fill must not restamp it as though it started today."""
        from dataclasses import replace as dataclass_replace

        trade = dataclass_replace(a_trade(quantity=100), started_at=T0)
        trade = trade.with_entry_fill(50, rupees("120"), LATER)
        assert trade.started_at == T0


class TestWhatAPositionIsWorth:
    def test_a_long_gains_when_the_price_rises(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        assert trade.pnl_at(rupees("130")) == rupees("750")

    def test_a_short_gains_when_the_price_falls(self) -> None:
        trade = a_trade(direction=Direction.SHORT).with_entry_fill(75, rupees("120"), T0)
        assert trade.pnl_at(rupees("110")) == rupees("750")

    def test_a_short_loses_when_the_price_rises(self) -> None:
        trade = a_trade(direction=Direction.SHORT).with_entry_fill(75, rupees("120"), T0)
        assert trade.pnl_at(rupees("130")) == rupees("-750")

    def test_the_contract_multiplier_is_applied(self) -> None:
        """A commodity lot is a hundred barrels. Forgetting it is a
        hundredfold error that looks plausible on a screen."""
        trade = a_trade(quantity=1, multiplier=Decimal(100))
        trade = trade.with_entry_fill(1, rupees("6000"), T0)
        assert trade.pnl_at(rupees("6010")) == rupees("1000")

    def test_a_trade_with_no_fill_has_no_pnl_rather_than_zero(self) -> None:
        """Zero would let it into a total as though it were flat."""
        assert a_trade().pnl_at(rupees("130")) is None

    def test_only_the_filled_quantity_counts(self) -> None:
        trade = a_trade(quantity=100).with_entry_fill(25, rupees("120"), T0)
        assert trade.pnl_at(rupees("130")) == rupees("250")

    def test_a_closed_trade_reports_what_it_made(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        trade = trade.closed(rupees("135"), TradeExitReason.TARGET, LATER)
        assert trade.realised_pnl == rupees("1125")
        assert trade.open_quantity == 0


class TestEndingByReason:
    def test_an_entry_failure_cancels(self) -> None:
        trade = a_trade().ended(TradeExitReason.ENTRY_FAILED, T0)
        assert trade.state is TradeState.CANCELLED

    def test_a_stop_loss_closes(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        trade = trade.ended(TradeExitReason.STOP_LOSS, LATER, rupees("110"))
        assert trade.state is TradeState.COMPLETED

    def test_closing_without_a_price_is_refused(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), T0)
        with pytest.raises(DomainError, match="needs an exit price"):
            trade.ended(TradeExitReason.STOP_LOSS, LATER)

    def test_an_entry_failure_after_a_partial_fill_still_closes(self) -> None:
        """Part of it executed, so there is a position to get out of."""
        trade = a_trade(quantity=100).with_entry_fill(25, rupees("120"), T0)
        trade = trade.ended(TradeExitReason.ENTRY_FAILED, LATER, rupees("119"))
        assert trade.state is TradeState.COMPLETED


class TestExitUrgency:
    def test_a_daily_loss_breach_outranks_a_routine_square_off(self) -> None:
        """A queued exit must not be downgraded to a gentler reason."""
        assert (
            more_urgent(TradeExitReason.SQUARE_OFF, TradeExitReason.DAILY_LOSS_BREACH)
            is TradeExitReason.DAILY_LOSS_BREACH
        )

    def test_a_routine_square_off_does_not_displace_a_stop(self) -> None:
        assert (
            more_urgent(TradeExitReason.STOP_LOSS, TradeExitReason.SQUARE_OFF)
            is TradeExitReason.STOP_LOSS
        )

    def test_a_tie_keeps_the_reason_already_recorded(self) -> None:
        """The first reason is what actually caused the exit."""
        assert (
            more_urgent(TradeExitReason.STOP_LOSS, TradeExitReason.TRAILING_STOP_LOSS)
            is TradeExitReason.STOP_LOSS
        )

    def test_an_unranked_reason_still_has_a_priority(self) -> None:
        assert exit_priority(TradeExitReason.MAX_DECAY_90) > 0


class TestProtection:
    def test_trailing_never_overwrites_where_it_started(self) -> None:
        """The initial level is what the risk was sized against."""
        protection = Protection(stop_loss=rupees("100"))
        moved = protection.moved_to(rupees("110")).moved_to(rupees("115"))
        assert moved.stop_loss == rupees("115")
        assert moved.initial_stop_loss == rupees("100")

    def test_a_combined_stop_is_separate_from_the_legs_own(self) -> None:
        """A straddle is stopped on what both legs are worth together, and
        the group's level is a percentage rather than a price: what it means
        in rupees is unknown until every leg has filled."""
        protection = Protection(stop_loss=rupees("100"), combined_stop_loss_percent=Decimal(10))

        assert protection.stop_loss == rupees("100")
        assert protection.combined_stop_loss_percent == Decimal(10)


class TestCorporateActions:
    def test_a_fresh_trade_has_never_been_adjusted(self) -> None:
        assert not CorporateActionState().was_adjusted
        assert CorporateActionState().factor == Decimal(1)

    def test_an_applied_action_is_remembered_so_it_is_not_applied_twice(self) -> None:
        state = CorporateActionState(applied_action_ids=(41,), factor=Decimal(2))
        assert state.has_applied(41)
        assert not state.has_applied(42)
        assert state.was_adjusted


class TestValidation:
    def test_a_trade_for_nothing_is_refused(self) -> None:
        with pytest.raises(DomainError, match="is not a trade"):
            a_trade(quantity=0)

    def test_a_multiplier_of_zero_is_refused(self) -> None:
        with pytest.raises(DomainError, match="contract multiplier"):
            a_trade(multiplier=Decimal(0))

    def test_active_without_an_entry_price_is_refused(self) -> None:
        with pytest.raises(DomainError, match="active with no entry"):
            Trade(
                id=TradeId("t-1"),
                trading_client=CLIENT,
                instrument=CALL,
                strategy="s",
                direction=Direction.LONG,
                product=ProductType.NRML,
                quantity=75,
                state=TradeState.ACTIVE,
                filled_quantity=75,
            )
