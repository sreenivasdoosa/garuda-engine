"""Market protection.

The arithmetic decides what price a live order goes out at, so the numbers
here are stated explicitly rather than recomputed from the same expressions
the production code uses.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Segment
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.order import ClientOrderId, OrderRequest, Side
from garuda.domain.protection import (
    DEFAULT_BUFFERS,
    LOW_PREMIUM_THRESHOLD,
    MINIMUM_OPTION_PRICE,
    ProtectionSegment,
    SegmentBuffers,
    clamp_sl_limit,
    marketable_limit_price,
    sl_limit_from_trigger,
)
from garuda.ordermgmt.protection import ExchangeProtection, MarketProtection

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")

EQUITY = DEFAULT_BUFFERS[ProtectionSegment.EQUITY]
OPTIONS = DEFAULT_BUFFERS[ProtectionSegment.OPTIONS]


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def request(
    instrument: Instrument,
    order_type: OrderType,
    side: Side = Side.BUY,
    price: Money | None = None,
    trigger_price: Money | None = None,
) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId("gar-1"),
        trading_client=CLIENT,
        instrument=instrument.id,
        side=side,
        quantity=75,
        order_type=order_type,
        product=ProductType.NRML,
        price=price,
        trigger_price=trigger_price,
    )


def protection(
    instrument: Instrument,
    last: Money | None,
    configured: ExchangeProtection | None = None,
) -> MarketProtection:
    return MarketProtection(
        broker="zerodha",
        config=lambda broker, exchange: configured,
        last_price=lambda instrument_id: last,
        instruments=lambda instrument_id: instrument,
    )


class TestTheGate:
    """Whether a raw market order may be sent is configuration, and nothing else."""

    def test_an_unconfigured_venue_protects(self, nifty_call: Instrument) -> None:
        """A missing row means not allowed, so protection is the default."""
        result = protection(nifty_call, rupees("120"), configured=None).apply(
            request(nifty_call, OrderType.MARKET)
        )
        assert result.request.order_type is OrderType.LIMIT

    def test_a_venue_configured_to_allow_them_sends_market_untouched(
        self, nifty_call: Instrument
    ) -> None:
        allowed = ExchangeProtection(market_orders_allowed=True)
        result = protection(nifty_call, rupees("120"), allowed).apply(
            request(nifty_call, OrderType.MARKET)
        )
        assert result.request.order_type is OrderType.MARKET
        assert not result.was_changed

    def test_a_venue_configured_to_refuse_them_protects(self, nifty_call: Instrument) -> None:
        refused = ExchangeProtection(market_orders_allowed=False)
        result = protection(nifty_call, rupees("120"), refused).apply(
            request(nifty_call, OrderType.MARKET)
        )
        assert result.request.order_type is OrderType.LIMIT

    def test_the_same_order_is_protected_on_one_venue_and_not_another(
        self, nifty_call: Instrument, mcx: Exchange
    ) -> None:
        """It is a property of the (broker, exchange) row, not of the broker."""
        gold = replace(
            nifty_call,
            id=InstrumentId("MCX:GOLD26SEP"),
            exchange=mcx,
            trading_symbol="GOLD26SEP",
            segment=Segment.COMMODITY,
        )
        by_exchange = {"NSE": ExchangeProtection(market_orders_allowed=True)}
        subject = MarketProtection(
            broker="zerodha",
            config=lambda broker, exchange: by_exchange.get(exchange),
            last_price=lambda instrument_id: rupees("120"),
            instruments=lambda instrument_id: gold if instrument_id == gold.id else nifty_call,
        )
        assert subject.apply(request(nifty_call, OrderType.MARKET)).request.order_type is (
            OrderType.MARKET
        ), "NSE is configured to allow them"
        assert subject.apply(request(gold, OrderType.MARKET)).request.order_type is (
            OrderType.LIMIT
        ), "MCX has no row at all, so it protects"


class TestMarketBecomesLimit:
    def test_a_buy_is_priced_above_the_market(self, nifty_call: Instrument) -> None:
        """15% on an option: 120 becomes 138."""
        price = marketable_limit_price(
            rupees("120"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.BUY
        )
        assert price == rupees("138")

    def test_a_sell_is_priced_below_the_market(self, nifty_call: Instrument) -> None:
        price = marketable_limit_price(
            rupees("120"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.SELL
        )
        assert price == rupees("102")

    def test_equity_stays_tight(self, reliance: Instrument) -> None:
        """1%, because the exchange's stop-loss band is about three."""
        price = marketable_limit_price(
            rupees("2885"), reliance, ProtectionSegment.EQUITY, EQUITY, Side.BUY
        )
        assert price == rupees("2913.85")

    def test_rounding_never_eats_into_the_buffer(self, nifty_call: Instrument) -> None:
        """Snapping to the tick may only make a protected order more marketable."""
        buffers = SegmentBuffers(Decimal("0.1"), Decimal(1))
        buy = marketable_limit_price(
            rupees("120.02"), nifty_call, ProtectionSegment.OPTIONS, buffers, Side.BUY
        )
        sell = marketable_limit_price(
            rupees("120.02"), nifty_call, ProtectionSegment.OPTIONS, buffers, Side.SELL
        )
        assert buy >= rupees("120.14")
        assert sell <= rupees("119.90")

    def test_a_cheap_option_gets_a_much_wider_buy_buffer(self, nifty_call: Instrument) -> None:
        """A one-rupee option moves fifteen per cent in a tick."""
        price = marketable_limit_price(
            rupees("4"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.BUY
        )
        assert price == rupees("5.60")

    def test_a_cheap_option_gets_a_narrower_sell_buffer_than_buy(
        self, nifty_call: Instrument
    ) -> None:
        price = marketable_limit_price(
            rupees("4"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.SELL
        )
        assert price == rupees("3.20")

    def test_the_escalation_applies_at_the_threshold_itself(self, nifty_call: Instrument) -> None:
        at_threshold = Money(LOW_PREMIUM_THRESHOLD, Currency.INR)
        price = marketable_limit_price(
            at_threshold, nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.BUY
        )
        assert price == rupees("7")

    def test_an_option_never_goes_out_at_zero(self, nifty_call: Instrument) -> None:
        price = marketable_limit_price(
            rupees("0.05"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.SELL
        )
        assert price == Money(MINIMUM_OPTION_PRICE, Currency.INR)

    def test_protecting_against_no_price_is_refused(self, nifty_call: Instrument) -> None:
        with pytest.raises(DomainError, match="price of nothing"):
            marketable_limit_price(
                rupees("0"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.BUY
            )

    def test_without_a_live_price_the_order_stays_market(self, nifty_call: Instrument) -> None:
        """The broker's own rejection beats a limit price invented from nothing."""
        result = protection(nifty_call, last=None).apply(request(nifty_call, OrderType.MARKET))
        assert result.request.order_type is OrderType.MARKET
        assert not result.was_changed


class TestStopMarketBecomesStopLimit:
    def test_a_buy_stop_limit_sits_above_its_trigger(self, nifty_call: Instrument) -> None:
        """The trigger is where it went against you; the limit must be beyond it."""
        price = sl_limit_from_trigger(
            rupees("100"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.BUY
        )
        assert price == rupees("118")

    def test_a_sell_stop_limit_sits_below_its_trigger(self, nifty_call: Instrument) -> None:
        price = sl_limit_from_trigger(
            rupees("100"), nifty_call, ProtectionSegment.OPTIONS, OPTIONS, Side.SELL
        )
        assert price == rupees("82")

    def test_the_order_type_and_the_price_both_change(self, nifty_call: Instrument) -> None:
        result = protection(nifty_call, rupees("120")).apply(
            request(nifty_call, OrderType.SL_MARKET, Side.SELL, trigger_price=rupees("100"))
        )
        assert result.request.order_type is OrderType.SL_LIMIT
        assert result.request.price == rupees("82")
        assert result.request.trigger_price == rupees("100")

    def test_rounding_stays_inside_the_permitted_band(self, reliance: Instrument) -> None:
        """Rounding outward is how a stop-loss lands outside the exchange's range."""
        buffers = SegmentBuffers(Decimal(1), Decimal(1))
        buy = sl_limit_from_trigger(
            rupees("2885.55"), reliance, ProtectionSegment.EQUITY, buffers, Side.BUY
        )
        assert buy <= rupees("2914.41")


class TestClampingAStopLimit:
    def test_a_limit_inside_the_band_is_left_alone(self, reliance: Instrument) -> None:
        limit = clamp_sl_limit(
            rupees("2900"), rupees("2885"), reliance, ProtectionSegment.EQUITY, EQUITY
        )
        assert limit == rupees("2900")

    def test_a_limit_far_above_the_trigger_is_pulled_back(self, reliance: Instrument) -> None:
        """The INFY case: a limit sized like an option's, rejected fifteen times."""
        limit = clamp_sl_limit(
            rupees("3400"), rupees("2885"), reliance, ProtectionSegment.EQUITY, EQUITY
        )
        assert limit == rupees("2913.85")

    def test_a_limit_far_below_the_trigger_is_pulled_up(self, reliance: Instrument) -> None:
        limit = clamp_sl_limit(
            rupees("2000"), rupees("2885"), reliance, ProtectionSegment.EQUITY, EQUITY
        )
        assert limit == rupees("2856.15")

    def test_clamping_narrows_and_never_widens(self, reliance: Instrument) -> None:
        original = rupees("2890")
        trigger = rupees("2885")
        clamped = clamp_sl_limit(original, trigger, reliance, ProtectionSegment.EQUITY, EQUITY)
        assert abs(clamped.amount - trigger.amount) <= abs(original.amount - trigger.amount)

    def test_the_request_is_clamped_on_its_way_out(self, reliance: Instrument) -> None:
        result = protection(reliance, rupees("2885")).apply(
            request(
                reliance,
                OrderType.SL_LIMIT,
                Side.BUY,
                price=rupees("3400"),
                trigger_price=rupees("2885"),
            )
        )
        assert result.request.price == rupees("2913.85")
        assert result.was_changed

    def test_an_already_valid_stop_limit_is_reported_unchanged(self, reliance: Instrument) -> None:
        result = protection(reliance, rupees("2885")).apply(
            request(
                reliance,
                OrderType.SL_LIMIT,
                Side.BUY,
                price=rupees("2900"),
                trigger_price=rupees("2885"),
            )
        )
        assert not result.was_changed


class TestSegments:
    def test_an_option_is_an_option(self, nifty_call: Instrument) -> None:
        assert ProtectionSegment.of(nifty_call) is ProtectionSegment.OPTIONS

    def test_a_stock_is_equity(self, reliance: Instrument) -> None:
        assert ProtectionSegment.of(reliance) is ProtectionSegment.EQUITY

    def test_configured_buffers_win_over_the_defaults(self, nifty_call: Instrument) -> None:
        configured = ExchangeProtection(
            market_orders_allowed=False,
            buffers={ProtectionSegment.OPTIONS: SegmentBuffers(Decimal(5), Decimal(5))},
        )
        result = protection(nifty_call, rupees("120"), configured).apply(
            request(nifty_call, OrderType.MARKET)
        )
        assert result.request.price == rupees("126")

    def test_a_buffer_of_nothing_is_refused(self) -> None:
        with pytest.raises(DomainError, match="would not protect"):
            SegmentBuffers(Decimal(0), Decimal(1))


class TestALimitOrderIsLeftAlone:
    def test_a_plain_limit_order_is_never_touched(self, nifty_call: Instrument) -> None:
        original = request(nifty_call, OrderType.LIMIT, price=rupees("120"))
        result = protection(nifty_call, rupees("125")).apply(original)
        assert result.request == original
        assert not result.was_changed
