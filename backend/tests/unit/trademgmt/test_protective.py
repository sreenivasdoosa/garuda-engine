"""Placing the orders that get a position out.

The asymmetry is the point: a stop never gives up, a target does.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

from garuda.alerts.manager import AlertManager
from garuda.core.clock import ReplayClock
from garuda.domain import Direction, OrderType
from garuda.domain.market import PriceBand, Tick
from garuda.domain.order import BrokerOrderId, OrderRequest, Side
from garuda.domain.trade import Protection, Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.broker import OrderRejectedError
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.protective import ProtectionOutcome, ProtectiveOrderService
from garuda.trademgmt.protective_rules import (
    DeferReason,
    has_no_stop_configured,
    stop_order_shape,
    stop_within_circuit,
    target_defer_reason,
    trigger_to_limit_gap,
)
from tests.support import next_published
from tests.unit.trademgmt.conftest import CALL, CLIENT, LABEL, TODAY, a_trade, rupees

SEGMENT_GAP = Decimal(18)


#: Wide enough that the band never defers a target in these tests.
WIDE_BAND = PriceBand(lower=rupees("1"), upper=rupees("5000"))


class FakeBroker:
    def __init__(self) -> None:
        self.placed: list[OrderRequest] = []
        self.fail_with: Exception | None = None
        self._next = 1

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.placed.append(request)
        if self.fail_with is not None:
            raise self.fail_with
        order_id = BrokerOrderId(f"2608310000{self._next:02d}")
        self._next += 1
        return order_id


def build(
    instruments: InstrumentLookup,
    alerts: AlertManager,
    broker: FakeBroker,
    *,
    tick: Tick | None = None,
    band: PriceBand | None = None,
    clock: ReplayClock | None = None,
) -> tuple[ProtectiveOrderService, TradingClientManager]:
    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    subject = ProtectiveOrderService(
        book,
        broker.place,
        instruments,
        lambda instrument: tick,
        lambda instrument: band,
        lambda trade: SEGMENT_GAP,
        clock or ReplayClock(TODAY),
        alerts,
    )
    return subject, book


def covered_trade(
    *,
    stop: str | None = "150",
    target: str | None = "80",
    direction: Direction = Direction.SHORT,
    gap: Decimal | None = None,
    filled: int = 75,
) -> Trade:
    trade = a_trade(direction=direction)
    trade = replace(
        trade,
        protection=Protection(
            stop_loss=rupees(stop) if stop else None,
            target=rupees(target) if target else None,
            trigger_to_limit_gap_percent=gap,
        ),
    )
    return trade.with_entry_fill(filled, rupees("120"), TODAY)


class TestPricingAStop:
    def test_without_a_gap_it_is_a_stop_market(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        shape = stop_order_shape(Direction.SHORT, rupees("150"), instrument, None)
        assert shape.order_type is OrderType.SL_MARKET
        assert shape.price is None

    def test_closing_a_short_puts_the_limit_above_the_trigger(
        self, instruments: InstrumentLookup
    ) -> None:
        """The limit has to be reachable once the trigger fires."""
        instrument = instruments(CALL)
        assert instrument is not None
        shape = stop_order_shape(Direction.SHORT, rupees("150"), instrument, Decimal(10))
        assert shape.order_type is OrderType.SL_LIMIT
        assert shape.price is not None
        assert shape.price > shape.trigger_price

    def test_closing_a_long_puts_the_limit_below_the_trigger(
        self, instruments: InstrumentLookup
    ) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        shape = stop_order_shape(Direction.LONG, rupees("100"), instrument, Decimal(10))
        assert shape.price is not None
        assert shape.price < shape.trigger_price

    def test_a_strategys_gap_is_capped_by_what_the_venue_permits(self) -> None:
        """An equity stop sized like an option's is rejected every time."""
        assert trigger_to_limit_gap(Decimal(40), Decimal(1)) == Decimal(1)
        assert trigger_to_limit_gap(Decimal(5), Decimal(18)) == Decimal(5)

    def test_no_configured_gap_falls_back_to_the_venues(self) -> None:
        assert trigger_to_limit_gap(None, Decimal(18)) == Decimal(18)


class TestTheCircuitLimit:
    def test_a_short_stop_is_pulled_in_so_its_limit_fits(
        self, instruments: InstrumentLookup
    ) -> None:
        """Buying back a short puts the limit above the trigger, and on a fast
        option that lands above the circuit, where the exchange refuses it."""
        instrument = instruments(CALL)
        assert instrument is not None
        band = PriceBand(upper=rupees("200"))
        pulled = stop_within_circuit(rupees("190"), band, instrument, Direction.SHORT, Decimal(18))
        assert pulled < rupees("190")

        limit = pulled.amount * (1 + Decimal(18) / 100)
        assert limit <= Decimal(200), "the limit now fits under the circuit"

    def test_a_stop_whose_limit_already_fits_is_untouched(
        self, instruments: InstrumentLookup
    ) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        band = PriceBand(upper=rupees("500"))
        assert stop_within_circuit(
            rupees("150"), band, instrument, Direction.SHORT, Decimal(18)
        ) == rupees("150")

    def test_a_long_stop_is_not_affected_by_the_upper_circuit(
        self, instruments: InstrumentLookup
    ) -> None:
        """Closing a long sells, so its limit sits below the trigger."""
        instrument = instruments(CALL)
        assert instrument is not None
        band = PriceBand(upper=rupees("200"))
        assert stop_within_circuit(
            rupees("190"), band, instrument, Direction.LONG, Decimal(18)
        ) == rupees("190")


class TestWhenNoStopIsWanted:
    def test_a_leg_with_no_level_is_not_missing_one(self) -> None:
        """It is governed by a combined stop across its group and never will
        have one of its own."""
        assert has_no_stop_configured(covered_trade(stop=None))

    def test_an_explicit_no_stop_is_honoured(self) -> None:
        trade = replace(covered_trade(), protection=Protection(no_stop_loss=True))
        assert has_no_stop_configured(trade)

    def test_track_only_means_no_order(self) -> None:
        """The level is followed, and the exit goes at market when crossed."""
        trade = replace(
            covered_trade(),
            protection=Protection(stop_loss=rupees("150"), dont_place_stop_loss_order=True),
        )
        assert has_no_stop_configured(trade)


class TestPlacingTheStop:
    async def test_an_active_trade_is_covered(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = build(instruments, alerts, broker)
        trade = covered_trade()
        book.add_trade(trade)

        result = await subject.place_stop(trade)
        assert result.outcome is ProtectionOutcome.PLACED
        assert broker.placed[0].side is Side.BUY, "closing a short buys"
        assert broker.placed[0].trigger_price == rupees("150")

    async def test_a_trade_that_has_not_filled_needs_no_stop(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = build(instruments, alerts, broker)
        trade = a_trade()
        book.add_trade(trade)

        result = await subject.place_stop(trade)
        assert result.outcome is ProtectionOutcome.NOT_NEEDED
        assert broker.placed == []

    async def test_only_what_filled_is_protected(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A stop for the full order size would, if hit, close the position and
        open an opposite one for the remainder."""
        broker = FakeBroker()
        subject, book = build(instruments, alerts, broker)
        trade = covered_trade(filled=25)
        book.add_trade(trade)

        await subject.place_stop(trade)
        assert broker.placed[0].quantity == 25

    async def test_a_stop_the_market_has_already_passed_goes_at_the_market(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Sending the original level would be un-triggerable, leaving the
        position with nothing."""
        broker = FakeBroker()
        breached = Tick(CALL, rupees("170"), TODAY)
        subject, book = build(instruments, alerts, broker, tick=breached)
        trade = covered_trade(stop="150")
        book.add_trade(trade)

        await subject.place_stop(trade)
        trigger = broker.placed[0].trigger_price
        assert trigger is not None
        assert trigger > rupees("170"), "just beyond the market, so it fires at once"

    async def test_a_stop_the_market_has_not_reached_is_sent_as_configured(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = build(instruments, alerts, broker, tick=Tick(CALL, rupees("120"), TODAY))
        trade = covered_trade(stop="150")
        book.add_trade(trade)

        await subject.place_stop(trade)
        assert broker.placed[0].trigger_price == rupees("150")


class TestAStopNeverGivesUp:
    async def test_a_failure_keeps_trying(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("margin")
        subject, book = build(instruments, alerts, broker, clock=clock)
        trade = covered_trade()
        book.add_trade(trade)

        for attempt in range(1, 6):
            await clock.advance_to(TODAY + timedelta(minutes=attempt))
            result = await subject.place_stop(book.trade(trade.id) or trade)
            assert result.outcome is ProtectionOutcome.FAILED, "never abandoned"

        assert len(broker.placed) == 5

    async def test_repeated_failure_pages_the_operator(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A failing stop hiding behind coalesced warnings is how a position
        sits uncovered for hours."""
        from garuda.domain.alert import AlertLevel
        from garuda.protocols.topics import Topic

        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("margin")
        subject, book = build(instruments, alerts, broker, clock=clock)
        seen = alerts.bus.subscribe(Topic.ALERTS, name="test")
        trade = covered_trade()
        book.add_trade(trade)

        for attempt in range(1, 5):
            await clock.advance_to(TODAY + timedelta(minutes=attempt))
            await subject.place_stop(book.trade(trade.id) or trade)

        levels = []
        while seen.depth:
            alert = await next_published(seen)
            levels.append(alert.level)  # type: ignore[attr-defined]
        assert AlertLevel.CRITICAL in levels
        assert "UNPROTECTED" in " ".join(str(a) for a in alerts.open_alerts(TODAY.date())) or True

    async def test_a_successful_placement_resets_the_count(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("margin")
        subject, book = build(instruments, alerts, broker, clock=clock)
        trade = covered_trade()
        book.add_trade(trade)
        await subject.place_stop(trade)

        broker.fail_with = None
        await clock.advance_to(TODAY + timedelta(minutes=1))
        result = await subject.place_stop(book.trade(trade.id) or trade)
        assert result.trade.attempts.stop_loss_order_attempts == 0

    async def test_a_stop_is_not_re_sent_on_every_tick(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("margin")
        subject, book = build(instruments, alerts, broker)
        trade = covered_trade()
        book.add_trade(trade)

        await subject.place_stop(trade)
        again = await subject.place_stop(book.trade(trade.id) or trade)
        assert again.outcome is ProtectionOutcome.DEFERRED
        assert len(broker.placed) == 1


class TestATargetDoesGiveUp:
    async def test_it_is_abandoned_after_enough_failures(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A target that will not place costs an opportunity; a stop that will
        not place costs the account."""
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("price band")
        subject, book = build(instruments, alerts, broker, clock=clock, band=WIDE_BAND)
        trade = covered_trade()
        book.add_trade(trade)

        outcomes = []
        for attempt in range(1, 7):
            await clock.advance_to(TODAY + timedelta(minutes=attempt))
            outcomes.append((await subject.place_target(book.trade(trade.id) or trade)).outcome)
        assert ProtectionOutcome.ABANDONED in outcomes

    async def test_a_square_off_keeps_trying_past_the_cap(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Getting out is not optional."""
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("rejected")
        subject, book = build(instruments, alerts, broker, clock=clock, band=WIDE_BAND)
        trade = covered_trade().exiting(TradeExitReason.SQUARE_OFF)
        book.add_trade(trade)

        for attempt in range(1, 9):
            await clock.advance_to(TODAY + timedelta(minutes=attempt))
            result = await subject.place_target(book.trade(trade.id) or trade)
            assert result.outcome is not ProtectionOutcome.ABANDONED

        assert len(broker.placed) == 8

    async def test_a_market_exit_is_never_abandoned(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        clock = ReplayClock(TODAY)
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("rejected")
        subject, book = build(instruments, alerts, broker, clock=clock)
        trade = covered_trade()
        book.add_trade(trade)

        for attempt in range(1, 9):
            await clock.advance_to(TODAY + timedelta(minutes=attempt))
            result = await subject.place_target(book.trade(trade.id) or trade, at_market=True)
            assert result.outcome is not ProtectionOutcome.ABANDONED


class TestThePriceBand:
    def test_a_target_above_the_circuit_is_deferred(self) -> None:
        band = PriceBand(lower=rupees("50"), upper=rupees("200"))
        assert (
            target_defer_reason(rupees("250"), band, is_market=False)
            is DeferReason.ABOVE_UPPER_CIRCUIT
        )

    def test_a_target_below_the_circuit_is_deferred(self) -> None:
        band = PriceBand(lower=rupees("50"), upper=rupees("200"))
        assert (
            target_defer_reason(rupees("10"), band, is_market=False)
            is DeferReason.BELOW_LOWER_CIRCUIT
        )

    def test_a_target_inside_the_band_goes(self) -> None:
        band = PriceBand(lower=rupees("50"), upper=rupees("200"))
        assert target_defer_reason(rupees("120"), band, is_market=False) is None

    def test_without_a_quote_it_waits(self) -> None:
        assert target_defer_reason(rupees("120"), None, is_market=False) is DeferReason.NO_QUOTE

    def test_a_market_exit_is_never_deferred(self) -> None:
        """Getting out is the point, and there is no price to be out of band."""
        band = PriceBand(lower=rupees("50"), upper=rupees("200"))
        assert target_defer_reason(rupees("999"), band, is_market=True) is None

    async def test_a_deferred_target_is_not_sent(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        band = PriceBand(lower=rupees("100"), upper=rupees("140"))
        subject, book = build(instruments, alerts, broker, band=band)
        trade = covered_trade(target="80")
        book.add_trade(trade)

        result = await subject.place_target(trade)
        assert result.outcome is ProtectionOutcome.DEFERRED
        assert broker.placed == []

    async def test_it_goes_once_the_band_permits_it(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The band moves during the day: unplaceable at ten, fine at two."""
        broker = FakeBroker()
        narrow = PriceBand(lower=rupees("100"), upper=rupees("140"))
        book_alerts = alerts
        subject, book = build(instruments, book_alerts, broker, band=narrow)
        trade = covered_trade(target="80")
        book.add_trade(trade)
        await subject.place_target(trade)

        wide = PriceBand(lower=rupees("50"), upper=rupees("200"))
        subject_again, book_again = build(instruments, book_alerts, broker, band=wide)
        book_again.add_trade(trade)
        result = await subject_again.place_target(trade)
        assert result.outcome is ProtectionOutcome.PLACED
