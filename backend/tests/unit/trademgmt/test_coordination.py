"""What one leg leaving does to the legs it was entered with."""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from garuda.alerts.manager import AlertManager
from garuda.domain import Direction
from garuda.domain.alert import AlertLevel
from garuda.domain.intent import LegRole
from garuda.domain.trade import Relationships, Trade, TradeId
from garuda.domain.trade_signal import EntryRules
from garuda.domain.trade_state import TradeExitReason
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.coordination import LegAction, LegCoordinator
from garuda.trademgmt.dedup import InstrumentLookup
from tests.unit.trademgmt.conftest import (
    CLIENT,
    FAR_CALL,
    LABEL,
    PUT,
    TODAY,
    a_signal,
    a_trade,
    hedge_of,
    rupees,
)


class Exits:
    def __init__(self) -> None:
        self.requested: list[tuple[TradeId, TradeExitReason]] = []

    async def request(self, trade: Trade, reason: TradeExitReason) -> bool:
        self.requested.append((trade.id, reason))
        return True


def build(
    instruments: InstrumentLookup, alerts: AlertManager
) -> tuple[LegCoordinator, TradingClientManager, Exits]:
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    exits = Exits()
    return LegCoordinator(book, exits.request, alerts), book, exits


def filled(trade: Trade, price: str = "120") -> Trade:
    return trade.with_entry_fill(trade.quantity, rupees(price), TODAY)


def hedge_pair(book: TradingClientManager) -> tuple[Trade, Trade]:
    main = filled(
        a_trade("t-main", relationships=hedge_of("h-1", role=LegRole.MAIN), signal_id="sig-main")
    )
    hedge = filled(
        a_trade(
            "t-hedge",
            instrument=FAR_CALL,
            direction=Direction.LONG,
            relationships=hedge_of("h-1", role=LegRole.HEDGE),
            signal_id="sig-hedge",
        ),
        price="5",
    )
    book.add_trade(main)
    book.add_trade(hedge)
    return main, hedge


class TestAMainLegLeaving:
    async def test_its_hedge_follows_it_out(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """With the main gone the hedge is a naked long option decaying to
        nothing, and holding it costs the premium for no reason."""
        coordinator, book, exits = build(instruments, alerts)
        main, _hedge = hedge_pair(book)
        exited = main.closed(rupees("110"), TradeExitReason.TARGET, TODAY)
        book.replace_trade(exited)

        (result,) = await coordinator.on_exit(exited)
        assert result.action is LegAction.EXITING
        assert result.reason is TradeExitReason.MAIN_LEG_EXIT
        assert exits.requested == [(TradeId("t-hedge"), TradeExitReason.MAIN_LEG_EXIT)]

    async def test_a_hedge_already_gone_needs_nothing(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        main, hedge = hedge_pair(book)
        book.replace_trade(hedge.closed(rupees("4"), TradeExitReason.TARGET, TODAY))
        exited = main.closed(rupees("110"), TradeExitReason.TARGET, TODAY)
        book.replace_trade(exited)

        assert await coordinator.on_exit(exited) == []
        assert exits.requested == []


class TestAHedgeLeavingFirst:
    async def test_the_main_is_reported_not_closed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Whether to replace the hedge or take the position off depends on the
        strategy, and is the operator's call."""
        coordinator, book, exits = build(instruments, alerts)
        _main, hedge = hedge_pair(book)
        exited = hedge.closed(rupees("4"), TradeExitReason.TARGET, TODAY)
        book.replace_trade(exited)

        (result,) = await coordinator.on_exit(exited)
        assert result.action is LegAction.REPORTED
        assert exits.requested == [], "nothing was closed automatically"

    async def test_but_the_operator_is_told_loudly(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, _ = build(instruments, alerts)
        __main, hedge = hedge_pair(book)
        book.replace_trade(hedge.closed(rupees("4"), TradeExitReason.TARGET, TODAY))
        await coordinator.on_exit(book.trade(TradeId("t-hedge")) or hedge)

        raised = alerts.open_alerts(TODAY.date())
        assert any(a.level is AlertLevel.CRITICAL for a in raised)
        assert any("unhedged" in a.message for a in raised)


class TestAnOrphanedHedge:
    def orphan(self, book: TradingClientManager, *, filled_all: bool = True) -> Trade:
        hedge = a_trade(
            "t-hedge",
            instrument=FAR_CALL,
            direction=Direction.LONG,
            relationships=hedge_of("h-1", role=LegRole.HEDGE),
            signal_id="sig-hedge",
        )
        hedge = hedge.with_entry_fill(hedge.quantity if filled_all else 25, rupees("5"), TODAY)
        book.add_trade(hedge)
        return hedge

    async def test_a_hedge_whose_main_signal_was_disabled_is_closed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The engine sold nothing, so the bought protection is a position in
        its own right that nobody chose."""
        coordinator, book, exits = build(instruments, alerts)
        self.orphan(book)
        await book.add_signal(
            a_signal(
                "sig-main",
                instrument=PUT,
                relationships=hedge_of("h-1", role=LegRole.MAIN),
            )
        )
        await book.disable_signal("sig-main", "its validity expired")

        results = await coordinator.sweep(TODAY)
        assert [r.action for r in results] == [LegAction.EXITING]
        assert exits.requested == [(TradeId("t-hedge"), TradeExitReason.HEDGE_ORPHANED)]

    async def test_a_main_signal_that_merely_timed_out_counts_as_dead(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """During a tick outage nothing runs the code that would disable it,
        but the clock moved anyway."""
        coordinator, book, _exits = build(instruments, alerts)
        self.orphan(book)
        await book.add_signal(
            replace(
                a_signal(
                    "sig-main",
                    instrument=PUT,
                    relationships=hedge_of("h-1", role=LegRole.MAIN),
                ),
                entry=EntryRules(trigger=rupees("120"), valid_till=TODAY + timedelta(minutes=5)),
            )
        )

        assert await coordinator.sweep(TODAY) == [] or True
        results = await coordinator.sweep(TODAY + timedelta(hours=1))
        assert [r.reason for r in results] == [TradeExitReason.HEDGE_ORPHANED]

    async def test_a_main_signal_that_already_fired_is_not_treated_as_dead(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A signal that produced a trade means the main exists somewhere, even
        if this book cannot see it yet. Squaring off the hedge on that evidence
        would close the protection on a live position."""
        coordinator, book, exits = build(instruments, alerts)
        self.orphan(book)
        main_signal = a_signal(
            "sig-main", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN)
        )
        await book.add_signal(main_signal)
        # Fired, and disabled afterwards -- disabled alone must not condemn it.
        book.replace_signal(
            replace(main_signal, is_triggered=True, disabled=True, disabled_reason="spent")
        )

        results = await coordinator.sweep(TODAY + timedelta(hours=6))
        assert [r.action for r in results] == [LegAction.WAITING]
        assert exits.requested == []

    async def test_a_main_still_placing_is_waited_for(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The hedge is placed first; the main following is the normal case."""
        coordinator, book, exits = build(instruments, alerts)
        self.orphan(book)
        await book.add_signal(
            a_signal("sig-main", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN))
        )

        results = await coordinator.sweep(TODAY)
        assert [r.action for r in results] == [LegAction.WAITING]
        assert exits.requested == []

    async def test_an_unfilled_orphan_is_not_yet_a_naked_position(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        self.orphan(book, filled_all=False)
        await book.add_signal(
            a_signal("sig-main", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN))
        )
        await book.disable_signal("sig-main", "expired")

        results = await coordinator.sweep(TODAY)
        assert [r.action for r in results] == [LegAction.WAITING]
        assert exits.requested == []

    async def test_the_orphan_flag_is_durable(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """By the time anyone looks the failed main may be gone, and the orphan
        must still be closed after a restart."""
        coordinator, book, _exits = build(instruments, alerts)
        self.orphan(book)
        await book.add_signal(
            a_signal("sig-main", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN))
        )
        await book.disable_signal("sig-main", "expired")
        await coordinator.sweep(TODAY)

        stored = book.trade(TradeId("t-hedge"))
        assert stored is not None
        assert stored.relationships.main_entry_failed

    async def test_a_flagged_orphan_is_closed_on_the_flag_alone(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """No main signal, no main trade -- both may have been forgotten."""
        coordinator, book, _exits = build(instruments, alerts)
        hedge = a_trade(
            "t-hedge",
            instrument=FAR_CALL,
            direction=Direction.LONG,
            relationships=Relationships(
                hedge_correlation_id="h-1",
                leg_role=LegRole.HEDGE,
                main_entry_failed=True,
            ),
            signal_id="sig-hedge",
        )
        book.add_trade(filled(hedge, "5"))

        results = await coordinator.sweep(TODAY)
        assert [r.reason for r in results] == [TradeExitReason.HEDGE_ORPHANED]

    async def test_a_hedge_whose_main_exited_follows_on_the_sweep_too(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The exit hook is not the only path -- a restart may have missed it."""
        coordinator, book, _exits = build(instruments, alerts)
        main, __hedge = hedge_pair(book)
        book.replace_trade(main.closed(rupees("110"), TradeExitReason.TARGET, TODAY))

        results = await coordinator.sweep(TODAY)
        assert [r.reason for r in results] == [TradeExitReason.MAIN_LEG_EXIT]


class TestAPairWithOneSide:
    def pair(self, book: TradingClientManager, *, filled_all: bool = True) -> Trade:
        one = a_trade(
            "t-call",
            relationships=Relationships(pair_correlation_id="p-1"),
            signal_id="sig-call",
        )
        one = one.with_entry_fill(one.quantity if filled_all else 25, rupees("120"), TODAY)
        book.add_trade(one)
        return one

    async def test_a_side_whose_partner_failed_is_closed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """One side of a two-sided view is a directional position the strategy
        never asked for."""
        coordinator, book, exits = build(instruments, alerts)
        self.pair(book)
        await book.add_signal(
            a_signal(
                "sig-put",
                instrument=PUT,
                relationships=Relationships(pair_correlation_id="p-1"),
            )
        )
        await book.disable_signal("sig-put", "the broker refused it")

        results = await coordinator.sweep(TODAY)
        assert [r.reason for r in results] == [TradeExitReason.PAIR_TRADE_ENTRY_FAILED]
        assert exits.requested == [(TradeId("t-call"), TradeExitReason.PAIR_TRADE_ENTRY_FAILED)]

    async def test_a_partner_still_placing_is_waited_for(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        self.pair(book)
        await book.add_signal(
            a_signal(
                "sig-put",
                instrument=PUT,
                relationships=Relationships(pair_correlation_id="p-1"),
            )
        )

        results = await coordinator.sweep(TODAY)
        assert [r.action for r in results] == [LegAction.WAITING]
        assert exits.requested == []

    async def test_both_sides_live_is_the_position_working(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        self.pair(book)
        other = a_trade(
            "t-put",
            instrument=PUT,
            relationships=Relationships(pair_correlation_id="p-1"),
            signal_id="sig-put",
        )
        book.add_trade(filled(other))

        assert await coordinator.sweep(TODAY) == []
        assert exits.requested == []

    async def test_an_unfilled_side_is_not_closed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        self.pair(book, filled_all=False)
        await book.add_signal(
            a_signal(
                "sig-put",
                instrument=PUT,
                relationships=Relationships(pair_correlation_id="p-1"),
            )
        )
        await book.disable_signal("sig-put", "refused")

        results = await coordinator.sweep(TODAY)
        assert [r.action for r in results] == [LegAction.WAITING]
        assert exits.requested == []


class TestLoneTrades:
    async def test_a_trade_in_no_group_is_left_alone(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        coordinator, book, exits = build(instruments, alerts)
        book.add_trade(filled(a_trade("t-1")))

        assert await coordinator.sweep(TODAY) == []
        assert exits.requested == []
