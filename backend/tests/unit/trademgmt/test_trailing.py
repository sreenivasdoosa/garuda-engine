"""Moving a stop as a position earns a tighter one.

The rule that matters most is that it only ever tightens.
"""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from garuda.alerts.manager import AlertManager
from garuda.domain import Direction
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason
from garuda.domain.trailing import GapUnit, TrailConfig, TrailingMode
from garuda.protocols.broker import OrderChanges
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.trailing import TrailingService, TrailOutcome
from garuda.trademgmt.trailing_rules import (
    improves,
    risk_multiple_stop,
    trail_to_cost_stop,
)
from tests.unit.trademgmt.conftest import CALL, CLIENT, LABEL, TODAY, a_trade, rupees

STOP_ORDER = BrokerOrderId("260831000002")


class FakeOrders:
    def __init__(self) -> None:
        self.modified: list[tuple[BrokerOrderId, OrderChanges]] = []
        self.cancelled: list[BrokerOrderId] = []
        self.placed: list[Trade] = []
        self.modify_fails: Exception | None = None
        self.cancel_fails: Exception | None = None
        self.place_returns: BrokerOrderId | None = BrokerOrderId("260831000099")

    async def modify(self, order_id: BrokerOrderId, changes: OrderChanges) -> None:
        if self.modify_fails is not None:
            raise self.modify_fails
        self.modified.append((order_id, changes))

    async def cancel(self, order_id: BrokerOrderId) -> None:
        if self.cancel_fails is not None:
            raise self.cancel_fails
        self.cancelled.append(order_id)

    async def place(self, trade: Trade) -> BrokerOrderId | None:
        self.placed.append(trade)
        return self.place_returns


def build(
    instruments: InstrumentLookup,
    alerts: AlertManager,
    orders: FakeOrders,
    *,
    max_modifications: int = 20,
) -> tuple[TrailingService, TradingClientManager]:
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    service = TrailingService(
        book,
        orders.modify,
        orders.cancel,
        orders.place,
        instruments,
        alerts,
        max_modifications=max_modifications,
    )
    return service, book


def trailing_trade(
    *,
    direction: Direction = Direction.LONG,
    entry: str = "100",
    stop: str = "90",
    with_order: bool = True,
    track_only: bool = False,
    trail: TrailConfig | None = None,
) -> Trade:
    trade = a_trade(direction=direction)
    trade = replace(
        trade,
        protection=Protection(
            stop_loss=rupees(stop),
            initial_stop_loss=rupees(stop),
            is_trailing=True,
            trail=trail if trail is not None else TrailConfig(),
            dont_place_stop_loss_order=track_only,
        ),
    )
    return trade.with_entry_fill(75, rupees(entry), TODAY)


def a_tick(price: str) -> Tick:
    return Tick(CALL, rupees(price), TODAY)


class TestTheArithmetic:
    def test_no_step_earned_means_no_move(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        assert (
            risk_multiple_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("90"),
                extreme=rupees("105"),
                config=TrailConfig(),
                instrument=instrument,
            )
            is None
        ), "half a step earns nothing"

    def test_one_step_of_profit_moves_the_stop_one_step(
        self, instruments: InstrumentLookup
    ) -> None:
        """Risk is ten, so a ten-point gain moves the stop ten points up."""
        instrument = instruments(CALL)
        assert instrument is not None
        stop = risk_multiple_stop(
            direction=Direction.LONG,
            entry=rupees("100"),
            initial_stop=rupees("90"),
            extreme=rupees("110"),
            config=TrailConfig(),
            instrument=instrument,
        )
        assert stop == rupees("100")

    def test_steps_are_whole_so_the_level_does_not_jitter(
        self, instruments: InstrumentLookup
    ) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        for price in ("125", "128", "129.95"):
            stop = risk_multiple_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("90"),
                extreme=rupees(price),
                config=TrailConfig(),
                instrument=instrument,
            )
            assert stop == rupees("110"), f"two steps at {price}"

    def test_a_short_trails_downward(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        stop = risk_multiple_stop(
            direction=Direction.SHORT,
            entry=rupees("100"),
            initial_stop=rupees("110"),
            extreme=rupees("90"),
            config=TrailConfig(),
            instrument=instrument,
        )
        assert stop == rupees("100")

    def test_profit_is_measured_from_the_extreme_not_the_last_price(
        self, instruments: InstrumentLookup
    ) -> None:
        """Profit already earned counts even if the market has come back."""
        instrument = instruments(CALL)
        assert instrument is not None
        stop = risk_multiple_stop(
            direction=Direction.LONG,
            entry=rupees("100"),
            initial_stop=rupees("90"),
            extreme=rupees("120"),
            config=TrailConfig(),
            instrument=instrument,
        )
        assert stop == rupees("110")

    def test_a_percentage_gap_is_read_off_the_entry(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        config = TrailConfig(
            profit_gap=Decimal(10), stop_move_gap=Decimal(5), gap_unit=GapUnit.PERCENTAGE
        )
        stop = risk_multiple_stop(
            direction=Direction.LONG,
            entry=rupees("100"),
            initial_stop=rupees("90"),
            extreme=rupees("110"),
            config=config,
            instrument=instrument,
        )
        assert stop == rupees("95"), "one 10% step moves the stop 5% of entry"

    def test_no_risk_means_nothing_to_measure_in(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        assert (
            risk_multiple_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("100"),
                extreme=rupees("200"),
                config=TrailConfig(),
                instrument=instrument,
            )
            is None
        )


class TestTrailToCost:
    def test_it_moves_the_stop_to_break_even(self, instruments: InstrumentLookup) -> None:
        """The most valuable move: a position that can lose becomes one that
        cannot."""
        instrument = instruments(CALL)
        assert instrument is not None
        stop = trail_to_cost_stop(
            direction=Direction.LONG,
            entry=rupees("100"),
            initial_stop=rupees("90"),
            last=rupees("110"),
            config=TrailConfig(trail_to_cost_gap=Decimal(1)),
            instrument=instrument,
        )
        assert stop == rupees("100")

    def test_it_waits_until_the_threshold_is_reached(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        assert (
            trail_to_cost_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("90"),
                last=rupees("105"),
                config=TrailConfig(trail_to_cost_gap=Decimal(1)),
                instrument=instrument,
            )
            is None
        )

    def test_an_absolute_threshold_is_in_points(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        config = TrailConfig(trail_to_cost_gap=Decimal(5), trail_to_cost_unit=GapUnit.ABSOLUTE)
        assert trail_to_cost_stop(
            direction=Direction.LONG,
            entry=rupees("100"),
            initial_stop=rupees("90"),
            last=rupees("105"),
            config=config,
            instrument=instrument,
        ) == rupees("100")

    def test_it_is_measured_from_the_current_price(self, instruments: InstrumentLookup) -> None:
        """A position that gave its profit back should not have its stop
        pulled to a level the market has already passed."""
        instrument = instruments(CALL)
        assert instrument is not None
        assert (
            trail_to_cost_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("90"),
                last=rupees("95"),
                config=TrailConfig(trail_to_cost_gap=Decimal(1)),
                instrument=instrument,
            )
            is None
        )

    def test_it_does_nothing_unless_asked_for(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        assert (
            trail_to_cost_stop(
                direction=Direction.LONG,
                entry=rupees("100"),
                initial_stop=rupees("90"),
                last=rupees("150"),
                config=TrailConfig(),
                instrument=instrument,
            )
            is None
        )


class TestAStopOnlyTightens:
    def test_a_long_stop_may_rise(self) -> None:
        assert improves(Direction.LONG, rupees("95"), rupees("90"))

    def test_a_long_stop_may_not_fall(self) -> None:
        """A stop that can move away from the price is not a stop."""
        assert not improves(Direction.LONG, rupees("85"), rupees("90"))

    def test_a_short_stop_may_fall(self) -> None:
        assert improves(Direction.SHORT, rupees("105"), rupees("110"))

    def test_a_short_stop_may_not_rise(self) -> None:
        assert not improves(Direction.SHORT, rupees("115"), rupees("110"))

    async def test_a_lower_high_never_loosens_a_placed_stop(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The failure this rule exists for: giving back everything earned."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await service.on_tick(book.trade(trade.id) or trade, a_tick("120"))
        moved = book.trade(trade.id)
        assert moved is not None
        assert moved.protection.stop_loss == rupees("110")

        result = await service.on_tick(moved, a_tick("102"))
        assert result.outcome is TrailOutcome.HELD
        after = book.trade(trade.id)
        assert after is not None
        assert after.protection.stop_loss == rupees("110"), "it stayed where it was"


class TestMovingTheOrder:
    async def test_the_order_is_modified(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        result = await service.on_tick(trade, a_tick("110"))
        assert result.outcome is TrailOutcome.MOVED
        assert orders.modified[0][0] == STOP_ORDER
        assert orders.modified[0][1].trigger_price == rupees("100")

    async def test_the_initial_level_is_never_overwritten(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """It is what the risk was sized against, and what says the stop has
        been trailed at all."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await service.on_tick(trade, a_tick("110"))
        moved = book.trade(trade.id)
        assert moved is not None
        assert moved.protection.initial_stop_loss == rupees("90")
        assert moved.protection.has_moved

    async def test_a_failed_modify_leaves_the_stop_where_it_was(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        orders = FakeOrders()
        orders.modify_fails = RuntimeError("the broker refused")
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        result = await service.on_tick(trade, a_tick("110"))
        assert result.outcome is TrailOutcome.HELD
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.protection.stop_loss == rupees("90")

    async def test_a_missing_stop_order_is_not_moved_on_paper(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Moving the level alone would leave the engine believing in
        protection the broker does not have."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)

        result = await service.on_tick(trade, a_tick("110"))
        assert result.outcome is TrailOutcome.HELD
        assert orders.modified == []


class TestTheModificationCap:
    async def test_past_the_cap_the_order_is_replaced(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders, max_modifications=1)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        first = await service.on_tick(trade, a_tick("110"))
        assert first.outcome is TrailOutcome.MOVED

        second = await service.on_tick(book.trade(trade.id) or trade, a_tick("120"))
        assert second.outcome is TrailOutcome.REPLACED
        assert orders.cancelled == [STOP_ORDER]
        assert len(orders.placed) == 1

    async def test_a_cancel_that_fails_places_no_second_stop(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Two live stops on one position reverse it when both fire."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders, max_modifications=0)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        orders.cancel_fails = RuntimeError("the broker refused")

        result = await service.on_tick(trade, a_tick("110"))
        assert result.outcome is TrailOutcome.HELD
        assert orders.placed == []

    async def test_a_replacement_that_does_not_place_is_critical(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        from garuda.domain.alert import AlertLevel
        from garuda.protocols.topics import Topic

        orders = FakeOrders()
        orders.place_returns = None
        service, book = build(instruments, alerts, orders, max_modifications=0)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)
        seen = alerts.bus.subscribe(Topic.ALERTS, name="test")

        await service.on_tick(trade, a_tick("110"))
        levels = []
        while seen.depth:
            alert = await anext(aiter(seen))
            levels.append(alert.level)  # type: ignore[attr-defined]
        assert AlertLevel.CRITICAL in levels


class TestTrackedWithoutAnOrder:
    async def test_the_level_still_moves(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Trailing has to keep working, or the tracked level goes stale."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade(track_only=True)
        book.add_trade(trade)

        result = await service.on_tick(trade, a_tick("110"))
        assert result.outcome is TrailOutcome.TRACKED
        assert orders.modified == []
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.protection.stop_loss == rupees("100")


class TestModesWeCannotComputeYet:
    async def test_they_are_refused_loudly_rather_than_trailed_some_other_way(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade(trail=TrailConfig(mode=TrailingMode.ATR))
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        result = await service.on_tick(trade, a_tick("150"))
        assert result.outcome is TrailOutcome.UNSUPPORTED
        assert orders.modified == []

    def test_only_the_price_based_mode_needs_no_candles(self) -> None:
        assert not TrailingMode.RISK_MULTIPLE.needs_candles
        for mode in (TrailingMode.ATR, TrailingMode.EMA, TrailingMode.SUPER_TREND):
            assert mode.needs_candles


class TestWhatIsWatched:
    async def test_the_high_water_mark_is_remembered(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A restart that forgot it would trail from the price at restart,
        giving back everything the position had earned."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        await service.on_tick(trade, a_tick("125"))
        await service.on_tick(book.trade(trade.id) or trade, a_tick("105"))
        stored = book.trade(trade.id)
        assert stored is not None
        assert stored.high_since_entry == rupees("125")

    async def test_a_trade_on_its_way_out_is_left_alone(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade().exiting(TradeExitReason.SQUARE_OFF)
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        result = await service.on_tick(trade, a_tick("150"))
        assert result.outcome is TrailOutcome.HELD
        assert orders.modified == []


class TestWhatEachRuleMeasuresFrom:
    """The two rules deliberately measure from different things, and the
    difference only shows when a move is earned but not yet applied."""

    async def test_a_step_earned_at_the_high_is_still_taken_after_a_fall(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The broker refused the move at the high. When the next tick comes
        in lower, the stop must still go to the level the position earned --
        measuring from the current price would forget it."""
        orders = FakeOrders()
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade()
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        orders.modify_fails = RuntimeError("the broker refused")
        await service.on_tick(trade, a_tick("125"))
        held = book.trade(trade.id)
        assert held is not None
        assert held.protection.stop_loss == rupees("90"), "the move did not take"

        orders.modify_fails = None
        result = await service.on_tick(held, a_tick("105"))

        assert result.outcome is TrailOutcome.MOVED
        assert result.to_stop == rupees("110"), "two steps, earned at 125"

    async def test_break_even_is_not_taken_at_a_price_the_market_has_left(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A position that gave its profit back should not have its stop
        pulled up to a level the market has already passed."""
        orders = FakeOrders()
        # Only trail-to-cost can fire: the step gap is far out of reach.
        config = TrailConfig(profit_gap=Decimal(10_000), trail_to_cost_gap=Decimal(1))
        service, book = build(instruments, alerts, orders)
        trade = trailing_trade(trail=config)
        book.add_trade(trade)
        book.link_order(STOP_ORDER, trade.id, OrderRole.STOP)

        orders.modify_fails = RuntimeError("the broker refused")
        await service.on_tick(trade, a_tick("115"))
        held = book.trade(trade.id)
        assert held is not None
        assert held.protection.stop_loss == rupees("90")

        orders.modify_fails = None
        result = await service.on_tick(held, a_tick("95"))

        assert result.outcome is TrailOutcome.HELD
        assert orders.modified == []
