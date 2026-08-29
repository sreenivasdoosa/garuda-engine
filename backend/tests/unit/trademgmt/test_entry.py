"""Turning a signal into a position.

The failure mode worth testing is not a missing trade but a duplicate one: an
order that reached the broker while the engine believed it had not.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import timedelta

from garuda.alerts.manager import AlertManager
from garuda.domain import OrderType
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.trade_signal import EntryRules, ReEntryRules, SignalType
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.broker import OrderRejectedError, RetryableBrokerError
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.dedup import InstrumentLookup
from garuda.trademgmt.entry import EntryOutcome, EntryService
from garuda.trademgmt.entry_rules import Refusal, entry_order_shape, should_place_trade
from tests.unit.trademgmt.conftest import (
    CALL,
    CLIENT,
    FAR_CALL,
    LABEL,
    PUT,
    TODAY,
    a_signal,
    hedge_of,
    rupees,
)


class FakeBroker:
    """Records placements; answers lookups as the test says to."""

    def __init__(self) -> None:
        self.placed: list[OrderRequest] = []
        self.fail_with: Exception | None = None
        self.existing: dict[ClientOrderId, BrokerOrderId] = {}
        self.lookup_raises: Exception | None = None
        self.lookups: list[ClientOrderId] = []
        self._next = 1

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        self.placed.append(request)
        if self.fail_with is not None:
            raise self.fail_with
        broker_id = BrokerOrderId(f"260831{self._next:06d}")
        self._next += 1
        return broker_id

    async def find(self, client_order_id: ClientOrderId) -> BrokerOrderId | None:
        self.lookups.append(client_order_id)
        if self.lookup_raises is not None:
            raise self.lookup_raises
        return self.existing.get(client_order_id)


def a_tick(instrument: InstrumentId = CALL, price: str = "120") -> Tick:
    return Tick(instrument, rupees(price), TODAY)


def service(
    instruments: InstrumentLookup,
    alerts: AlertManager,
    broker: FakeBroker,
    *,
    subscribed: bool = True,
) -> tuple[EntryService, TradingClientManager]:
    from garuda.core.clock import ReplayClock

    book = TradingClientManager(CLIENT, LABEL, instruments, alerts)
    subject = EntryService(
        book,
        broker.place,
        broker.find,
        instruments,
        ReplayClock(TODAY),
        alerts,
        is_subscribed=lambda client, strategy: subscribed,
    )
    return subject, book


class TestTheGate:
    def test_a_fresh_signal_may_be_placed(self) -> None:
        assert should_place_trade(a_signal(), TODAY).should_place

    def test_a_triggered_signal_may_not(self) -> None:
        decision = should_place_trade(a_signal().triggered(), TODAY)
        assert decision.refusal is Refusal.TRIGGERED

    def test_a_disabled_signal_may_not(self) -> None:
        decision = should_place_trade(a_signal().disable("stopped"), TODAY)
        assert decision.refusal is Refusal.DISABLED

    def test_an_expired_signal_may_not(self) -> None:
        signal = a_signal()
        signal = replace(
            signal,
            entry=EntryRules(trigger=rupees("120"), valid_till=TODAY - timedelta(minutes=1)),
        )
        assert should_place_trade(signal, TODAY).refusal is Refusal.EXPIRED

    def test_a_signal_held_back_may_not_yet(self) -> None:
        signal = replace(
            a_signal(),
            entry=EntryRules(trigger=rupees("120"), not_before=TODAY + timedelta(minutes=10)),
        )
        assert should_place_trade(signal, TODAY).refusal is Refusal.TOO_EARLY

    def test_an_unsubscribed_strategy_may_not(self) -> None:
        decision = should_place_trade(a_signal(), TODAY, is_subscribed=False)
        assert decision.refusal is Refusal.NOT_SUBSCRIBED

    def test_the_entry_cap_counts_both_directions(self) -> None:
        """Reversing after a stop is still another entry."""
        signal = replace(a_signal(), re_entry=ReEntryRules(max_entries=2))
        assert should_place_trade(signal, TODAY, entries_so_far=1).should_place
        assert (
            should_place_trade(signal, TODAY, entries_so_far=2).refusal is Refusal.ENTRY_CAP_REACHED
        )

    def test_the_gate_never_compares_a_price(self) -> None:
        """Deciding a level was crossed belongs to the strategy engine; the
        signal's trigger is the price the order goes out at."""
        far_from_trigger = replace(a_signal(), entry=EntryRules(trigger=rupees("9999")))
        assert should_place_trade(far_from_trigger, TODAY).should_place


class TestTheOrderThatGoesOut:
    def test_a_plain_signal_becomes_a_limit_at_its_trigger(
        self, instruments: InstrumentLookup
    ) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        shape = entry_order_shape(a_signal(), instrument, a_tick())
        assert shape.order_type is OrderType.LIMIT
        assert shape.price == rupees("120")

    def test_a_market_signal_becomes_a_market_order(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(), entry=EntryRules(trigger=rupees("120"), place_market_order=True)
        )
        shape = entry_order_shape(signal, instrument, a_tick())
        assert shape.order_type is OrderType.MARKET
        assert shape.price is None

    def test_a_buffer_prices_a_buy_above_the_trigger(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(signal_type=SignalType.LONG_ENTRY),
            entry=EntryRules(trigger=rupees("120"), limit_buffer_percent=rupees("1").amount),
        )
        shape = entry_order_shape(signal, instrument, a_tick())
        assert shape.price == rupees("121.20")

    def test_a_buffer_prices_a_sell_below_the_trigger(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(),
            entry=EntryRules(trigger=rupees("120"), limit_buffer_percent=rupees("1").amount),
        )
        shape = entry_order_shape(signal, instrument, a_tick())
        assert shape.price == rupees("118.80")

    def test_a_stop_limit_entry_carries_its_trigger(self, instruments: InstrumentLookup) -> None:
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(signal_type=SignalType.LONG_ENTRY),
            entry=EntryRules(
                trigger=rupees("125"),
                trigger_limit=rupees("126"),
                entry_with_stop_limit_order=True,
            ),
        )
        shape = entry_order_shape(signal, instrument, a_tick(price="120"))
        assert shape.order_type is OrderType.SL_LIMIT
        assert shape.trigger_price == rupees("125")
        assert shape.price == rupees("126")

    def test_a_stop_limit_whose_price_already_passed_goes_plain(
        self, instruments: InstrumentLookup
    ) -> None:
        """The trigger will never be crossed from the right side again, so a
        resting stop order would sit there for ever."""
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(signal_type=SignalType.LONG_ENTRY),
            entry=EntryRules(
                trigger=rupees("125"),
                trigger_limit=rupees("126"),
                entry_with_stop_limit_order=True,
            ),
        )
        shape = entry_order_shape(signal, instrument, a_tick(price="130"))
        assert shape.order_type is OrderType.LIMIT

    def test_without_a_price_the_stop_limit_stands(self, instruments: InstrumentLookup) -> None:
        """Guessing the market has moved is worse than a resting order."""
        instrument = instruments(CALL)
        assert instrument is not None
        signal = replace(
            a_signal(signal_type=SignalType.LONG_ENTRY),
            entry=EntryRules(
                trigger=rupees("125"),
                trigger_limit=rupees("126"),
                entry_with_stop_limit_order=True,
            ),
        )
        assert entry_order_shape(signal, instrument, None).order_type is OrderType.SL_LIMIT


class TestPlacing:
    async def test_a_signal_becomes_a_trade_and_an_order(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())

        result = await subject.consider(a_signal(), a_tick())

        assert result.outcome is EntryOutcome.PLACED
        assert result.trade is not None
        assert result.trade.state is TradeState.OPEN
        assert len(broker.placed) == 1
        assert broker.placed[0].side is Side.SELL
        assert broker.placed[0].quantity == 75

    async def test_the_signal_is_marked_triggered_once_placed(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        await subject.consider(a_signal(), a_tick())

        stored = book.signal("sig-1")
        assert stored is not None
        assert stored.is_triggered

    async def test_the_order_is_linked_back_to_its_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Both the push stream and the poll arrive knowing only an order id."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        result = await subject.consider(a_signal(), a_tick())

        found = book.trade_for_order(BrokerOrderId("260831000001"))
        assert found is not None
        assert result.trade is not None
        assert found.id == result.trade.id

    async def test_the_trade_inherits_the_signals_group_and_protection(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        signal = a_signal(group="wings", tranche=2)
        await book.add_signal(signal)

        result = await subject.consider(signal, a_tick())
        assert result.trade is not None
        assert result.trade.group == "wings"
        assert result.trade.tranche == 2
        assert result.trade.signal_id == "sig-1"

    async def test_the_client_order_id_fits_a_brokers_tag(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Kite truncates at twenty characters, and a shortened tag matches
        nothing on the way back."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        await subject.consider(a_signal(), a_tick())
        assert len(broker.placed[0].client_order_id.value) <= 20


class TestNotPlacingTwice:
    async def test_a_signal_with_a_live_trade_is_not_placed_again(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """The restart guard: a lost triggered flag would otherwise place a
        second position for one decision."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        # A cap of one would refuse the second pass by itself, which is not
        # the guard under test.
        signal = replace(a_signal(), re_entry=ReEntryRules(max_entries=3))
        await book.add_signal(signal)
        await subject.consider(signal, a_tick())

        stored = book.signal("sig-1")
        assert stored is not None
        forgotten = replace(stored, is_triggered=False)
        book.replace_signal(forgotten)

        result = await subject.consider(forgotten, a_tick())
        assert result.outcome is EntryOutcome.RECOVERED
        assert len(broker.placed) == 1, "no second order"

        recovered = book.signal("sig-1")
        assert recovered is not None
        assert recovered.is_triggered, "and the flag is put back"

    async def test_an_uncertain_failure_does_not_place_again(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A timeout is not a failure to place: the order may be resting at
        the exchange."""
        broker = FakeBroker()
        broker.fail_with = RetryableBrokerError("the connection dropped")
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())

        first = await subject.consider(a_signal(), a_tick())
        assert first.outcome is EntryOutcome.DEFERRED

        broker.fail_with = None
        second = await subject.consider(book.signal("sig-1"), a_tick())  # type: ignore[arg-type]
        assert second.outcome is EntryOutcome.DEFERRED
        assert len(broker.placed) == 1, "the second pass looked rather than placed"
        assert broker.lookups, "and it looked by the tag the first attempt carried"

    async def test_an_order_found_at_the_broker_is_adopted(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        broker.fail_with = RetryableBrokerError("the connection dropped")
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        await subject.consider(a_signal(), a_tick())

        # It had reached the exchange after all.
        broker.existing[broker.placed[0].client_order_id] = BrokerOrderId("260831999999")
        broker.fail_with = None

        result = await subject.consider(book.signal("sig-1"), a_tick())  # type: ignore[arg-type]
        assert result.outcome is EntryOutcome.RECOVERED
        assert len(broker.placed) == 1
        assert book.trade_for_order(BrokerOrderId("260831999999")) is not None

    async def test_an_unanswerable_lookup_places_nothing(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """An unknown order is a reason to do nothing, never to guess."""
        broker = FakeBroker()
        broker.fail_with = RetryableBrokerError("dropped")
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        await subject.consider(a_signal(), a_tick())

        broker.fail_with = None
        broker.lookup_raises = RetryableBrokerError("the broker is rate limiting us")
        result = await subject.consider(book.signal("sig-1"), a_tick())  # type: ignore[arg-type]

        assert result.outcome is EntryOutcome.DEFERRED
        assert len(broker.placed) == 1


class TestGivingUp:
    async def test_a_definitive_rejection_can_be_retried_once(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Refused before it reached the exchange, so no order exists and a
        fresh one is safe."""
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("price band")
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())

        first = await subject.consider(a_signal(), a_tick())
        assert first.outcome is EntryOutcome.DEFERRED

        second = await subject.consider(book.signal("sig-1"), a_tick())  # type: ignore[arg-type]
        assert second.outcome is EntryOutcome.FAILED
        assert len(broker.placed) == 2

    async def test_a_failed_entry_disables_the_signal_and_records_a_trade(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Visible where the operator looks for trades, not only in alerts."""
        broker = FakeBroker()
        broker.fail_with = OrderRejectedError("insufficient margin")
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal())
        await subject.consider(a_signal(), a_tick())
        result = await subject.consider(book.signal("sig-1"), a_tick())  # type: ignore[arg-type]

        assert result.trade is not None
        assert result.trade.state is TradeState.CANCELLED
        assert result.trade.exit_reason is TradeExitReason.ENTRY_FAILED
        assert "margin" in (result.trade.failure_reason or "")

        stored = book.signal("sig-1")
        assert stored is not None
        assert stored.disabled

    async def test_a_hedge_whose_main_leg_failed_is_flagged(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A bought option protecting nothing simply decays. The mark is
        durable so the orphan is squared off even after a restart."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)

        hedge_signal = a_signal(
            "sig-hedge",
            instrument=FAR_CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=hedge_of("h-1", role=LegRole.HEDGE),
        )
        await book.add_signal(hedge_signal)
        hedge_result = await subject.consider(hedge_signal, a_tick(FAR_CALL))
        assert hedge_result.trade is not None
        book.replace_trade(hedge_result.trade.with_entry_fill(75, rupees("5"), TODAY))

        main_signal = a_signal(
            "sig-main", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN)
        )
        await book.add_signal(main_signal)
        broker.fail_with = OrderRejectedError("margin")
        await subject.consider(main_signal, a_tick(PUT))
        await subject.consider(book.signal("sig-main"), a_tick(PUT))  # type: ignore[arg-type]

        hedge = book.trade(hedge_result.trade.id)
        assert hedge is not None
        assert hedge.relationships.main_entry_failed


class TestLegOrdering:
    async def test_a_later_leg_waits_for_the_one_ahead_to_fill(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        first = a_signal(
            "sig-1",
            instrument=FAR_CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=hedge_of("h-1", role=LegRole.HEDGE, sequence=1),
        )
        second = a_signal(
            "sig-2", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN, sequence=2)
        )
        await book.add_signal(first)
        await book.add_signal(second)

        result = await subject.consider(second, a_tick(PUT))
        assert result.outcome is EntryOutcome.DEFERRED
        assert broker.placed == []

    async def test_it_goes_once_the_leg_ahead_has_filled(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        first = a_signal(
            "sig-1",
            instrument=FAR_CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=hedge_of("h-1", role=LegRole.HEDGE, sequence=1),
        )
        second = a_signal(
            "sig-2", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN, sequence=2)
        )
        await book.add_signal(first)
        await book.add_signal(second)

        placed = await subject.consider(first, a_tick(FAR_CALL))
        assert placed.trade is not None
        book.replace_trade(placed.trade.with_entry_fill(75, rupees("5"), TODAY))

        result = await subject.consider(book.signal("sig-2"), a_tick(PUT))  # type: ignore[arg-type]
        assert result.outcome is EntryOutcome.PLACED

    async def test_a_leg_whose_predecessor_was_abandoned_is_abandoned_too(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A sold leg whose protective buy is never coming must never be placed."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        first = a_signal(
            "sig-1",
            instrument=FAR_CALL,
            signal_type=SignalType.LONG_ENTRY,
            relationships=hedge_of("h-1", role=LegRole.HEDGE, sequence=1),
        )
        second = a_signal(
            "sig-2", instrument=PUT, relationships=hedge_of("h-1", role=LegRole.MAIN, sequence=2)
        )
        await book.add_signal(first)
        await book.add_signal(second)
        await book.disable_signal("sig-1", "the broker refused it")

        result = await subject.consider(second, a_tick(PUT))
        assert result.outcome is EntryOutcome.REFUSED
        stored = book.signal("sig-2")
        assert stored is not None
        assert stored.disabled
        assert broker.placed == []


class TestDrivenByTicks:
    async def test_only_signals_watching_that_instrument_are_considered(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(a_signal("sig-call", instrument=CALL))
        await book.add_signal(a_signal("sig-put", instrument=PUT, group="other"))

        results = await subject.on_tick(a_tick(CALL))
        assert [r.signal.id for r in results] == ["sig-call"]

    async def test_the_long_side_is_considered_first(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """A pair of opposing signals on one symbol must not both fire."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        await book.add_signal(
            a_signal("sig-long", instrument=CALL, signal_type=SignalType.LONG_ENTRY)
        )
        await book.add_signal(a_signal("sig-short", instrument=CALL, group="other"))

        results = await subject.on_tick(a_tick(CALL))
        assert [r.signal.id for r in results] == ["sig-long"]
        assert len(broker.placed) == 1

    async def test_the_short_side_is_considered_when_the_long_does_nothing(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        long_signal = a_signal("sig-long", instrument=CALL, signal_type=SignalType.LONG_ENTRY)
        await book.add_signal(long_signal)
        await book.add_signal(a_signal("sig-short", instrument=CALL, group="other"))
        await book.disable_signal("sig-long", "stopped")

        results = await subject.on_tick(a_tick(CALL))
        assert any(r.signal.id == "sig-short" and r.entered for r in results)

    async def test_an_expired_signal_is_retired_rather_than_reconsidered(
        self, instruments: InstrumentLookup, alerts: AlertManager
    ) -> None:
        """Disabled, so it stops being looked at on every tick all day."""
        broker = FakeBroker()
        subject, book = service(instruments, alerts, broker)
        expired = replace(
            a_signal(),
            entry=EntryRules(trigger=rupees("120"), valid_till=TODAY - timedelta(minutes=1)),
        )
        await book.add_signal(expired)

        result = await subject.consider(expired, a_tick())
        assert result.outcome is EntryOutcome.REFUSED
        stored = book.signal("sig-1")
        assert stored is not None
        assert stored.disabled
