"""The paper broker.

The claims worth making are about the fill model, because a paper broker that
fills optimistically makes every strategy look profitable.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.brokers.paper import PaperBroker, PaperFillPolicy
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.market import DepthLevel, Tick
from garuda.domain.order import ClientOrderId, OrderRequest, Side
from garuda.protocols.broker import (
    BrokerAdapter,
    OrderAccepted,
    OrderCancelled,
    OrderFilled,
    OrderRejected,
    OrderRejectedError,
)

T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha-paper")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@pytest.fixture
def clock() -> ReplayClock:
    return ReplayClock(T0)


@pytest.fixture
def broker(clock: ReplayClock, nifty_call: Instrument) -> PaperBroker:
    return PaperBroker(CLIENT, clock, {nifty_call.id: nifty_call})


def quote(
    instrument: Instrument, last: str, bid: str | None = None, ask: str | None = None
) -> Tick:
    return Tick(
        instrument=instrument.id,
        last_price=rupees(last),
        timestamp=T0,
        bids=(DepthLevel(rupees(bid), 50),) if bid else (),
        asks=(DepthLevel(rupees(ask), 50),) if ask else (),
    )


def order(
    instrument: Instrument,
    side: Side = Side.BUY,
    order_type: OrderType = OrderType.MARKET,
    price: str | None = None,
    trigger: str | None = None,
    order_id: str = "gar-1",
) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId(order_id),
        trading_client=CLIENT,
        instrument=instrument.id,
        side=side,
        quantity=75,
        order_type=order_type,
        product=ProductType.NRML,
        price=rupees(price) if price else None,
        trigger_price=rupees(trigger) if trigger else None,
    )


def fills(broker: PaperBroker) -> list[OrderFilled]:
    return [e for e in broker.drain_events() if isinstance(e, OrderFilled)]


class TestContract:
    def test_it_is_a_broker_adapter(self, broker):
        assert isinstance(broker, BrokerAdapter)

    def test_it_knows_which_account_it_trades(self, broker):
        assert broker.trading_client == CLIENT


class TestTheFillIsNeverAtMid:
    async def test_a_buy_crosses_to_the_ask_and_pays_slippage(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY))

        (filled,) = fills(broker)
        # ask 120.10 + one tick of 0.05
        assert filled.fill.price == rupees("120.15")

    async def test_a_sell_crosses_to_the_bid_and_pays_slippage(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.SELL))

        (filled,) = fills(broker)
        assert filled.fill.price == rupees("119.85")

    async def test_neither_side_ever_fills_at_the_mid(self, broker, nifty_call):
        tick = quote(nifty_call, "120.00", bid="119.90", ask="120.10")
        await broker.on_tick(tick)
        await broker.place(order(nifty_call, Side.BUY, order_id="b"))
        await broker.place(order(nifty_call, Side.SELL, order_id="s"))

        prices = [f.fill.price for f in fills(broker)]
        assert tick.mid == rupees("120.00")
        assert all(price != tick.mid for price in prices)

    async def test_a_round_trip_at_a_static_price_loses_money(self, broker, nifty_call):
        """Crossing the spread twice costs. A mid-fill model would show zero."""
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY, order_id="b"))
        await broker.place(order(nifty_call, Side.SELL, order_id="s"))

        position = broker.position(nifty_call.id)
        assert position is not None
        assert position.is_flat
        assert position.realized_pnl.is_negative

    async def test_without_depth_the_spread_is_assumed_not_ignored(self, broker, nifty_call):
        """Filling at the last traded price is a fill at mid by another name."""
        await broker.on_tick(quote(nifty_call, "120.00"))
        await broker.place(order(nifty_call, Side.BUY))

        (filled,) = fills(broker)
        # last 120.00 + half of a 2-tick spread (0.05) + 1 tick slippage (0.05)
        assert filled.fill.price == rupees("120.10")
        assert filled.fill.price > rupees("120.00")

    async def test_the_policy_states_its_assumptions(self, broker):
        assert "slippage" in broker.policy.describe()

    async def test_a_wider_slippage_setting_costs_more(self, clock, nifty_call):
        expensive = PaperBroker(
            CLIENT,
            clock,
            {nifty_call.id: nifty_call},
            PaperFillPolicy(slippage_ticks=4),
        )
        await expensive.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await expensive.place(order(nifty_call, Side.BUY))
        (filled,) = fills(expensive)
        assert filled.fill.price == rupees("120.30")


class TestNoQuote:
    async def test_an_order_with_no_quote_is_refused(self, broker, nifty_call):
        """Fail closed: the broker does not invent a price."""
        with pytest.raises(OrderRejectedError, match="no quote"):
            await broker.place(order(nifty_call))

    async def test_the_rejection_is_reported_as_an_event(self, broker, nifty_call):
        with pytest.raises(OrderRejectedError):
            await broker.place(order(nifty_call))
        rejections = [e for e in broker.drain_events() if isinstance(e, OrderRejected)]
        assert len(rejections) == 1
        assert "does not invent a price" in rejections[0].reason


class TestLimitOrders:
    async def test_a_marketable_limit_fills(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY, OrderType.LIMIT, price="121.00"))
        assert len(fills(broker)) == 1

    async def test_an_unmarketable_limit_rests_instead_of_filling(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY, OrderType.LIMIT, price="119.00"))
        assert fills(broker) == []

    async def test_a_resting_limit_fills_when_the_market_comes_to_it(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY, OrderType.LIMIT, price="119.00"))
        assert fills(broker) == []

        await broker.on_tick(quote(nifty_call, "118.80", bid="118.75", ask="118.85"))
        (filled,) = fills(broker)
        assert filled.fill.price <= rupees("119.00")

    async def test_a_limit_never_fills_worse_than_its_limit(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "119.00", bid="118.95", ask="119.00"))
        await broker.place(order(nifty_call, Side.BUY, OrderType.LIMIT, price="119.00"))
        for filled in fills(broker):
            assert filled.fill.price <= rupees("119.00")


class TestStopOrders:
    async def test_a_stop_does_not_fire_before_its_trigger(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.SELL, OrderType.SL_MARKET, trigger="115.00"))
        assert fills(broker) == []

    async def test_a_sell_stop_fires_when_the_price_falls_to_it(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.SELL, OrderType.SL_MARKET, trigger="115.00"))
        await broker.on_tick(quote(nifty_call, "114.50", bid="114.45", ask="114.55"))
        assert len(fills(broker)) == 1

    async def test_a_buy_stop_fires_when_the_price_rises_to_it(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.BUY, OrderType.SL_MARKET, trigger="125.00"))
        await broker.on_tick(quote(nifty_call, "125.50", bid="125.45", ask="125.55"))
        assert len(fills(broker)) == 1


class TestLifecycle:
    async def test_placing_reports_acceptance(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call))
        assert any(isinstance(e, OrderAccepted) for e in broker.drain_events())

    async def test_cancelling_a_resting_order_reports_it(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        broker_order_id = await broker.place(
            order(nifty_call, Side.BUY, OrderType.LIMIT, price="100.00")
        )
        await broker.cancel(broker_order_id)
        assert any(isinstance(e, OrderCancelled) for e in broker.drain_events())

    async def test_a_cancelled_order_no_longer_fills(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        broker_order_id = await broker.place(
            order(nifty_call, Side.BUY, OrderType.LIMIT, price="100.00")
        )
        await broker.cancel(broker_order_id)
        broker.drain_events()

        await broker.on_tick(quote(nifty_call, "99.00", bid="98.95", ask="99.05"))
        assert fills(broker) == []

    async def test_fills_move_the_position(self, broker, nifty_call):
        await broker.on_tick(quote(nifty_call, "120.00", bid="119.90", ask="120.10"))
        await broker.place(order(nifty_call, Side.SELL))

        position = broker.position(nifty_call.id)
        assert position is not None
        assert position.quantity == -75

    async def test_an_unknown_instrument_is_refused(self, broker, reliance):
        with pytest.raises(OrderRejectedError, match="unknown to the paper broker"):
            await broker.place(order(reliance))


class TestDeterminism:
    """A paper session must replay to the same result as the run that recorded it."""

    async def run_session(self, nifty_call: Instrument) -> list[Money]:
        broker = PaperBroker(CLIENT, ReplayClock(T0), {nifty_call.id: nifty_call})
        prices = ["120.00", "121.00", "119.00", "122.50"]
        for index, last in enumerate(prices):
            bid = Decimal(last) - Decimal("0.10")
            ask = Decimal(last) + Decimal("0.10")
            await broker.on_tick(quote(nifty_call, last, str(bid), str(ask)))
            side = Side.BUY if index % 2 == 0 else Side.SELL
            await broker.place(order(nifty_call, side, order_id=f"gar-{index}"))
        return [f.fill.price for f in fills(broker)]

    async def test_two_identical_sessions_produce_identical_fills(self, nifty_call):
        assert await self.run_session(nifty_call) == await self.run_session(nifty_call)

    async def test_the_fill_model_uses_no_randomness(self, nifty_call):
        """Rule-based rejection and fixed slippage, so nothing needs a seed."""
        runs = [await self.run_session(nifty_call) for _ in range(5)]
        assert all(run == runs[0] for run in runs)
