"""Orders: request validation, fill accumulation, and a total state machine."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.domain import Currency, DomainError, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.order import (
    ORDER_TRANSITIONS,
    ClientOrderId,
    Fill,
    IllegalOrderTransitionError,
    Order,
    OrderRequest,
    Side,
)

INSTRUMENT = InstrumentId("NSE:NIFTY26AUG25000CE")
CLIENT = TradingClientId("family-zerodha-1")


def request(order_type: OrderType = OrderType.MARKET, **overrides: object) -> OrderRequest:
    base: dict[str, object] = {
        "client_order_id": ClientOrderId("gar-0001"),
        "trading_client": CLIENT,
        "instrument": INSTRUMENT,
        "side": Side.BUY,
        "quantity": 150,
        "order_type": order_type,
        "product": ProductType.NRML,
    }
    if order_type in (OrderType.LIMIT, OrderType.SL_LIMIT):
        base["price"] = Money.of("120.50", Currency.INR)
    if order_type in (OrderType.SL_LIMIT, OrderType.SL_MARKET):
        base["trigger_price"] = Money.of("119.00", Currency.INR)
    return OrderRequest(**{**base, **overrides})  # type: ignore[arg-type]


def fill(quantity: int, price: str, side: Side = Side.BUY) -> Fill:
    return Fill(
        client_order_id=ClientOrderId("gar-0001"),
        instrument=INSTRUMENT,
        side=side,
        quantity=quantity,
        price=Money.of(price, Currency.INR),
        timestamp=datetime(2026, 8, 27, 9, 20, tzinfo=UTC),
    )


class TestRequestShape:
    @pytest.mark.parametrize("order_type", list(OrderType))
    def test_each_order_type_has_a_well_formed_request(self, order_type):
        assert request(order_type).order_type is order_type

    def test_a_limit_order_without_a_price_is_refused(self):
        with pytest.raises(DomainError, match="needs a price"):
            request(OrderType.LIMIT, price=None)

    def test_a_market_order_carrying_a_price_is_refused(self):
        """A price on a market order means someone confused two order types."""
        with pytest.raises(DomainError, match="takes no price"):
            request(OrderType.MARKET, price=Money.of("120", Currency.INR))

    def test_a_stop_order_without_a_trigger_is_refused(self):
        with pytest.raises(DomainError, match="needs a trigger price"):
            request(OrderType.SL_MARKET, trigger_price=None)

    def test_a_market_order_carrying_a_trigger_is_refused(self):
        with pytest.raises(DomainError, match="takes no trigger price"):
            request(OrderType.MARKET, trigger_price=Money.of("119", Currency.INR))

    @pytest.mark.parametrize("quantity", [0, -1])
    def test_a_non_positive_quantity_is_refused(self, quantity):
        with pytest.raises(DomainError, match="must be positive"):
            request(quantity=quantity)


class TestStateMachine:
    @pytest.mark.parametrize("origin", list(OrderStatus))
    def test_every_status_declares_its_legal_successors(self, origin):
        """Total: no status is missing from the table."""
        assert origin in ORDER_TRANSITIONS

    @pytest.mark.parametrize("origin", list(OrderStatus))
    @pytest.mark.parametrize("target", list(OrderStatus))
    def test_the_table_is_the_only_thing_that_decides(self, origin, target):
        order = Order(request=request(), status=origin)
        if target in ORDER_TRANSITIONS[origin]:
            assert order.transition_to(target).status is target
        else:
            with pytest.raises(IllegalOrderTransitionError):
                order.transition_to(target)

    @pytest.mark.parametrize(
        "status",
        [OrderStatus.FILLED, OrderStatus.CANCELLED, OrderStatus.REJECTED, OrderStatus.EXPIRED],
    )
    def test_a_terminal_status_goes_nowhere(self, status):
        assert ORDER_TRANSITIONS[status] == frozenset()
        assert Order(request=request(), status=status).is_terminal

    def test_unknown_is_reachable_from_every_live_status(self):
        """The broker can stop answering at any moment."""
        for origin, targets in ORDER_TRANSITIONS.items():
            if origin.is_terminal or origin is OrderStatus.UNKNOWN:
                continue
            assert OrderStatus.UNKNOWN in targets, origin

    def test_unknown_is_left_only_towards_a_real_state(self):
        """Reconciliation establishes the truth; nothing infers its way out."""
        assert OrderStatus.PENDING_NEW not in ORDER_TRANSITIONS[OrderStatus.UNKNOWN]
        assert OrderStatus.NEW in ORDER_TRANSITIONS[OrderStatus.UNKNOWN]


class TestFills:
    def test_a_full_fill_completes_the_order(self):
        order = (
            Order(request=request()).transition_to(OrderStatus.NEW).apply_fill(fill(150, "120.00"))
        )
        assert order.status is OrderStatus.FILLED
        assert order.remaining_quantity == 0

    def test_a_partial_fill_leaves_the_order_working(self):
        order = (
            Order(request=request()).transition_to(OrderStatus.NEW).apply_fill(fill(50, "120.00"))
        )
        assert order.status is OrderStatus.PARTIALLY_FILLED
        assert order.remaining_quantity == 100

    def test_partial_fills_average_exactly(self):
        """Quantity-weighted, unrounded. Rounding each fill compounds the error."""
        order = Order(request=request()).transition_to(OrderStatus.NEW)
        order = order.apply_fill(fill(50, "100.00"))
        order = order.apply_fill(fill(100, "130.00"))
        assert order.status is OrderStatus.FILLED
        # (50*100 + 100*130) / 150 = 120
        assert order.average_fill_price == Money(Decimal(120), Currency.INR)

    def test_an_average_that_does_not_divide_evenly_is_not_rounded_away(self):
        order = Order(request=request(quantity=3)).transition_to(OrderStatus.NEW)
        order = order.apply_fill(fill(1, "100"))
        order = order.apply_fill(fill(1, "101"))
        order = order.apply_fill(fill(1, "103"))
        assert order.average_fill_price is not None
        assert order.average_fill_price.amount == Decimal(304) / Decimal(3)

    def test_overfilling_is_refused(self):
        order = Order(request=request()).transition_to(OrderStatus.NEW).apply_fill(fill(100, "120"))
        with pytest.raises(DomainError, match="above the ordered"):
            order.apply_fill(fill(51, "120"))

    def test_a_fill_for_another_order_is_refused(self):
        order = Order(request=request(client_order_id=ClientOrderId("gar-9999"))).transition_to(
            OrderStatus.NEW
        )
        with pytest.raises(DomainError, match="belongs to"):
            order.apply_fill(fill(10, "120"))

    def test_a_fill_on_the_wrong_side_is_refused(self):
        order = Order(request=request()).transition_to(OrderStatus.NEW)
        with pytest.raises(DomainError, match="contradicts"):
            order.apply_fill(fill(10, "120", side=Side.SELL))


class TestSide:
    def test_sides_are_opposites(self):
        assert Side.BUY.opposite is Side.SELL
        assert Side.SELL.opposite is Side.BUY

    def test_the_sign_is_what_makes_quantities_signed(self):
        assert Side.BUY.sign == 1
        assert Side.SELL.sign == -1
