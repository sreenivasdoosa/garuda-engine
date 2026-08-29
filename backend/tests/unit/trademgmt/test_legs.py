"""Which legs belong with which, and which one goes first."""

from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta

import pytest

from garuda.alerts.manager import AlertManager
from garuda.domain import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.trade import IllegalTradeTransitionError, Relationships, Trade, TradeId
from garuda.domain.trade_signal import SignalType, TradeSignal
from garuda.domain.trade_state import TradeExitReason
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.legs import (
    earlier_leg_signal,
    find_hedge,
    find_pair,
    goes_after_another_leg,
    is_hedge,
)
from tests.unit.trademgmt.conftest import (
    CALL,
    FAR_CALL,
    LABEL,
    PUT,
    STOCK,
    TODAY,
    a_signal,
    a_trade,
    hedge_of,
    rupees,
)


def book(instruments: InstrumentLookup, alerts: AlertManager) -> TradingClientManager:
    from tests.unit.trademgmt.conftest import CLIENT

    return TradingClientManager(CLIENT, LABEL, instruments, alerts)


def filled(trade: Trade, price: str = "120", at: datetime = TODAY) -> Trade:
    return trade.with_entry_fill(trade.quantity, rupees(price), at)


class TestWhatIsAHedge:
    def test_the_role_says_so_not_the_direction(self) -> None:
        """A covered call is the sharp case: its long leg is the stock and its
        short leg is the call, so the direction rule calls the shareholding a
        hedge and squares it off when the call exits."""
        stock = a_trade(
            "t-stock",
            instrument=STOCK,
            direction=Direction.LONG,
            relationships=hedge_of("h-1", role=LegRole.MAIN),
        )
        call = a_trade(
            "t-call",
            direction=Direction.SHORT,
            relationships=hedge_of("h-1", role=LegRole.HEDGE),
        )
        assert not is_hedge(stock), "the shareholding is the position, not the hedge"
        assert is_hedge(call)

    def test_a_replacement_signal_is_a_hedge_whatever_else_it_says(self) -> None:
        signal = a_signal(
            relationships=Relationships(
                hedge_correlation_id="h-1",
                hedge_trade_id_to_square_off=TradeId("t-old"),
            )
        )
        assert is_hedge(signal)


class TestFindingTheOperativeHedge:
    def test_a_main_leg_finds_its_hedge(self) -> None:
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        hedge = filled(
            a_trade(
                "t-hedge",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        assert find_hedge(main, [main, hedge]).trade is hedge

    def test_a_hedge_finds_what_it_protects(self) -> None:
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        hedge = filled(
            a_trade(
                "t-hedge",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        assert find_hedge(hedge, [main, hedge]).trade is main

    def test_a_rolled_hedge_chain_returns_the_current_one(self) -> None:
        """A multi-day short accumulates rolled hedges under one correlation.
        Taking the first match returns the oldest, which is dead."""
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        old = filled(
            a_trade(
                "t-h1",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
                started_at=TODAY - timedelta(days=3),
            ),
            at=TODAY - timedelta(days=3),
        )
        old = old.closed(rupees("4"), TradeExitReason.HEDGE_REPLACE, TODAY)
        current = filled(
            a_trade(
                "t-h2",
                instrument=PUT,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )

        assert find_hedge(main, [main, old, current]).trade is current

    def test_the_newest_wins_while_a_roll_is_in_flight(self) -> None:
        """Between placing the new hedge and squaring off the old one, both are
        live and neither is tagged yet."""
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        older = filled(
            a_trade(
                "t-h1",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
                started_at=TODAY - timedelta(hours=2),
            ),
            at=TODAY - timedelta(hours=2),
        )
        newer = filled(
            a_trade(
                "t-h2",
                instrument=PUT,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )

        lookup = find_hedge(main, [main, older, newer])
        assert lookup.trade is newer
        assert set(lookup.ambiguous) == {TradeId("t-h1"), TradeId("t-h2")}

    def test_with_nothing_live_the_answer_is_marked_degraded(self) -> None:
        """The caller still gets a handle, and is told it is not operative."""
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        dead = filled(
            a_trade(
                "t-h1",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        ).closed(rupees("4"), TradeExitReason.MAIN_LEG_EXIT, TODAY)

        lookup = find_hedge(main, [main, dead])
        assert lookup.trade is dead
        assert lookup.degraded

    def test_a_leg_with_no_correlation_has_no_hedge(self) -> None:
        assert find_hedge(a_trade("t-1"), [a_trade("t-1")]).trade is None

    def test_a_leg_never_hedges_itself(self) -> None:
        alone = a_trade("t-1", relationships=hedge_of("h-1", role=LegRole.MAIN))
        assert find_hedge(alone, [alone]).trade is None

    async def test_an_ambiguous_lookup_tells_the_operator(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        from garuda.protocols.topics import Topic

        subject = book(instruments, alerts)
        alerts_seen = alerts.bus.subscribe(Topic.ALERTS, name="test")

        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        subject.add_trade(main)
        for index, instrument in enumerate((FAR_CALL, PUT)):
            subject.add_trade(
                filled(
                    a_trade(
                        f"t-h{index}",
                        instrument=instrument,
                        direction=Direction.LONG,
                        relationships=hedge_of("h-1", role=LegRole.HEDGE),
                        signal_id=f"sig-h{index}",
                    )
                )
            )

        await subject.hedge_for(main)
        assert alerts_seen.depth == 1


class TestPairs:
    def test_the_other_side_of_a_pair_is_found(self) -> None:
        call = a_trade("t-call", relationships=Relationships(pair_correlation_id="p-1"))
        put = a_trade(
            "t-put", instrument=PUT, relationships=Relationships(pair_correlation_id="p-1")
        )
        assert find_pair(call, [call, put]) is put

    def test_a_trade_is_never_its_own_pair(self) -> None:
        alone = a_trade("t-1", relationships=Relationships(pair_correlation_id="p-1"))
        assert find_pair(alone, [alone]) is None


class TestEntryOrdering:
    def sequenced(
        self, signal_id: str, sequence: int, instrument: InstrumentId = CALL
    ) -> TradeSignal:
        return a_signal(
            signal_id,
            instrument=instrument,
            signal_type=SignalType.LONG_ENTRY,
            relationships=Relationships(combo_id="c-1", entry_sequence=sequence),
        )

    def test_the_first_leg_waits_for_nothing(self) -> None:
        first = self.sequenced("sig-1", 1)
        second = self.sequenced("sig-2", 2, PUT)
        assert not goes_after_another_leg(first, [first, second])

    def test_a_later_leg_waits(self) -> None:
        first = self.sequenced("sig-1", 1)
        second = self.sequenced("sig-2", 2, PUT)
        assert goes_after_another_leg(second, [first, second])

    def test_a_three_leg_combo_waits_on_its_immediate_predecessor(self) -> None:
        """Waiting on the first instead would let leg three go the moment leg
        one filled, with leg two still working."""
        legs = [
            self.sequenced("sig-1", 1),
            self.sequenced("sig-2", 2, PUT),
            self.sequenced("sig-3", 3, FAR_CALL),
        ]
        earlier = earlier_leg_signal(legs[2], legs)
        assert earlier is not None
        assert earlier.id == "sig-2"

    def test_a_leg_with_no_sequence_does_not_wait(self) -> None:
        """Ordering is the strategy's decision, expressed when signals are
        built. A group whose legs carry no sequence has said it does not care."""
        plain = a_signal("sig-1", relationships=Relationships(combo_id="c-1"))
        other = a_signal("sig-2", instrument=PUT, relationships=Relationships(combo_id="c-1"))
        assert not goes_after_another_leg(plain, [plain, other])

    def test_legs_of_another_combo_are_not_predecessors(self) -> None:
        mine = self.sequenced("sig-1", 2)
        theirs = replace(
            self.sequenced("sig-2", 1, PUT),
            relationships=Relationships(combo_id="c-2", entry_sequence=1),
        )
        assert not goes_after_another_leg(mine, [mine, theirs])

    def test_a_hedge_pair_orders_by_sequence_too(self) -> None:
        """The reference engine asked "am I the sell, and is the rule
        buy-first" -- answerable only for a pair, and only for options."""
        buy = a_signal(
            "sig-buy",
            instrument=FAR_CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=hedge_of("h-1", role=LegRole.HEDGE, sequence=1),
        )
        sell = a_signal("sig-sell", relationships=hedge_of("h-1", role=LegRole.MAIN, sequence=2))
        assert not goes_after_another_leg(buy, [buy, sell])
        assert goes_after_another_leg(sell, [buy, sell])

    async def test_the_trade_ahead_is_found_once_it_is_placed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        first = self.sequenced("sig-1", 1)
        second = self.sequenced("sig-2", 2, PUT)
        await subject.add_signal(first)
        await subject.add_signal(second)
        subject.add_trade(a_trade("t-1", signal_id="sig-1"))

        found = subject.trade_ahead_of(second)
        assert found is not None
        assert found.id == TradeId("t-1")

    async def test_before_the_leg_ahead_is_placed_there_is_no_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        subject = book(instruments, alerts)
        first = self.sequenced("sig-1", 1)
        second = self.sequenced("sig-2", 2, PUT)
        await subject.add_signal(first)
        await subject.add_signal(second)
        assert subject.trade_ahead_of(second) is None


class TestAHedgeOnItsWayOut:
    """The window between placing a replacement and its square-off filling."""

    def rolling_pair(self) -> tuple[Trade, Trade, Trade]:
        main = filled(a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN)))
        old = filled(
            a_trade(
                "t-old",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
                started_at=TODAY - timedelta(hours=2),
            ),
            at=TODAY - timedelta(hours=2),
        )
        new = filled(
            a_trade(
                "t-new",
                instrument=PUT,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        return main, old, new

    def test_a_hedge_being_replaced_is_not_the_operative_one(self) -> None:
        """It is still live because the square-off has not filled, and pairing
        to it links the main leg to protection that is about to disappear."""
        main, old, new = self.rolling_pair()
        old = old.exiting(TradeExitReason.HEDGE_REPLACE)

        lookup = find_hedge(main, [main, old, new])
        assert lookup.trade is new
        assert lookup.ambiguous == (), "only one hedge is operative"

    def test_a_hedge_leaving_for_another_reason_still_counts(self) -> None:
        """Only a replacement means "another hedge is already standing in"."""
        main, old, new = self.rolling_pair()
        old = old.exiting(TradeExitReason.SQUARE_OFF)

        lookup = find_hedge(main, [main, old, new])
        assert set(lookup.ambiguous) == {TradeId("t-old"), TradeId("t-new")}

    def test_the_more_urgent_exit_reason_wins(self) -> None:
        _, old, _ = self.rolling_pair()
        exiting = old.exiting(TradeExitReason.SQUARE_OFF).exiting(TradeExitReason.DAILY_LOSS_BREACH)
        assert exiting.exiting_for is TradeExitReason.DAILY_LOSS_BREACH
        assert exiting.is_exiting

    def test_a_gentler_reason_does_not_displace_an_urgent_one(self) -> None:
        _, old, _ = self.rolling_pair()
        exiting = old.exiting(TradeExitReason.DAILY_LOSS_BREACH).exiting(TradeExitReason.SQUARE_OFF)
        assert exiting.exiting_for is TradeExitReason.DAILY_LOSS_BREACH

    def test_a_finished_trade_cannot_start_exiting(self) -> None:
        _, old, _ = self.rolling_pair()
        done = old.closed(rupees("4"), TradeExitReason.MAIN_LEG_EXIT, TODAY)
        with pytest.raises(IllegalTradeTransitionError):
            done.exiting(TradeExitReason.SQUARE_OFF)


class TestPairsDirectionCannotResolve:
    """A protected long future and its bought put are both long."""

    def both_long(self) -> tuple[Trade, Trade]:
        future = filled(
            a_trade(
                "t-future",
                instrument=STOCK,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.MAIN),
            )
        )
        protective_put = filled(
            a_trade(
                "t-put",
                instrument=PUT,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        return future, protective_put

    def test_the_position_finds_its_protection(self) -> None:
        """Direction can never pair these: both legs are long, so a rule that
        looks for the opposite side finds nothing and the position runs as
        though it were unhedged."""
        future, put = self.both_long()
        assert find_hedge(future, [future, put]).trade is put

    def test_the_protection_finds_what_it_protects(self) -> None:
        future, put = self.both_long()
        assert find_hedge(put, [future, put]).trade is future

    def test_two_legs_of_the_same_role_are_not_a_pair(self) -> None:
        """Two hedges on one correlation protect a main that is not in this
        list; neither is the other's counterpart."""
        _, put = self.both_long()
        other_put = filled(
            a_trade(
                "t-put-2",
                instrument=FAR_CALL,
                direction=Direction.LONG,
                relationships=hedge_of("h-1", role=LegRole.HEDGE),
            )
        )
        assert find_hedge(put, [put, other_put]).trade is None
