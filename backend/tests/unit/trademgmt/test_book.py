"""The trading client's book: retention, duplicate rejection, and indexes."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta

import pytest

from garuda.alerts.manager import AlertManager
from garuda.domain import Direction
from garuda.domain.client import TradingClientId
from garuda.domain.intent import LegRole
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Relationships, TradeId
from garuda.domain.trade_signal import SignalType, TradeSignal
from garuda.domain.trade_state import TradeExitReason
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import DuplicateRule, InstrumentLookup
from garuda.trademgmt.retention import retain, should_retain_signal, should_retain_trade
from tests.unit.trademgmt.conftest import (
    CALL,
    FAR_CALL,
    LABEL,
    PUT,
    STOCK,
    TODAY,
    YESTERDAY,
    a_signal,
    a_trade,
    hedge_of,
    rupees,
)

TODAYS_DATE = TODAY.date()
LAST_WEEK = datetime(2026, 8, 24, 9, 20, tzinfo=UTC)


def book(instruments: InstrumentLookup, alerts: AlertManager) -> TradingClientManager:
    from tests.unit.trademgmt.conftest import CLIENT

    return TradingClientManager(CLIENT, LABEL, instruments, alerts)


class TestWhatSurvivesARestart:
    def test_a_live_trade_is_kept_whenever_it_started(self) -> None:
        trade = a_trade(started_at=LAST_WEEK).with_entry_fill(75, rupees("120"), LAST_WEEK)
        assert should_retain_trade(trade, TODAYS_DATE)

    def test_a_trade_that_finished_today_is_kept(self) -> None:
        trade = a_trade().with_entry_fill(75, rupees("120"), TODAY)
        trade = trade.closed(rupees("130"), TradeExitReason.TARGET, TODAY)
        assert should_retain_trade(trade, TODAYS_DATE)

    def test_a_trade_that_finished_last_week_is_history(self) -> None:
        """Kept in memory it makes today's duplicate detection reject a fresh
        signal for the same symbol, and makes the tranche gate see a taken slot."""
        trade = a_trade(started_at=LAST_WEEK).with_entry_fill(75, rupees("120"), LAST_WEEK)
        trade = trade.closed(rupees("130"), TradeExitReason.TARGET, LAST_WEEK)
        assert not should_retain_trade(trade, TODAYS_DATE)

    def test_an_order_that_rested_overnight_unfilled_is_not_live(self) -> None:
        """The venue dropped it. Carrying it forward carries an order that
        no longer exists."""
        trade = a_trade(started_at=YESTERDAY)
        assert trade.is_live
        assert not should_retain_trade(trade, TODAYS_DATE)

    def test_a_signal_generated_today_is_kept(self) -> None:
        assert should_retain_signal(a_signal(), TODAYS_DATE, frozenset())

    def test_a_signal_still_waiting_for_its_price_is_kept(self) -> None:
        signal = a_signal(generated_at=LAST_WEEK)
        assert should_retain_signal(signal, TODAYS_DATE, frozenset())

    def test_an_old_spent_signal_is_dropped(self) -> None:
        signal = a_signal(generated_at=LAST_WEEK, triggered=True)
        assert not should_retain_signal(signal, TODAYS_DATE, frozenset())

    def test_an_old_signal_backing_a_kept_trade_comes_back_with_it(self) -> None:
        """Otherwise the trade reloads with no levels and no group."""
        signal = a_signal(generated_at=LAST_WEEK, triggered=True)
        assert should_retain_signal(signal, TODAYS_DATE, frozenset({"sig-1"}))

    def test_retaining_keeps_the_signals_of_the_trades_it_kept(self) -> None:
        live = a_trade("t-live", started_at=LAST_WEEK, signal_id="sig-live")
        live = live.with_entry_fill(75, rupees("120"), LAST_WEEK)
        old = a_trade("t-old", started_at=LAST_WEEK, signal_id="sig-old")
        old = old.with_entry_fill(75, rupees("120"), LAST_WEEK)
        old = old.closed(rupees("130"), TradeExitReason.TARGET, LAST_WEEK)

        signals = [
            a_signal("sig-live", generated_at=LAST_WEEK, triggered=True),
            a_signal("sig-old", generated_at=LAST_WEEK, triggered=True),
        ]
        kept_trades, kept_signals = retain([live, old], signals, TODAYS_DATE)

        assert [t.id for t in kept_trades] == [TradeId("t-live")]
        assert [s.id for s in kept_signals] == ["sig-live"]

    async def test_restoring_loads_only_what_belongs_to_today(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        old = a_trade("t-old", started_at=LAST_WEEK, signal_id="sig-old")
        old = old.with_entry_fill(75, rupees("120"), LAST_WEEK)
        old = old.closed(rupees("130"), TradeExitReason.TARGET, LAST_WEEK)

        trades, signals = subject.restore(
            [a_trade("t-new"), old],
            [a_signal("sig-1"), a_signal("sig-old", generated_at=LAST_WEEK, triggered=True)],
            TODAYS_DATE,
        )
        assert (trades, signals) == (1, 1)
        assert subject.trade(TradeId("t-old")) is None

    async def test_restoring_twice_is_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.restore([], [], TODAYS_DATE)
        subject.add_trade(a_trade())
        with pytest.raises(RuntimeError, match="runs once"):
            subject.restore([], [], TODAYS_DATE)


class TestRefusingASignalTwice:
    async def test_a_fresh_signal_is_accepted(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        assert await book(instruments, alerts).add_signal(a_signal()) is None

    async def test_the_same_id_twice_is_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal())
        rejected = await subject.add_signal(a_signal())
        assert rejected is not None

    async def test_a_resent_tranche_is_refused_however_long_after(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The case a restart creates: the same tranche re-emitted, differing
        only in when it was generated."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", tranche=1))

        resent = a_signal("sig-2", tranche=1, generated_at=TODAY + timedelta(hours=1))
        rejected = await subject.add_signal(resent)
        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_TRANCHE_SLOT

    async def test_a_different_tranche_is_a_different_slot(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=STOCK, tranche=1))
        assert await subject.add_signal(a_signal("sig-2", instrument=STOCK, tranche=2)) is None

    async def test_for_options_the_side_rule_outranks_the_tranche_rule(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Surprising and deliberate, and the reference engine does the same:
        the tranche check passes a non-matching slot along, and the option-side
        rule refuses it anyway. A second option tranche on the same underlying
        must therefore use its own group, or it never places."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, tranche=1))

        same_group = await subject.add_signal(a_signal("sig-2", instrument=CALL, tranche=2))
        assert same_group is not None
        assert same_group.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

        assert (
            await subject.add_signal(a_signal("sig-3", instrument=CALL, tranche=2, group="T2"))
            is None
        )

    async def test_a_different_slice_of_a_tranche_is_allowed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """An entry above the freeze limit is split, and each slice is real."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=STOCK, tranche=1, slice_=1))
        assert (
            await subject.add_signal(a_signal("sig-2", instrument=STOCK, tranche=1, slice_=2))
            is None
        )

    async def test_an_untranched_resend_at_a_new_time_is_a_new_signal(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Untranched identity includes when it was generated; changing that
        rule would silently drop re-entries."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=STOCK))
        later = a_signal("sig-2", instrument=STOCK, generated_at=TODAY + timedelta(minutes=5))
        assert await subject.add_signal(later) is None

    async def test_an_untranched_exact_resend_is_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=STOCK))
        rejected = await subject.add_signal(a_signal("sig-2", instrument=STOCK))
        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.IDENTICAL_SIGNAL


class TestOneOptionSidePerGroup:
    async def test_a_second_short_call_on_the_same_underlying_is_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Same leg, sized twice."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL))
        rejected = await subject.add_signal(a_signal("sig-2", instrument=FAR_CALL))
        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

    async def test_the_slices_of_one_leg_are_not_the_same_leg_twice(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A position above the freeze limit is sent as several orders.

        Each piece is its own signal in the same group on the same instrument
        in the same direction — the exact shape this rule refuses. Without the
        exemption every slice after the first is dropped and the account holds
        a fraction of the intended size with nothing saying so.
        """
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, slice_=1))

        second = await subject.add_signal(a_signal("sig-2", instrument=CALL, slice_=2))

        assert second is None

    async def test_every_slice_of_a_long_entry_lands(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)

        for ordinal in (1, 2, 3):
            accepted = await subject.add_signal(
                a_signal(f"sig-{ordinal}", instrument=CALL, slice_=ordinal)
            )
            assert accepted is None

        assert len(subject.signals()) == 3

    async def test_the_same_leg_sized_twice_is_still_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Two independent sizings both carry slice 1, which is what catches them."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, slice_=1))

        rejected = await subject.add_signal(a_signal("sig-2", instrument=FAR_CALL, slice_=1))

        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

    async def test_the_same_slice_of_the_same_leg_is_still_the_same_leg(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Only a *different* ordinal makes two signals pieces of one leg.

        Two sizings of the same instrument both carry slice 1, and differ only
        in quantity — which is the double-size this rule is for.
        """
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, slice_=1, quantity=75))

        rejected = await subject.add_signal(
            a_signal("sig-2", instrument=CALL, slice_=1, quantity=150)
        )

        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

    async def test_a_slice_in_another_tranche_is_not_a_slice_of_this_leg(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Slicing splits one entry. A second tranche is a second entry, and
        must use its own group like any other."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, tranche=1, slice_=1))

        rejected = await subject.add_signal(a_signal("sig-2", instrument=CALL, tranche=2, slice_=2))

        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

    async def test_a_slice_of_a_different_strike_is_not_a_slice_of_this_leg(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Slicing splits one instrument. A different strike is a second leg."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, slice_=1))

        rejected = await subject.add_signal(a_signal("sig-2", instrument=FAR_CALL, slice_=2))

        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.SAME_OPTION_SIDE

    async def test_a_put_alongside_a_call_is_a_straddle_not_a_duplicate(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL))
        assert await subject.add_signal(a_signal("sig-2", instrument=PUT)) is None

    async def test_a_long_call_alongside_a_short_one_is_a_hedge(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL))
        hedge = a_signal("sig-2", instrument=FAR_CALL, signal_type=SignalType.LONG_ENTRY)
        assert await subject.add_signal(hedge) is None

    async def test_another_group_may_hold_the_same_side(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL, group="A"))
        assert await subject.add_signal(a_signal("sig-2", instrument=FAR_CALL, group="B")) is None

    async def test_the_underlying_comes_from_the_instrument_not_the_symbol(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Two different strikes are the same underlying, and the master says
        so directly rather than by truncating the trading symbol."""
        subject = book(instruments, alerts)
        await subject.add_signal(a_signal("sig-1", instrument=CALL))
        rejected = await subject.add_signal(a_signal("sig-2", instrument=FAR_CALL))
        assert rejected is not None
        assert "NSE:NIFTY" in rejected.duplicate.detail


class TestRollingAHedge:
    def replacement(self, squares_off: str = "t-old-hedge") -> TradeSignal:
        """A roll moves the hedge to a different strike -- that is its purpose."""
        return a_signal(
            "sig-roll",
            instrument=CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=Relationships(
                hedge_correlation_id="h-1",
                leg_role=LegRole.HEDGE,
                hedge_trade_id_to_square_off=TradeId(squares_off),
            ),
        )

    async def test_a_roll_may_re_enter_a_slot_a_live_hedge_holds(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Re-entering the slot is what rolling a hedge is."""
        subject = book(instruments, alerts)
        await subject.add_signal(
            a_signal(
                "sig-hedge",
                instrument=FAR_CALL,
                signal_type=SignalType.LONG_ENTRY,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        assert await subject.add_signal(self.replacement()) is None

    async def test_two_rolls_of_the_same_hedge_racing_are_caught(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        await subject.add_signal(self.replacement())
        second = replace(self.replacement(), id="sig-roll-2")
        rejected = await subject.add_signal(second)
        assert rejected is not None
        assert rejected.duplicate.rule is DuplicateRule.CONCURRENT_HEDGE_REPLACE

    async def test_a_retry_after_a_failed_roll_is_allowed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A failed roll is left disabled rather than removed. Treating it as a
        duplicate means the hedge is never replaced at all."""
        subject = book(instruments, alerts)
        await subject.add_signal(self.replacement())
        await subject.disable_signal("sig-roll", "the broker refused")

        retry = replace(self.replacement(), id="sig-roll-2")
        assert await subject.add_signal(retry) is None

    async def test_a_leftover_signal_whose_position_is_gone_does_not_block(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The original hedge signal lingers after an earlier roll squared its
        position off, and reloads next morning. It must not kill the next roll."""
        subject = book(instruments, alerts)
        leftover = self.replacement()
        await subject.add_signal(leftover)

        dead = a_trade("t-dead", signal_id="sig-roll", instrument=FAR_CALL)
        dead = dead.with_entry_fill(75, rupees("5"), TODAY)
        dead = dead.closed(rupees("4"), TradeExitReason.HEDGE_REPLACE, TODAY)
        subject.add_trade(dead)

        assert await subject.add_signal(replace(self.replacement(), id="sig-roll-2")) is None

    async def test_a_leftover_still_holding_a_position_does_block(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A live backing trade is a real duplicate."""
        subject = book(instruments, alerts)
        await subject.add_signal(self.replacement())
        live = a_trade("t-live", signal_id="sig-roll", instrument=FAR_CALL)
        subject.add_trade(live.with_entry_fill(75, rupees("5"), TODAY))

        rejected = await subject.add_signal(replace(self.replacement(), id="sig-roll-2"))
        assert rejected is not None

    async def test_a_signal_with_no_trade_yet_still_blocks(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A genuine in-flight race must stay caught."""
        subject = book(instruments, alerts)
        await subject.add_signal(self.replacement())
        assert await subject.add_signal(replace(self.replacement(), id="sig-roll-2")) is not None


class TestTheIndexes:
    async def test_trades_are_found_by_strategy(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-1", strategy="straddle"))
        subject.add_trade(a_trade("t-2", strategy="momentum", instrument=STOCK))
        assert [t.id for t in subject.trades_for("straddle")] == [TradeId("t-1")]

    async def test_trades_are_found_by_strategy_and_group(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-1", group="A"))
        subject.add_trade(a_trade("t-2", group="B", instrument=PUT))
        assert [t.id for t in subject.trades_for("straddle", "A")] == [TradeId("t-1")]

    async def test_an_advanced_trade_leaves_no_stale_index_entry(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Trades are values, so every index is maintained on replacement."""
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-1", strategy="straddle"))
        original = subject.trade(TradeId("t-1"))
        assert original is not None
        subject.replace_trade(replace(original, strategy="momentum"))

        assert subject.trades_for("straddle") == []
        assert [t.id for t in subject.trades_for("momentum")] == [TradeId("t-1")]

    async def test_an_emptied_index_key_is_dropped(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Otherwise a process running for weeks accumulates one key per
        strategy and group it has ever traded."""
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-1", strategy="straddle"))
        original = subject.trade(TradeId("t-1"))
        assert original is not None
        subject.replace_trade(replace(original, strategy="other"))
        assert "straddle" not in subject._by_strategy

    async def test_a_broker_order_resolves_to_its_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Both the push stream and the poll arrive knowing only an order id."""
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-1"))
        subject.link_order(BrokerOrderId("260831000001"), TradeId("t-1"))
        found = subject.trade_for_order(BrokerOrderId("260831000001"))
        assert found is not None
        assert found.id == TradeId("t-1")

    async def test_live_and_active_are_different_questions(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(a_trade("t-open"))
        subject.add_trade(
            a_trade("t-active", instrument=PUT).with_entry_fill(75, rupees("120"), TODAY)
        )
        assert len(subject.live_trades()) == 2
        assert [t.id for t in subject.active_trades()] == [TradeId("t-active")]

    async def test_the_net_position_in_an_instrument_is_summed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(
            a_trade("t-short", direction=Direction.SHORT).with_entry_fill(75, rupees("120"), TODAY)
        )
        subject.add_trade(
            a_trade("t-long", direction=Direction.LONG, signal_id="sig-2").with_entry_fill(
                25, rupees("120"), TODAY
            )
        )
        assert subject.open_quantity(CALL) == -50

    async def test_each_side_is_counted_gross_as_well(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """What bounds an exit. The two strategies above net to fifty short
        and each still has a real position to close, so a bound taken from the
        net would refuse the long's exit outright."""
        subject = book(instruments, alerts)
        subject.add_trade(
            a_trade("t-short", direction=Direction.SHORT).with_entry_fill(75, rupees("120"), TODAY)
        )
        subject.add_trade(
            a_trade("t-long", direction=Direction.LONG, signal_id="sig-2").with_entry_fill(
                25, rupees("120"), TODAY
            )
        )

        assert subject.open_quantity_in(CALL, Direction.SHORT) == 75
        assert subject.open_quantity_in(CALL, Direction.LONG) == 25

    async def test_a_side_with_nothing_open_counts_nothing(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(
            a_trade("t-short", direction=Direction.SHORT).with_entry_fill(75, rupees("120"), TODAY)
        )

        assert subject.open_quantity_in(CALL, Direction.LONG) == 0

    async def test_another_instrument_is_not_counted(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        subject.add_trade(
            a_trade("t-short", direction=Direction.SHORT).with_entry_fill(75, rupees("120"), TODAY)
        )

        assert subject.open_quantity_in(PUT, Direction.SHORT) == 0

    async def test_a_failed_entry_is_listed_separately(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The live listings are what the loop walks; a failed entry is not live."""
        subject = book(instruments, alerts)
        failed = a_trade("t-1").cancelled(TradeExitReason.ENTRY_FAILED, TODAY, "margin")
        subject.add_trade(failed)
        assert [t.id for t in subject.failed_trades()] == [TradeId("t-1")]
        assert subject.live_trades() == []

    async def test_a_signal_from_another_account_is_refused(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        stray = replace(a_signal(), trading_client=TradingClientId("amma-zerodha"))
        with pytest.raises(ValueError, match="belongs to"):
            await subject.add_signal(stray)
