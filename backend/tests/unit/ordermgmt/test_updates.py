"""Folding pushed order updates into the book.

Every claim here is about a frame that is wrong, late, duplicated, or about
somebody else's account -- which is what a broker's push channel actually
delivers.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from garuda.domain import Currency, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.order import BrokerOrderId, ClientOrderId, Fill, Order, OrderRequest, Side
from garuda.ordermgmt.updates import OrderUpdateRouter, apply_update
from garuda.protocols.account import OrderUpdate

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
OWNER = TradingClientId("appa-zerodha")
OTHER = TradingClientId("amma-zerodha")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def an_order(instrument: Instrument, quantity: int = 100) -> Order:
    return Order(
        request=OrderRequest(
            client_order_id=ClientOrderId("gar-1"),
            trading_client=OWNER,
            instrument=instrument.id,
            side=Side.BUY,
            quantity=quantity,
            order_type=OrderType.LIMIT,
            product=ProductType.NRML,
            price=rupees("120"),
        )
    )


def an_update(
    instrument: Instrument,
    *,
    filled: int = 0,
    quantity: int = 100,
    status: OrderStatus | None = OrderStatus.NEW,
    average: str | None = "120",
    client_id: str = "AB1234",
    at: datetime | None = None,
) -> OrderUpdate:
    return OrderUpdate(
        broker_order_id=BrokerOrderId("260831000001"),
        broker_client_id=client_id,
        client_order_id=ClientOrderId("gar-1"),
        instrument=instrument.id,
        side=Side.BUY,
        quantity=quantity,
        filled_quantity=filled,
        status=status,
        average_price=rupees(average) if average is not None else None,
        at=at or T0,
    )


class TestTerminalStickiness:
    def test_a_filled_order_ignores_a_later_open_frame(self, reliance: Instrument) -> None:
        """There is no transition out of terminal, so the frame is stale."""
        order = an_order(reliance)
        order = order.transition_to(OrderStatus.NEW)
        order = order.apply_fill(_fill(reliance, 100, "120"))
        assert order.status is OrderStatus.FILLED, "a complete fill is terminal on its own"

        result = apply_update(order, an_update(reliance, filled=0, status=OrderStatus.NEW), T0)
        assert not result.changed
        assert "already" in (result.ignored or "")

    def test_a_cancelled_order_ignores_a_later_fill(self, reliance: Instrument) -> None:
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        order = order.transition_to(OrderStatus.CANCELLED)

        result = apply_update(order, an_update(reliance, filled=100, status=OrderStatus.FILLED), T0)
        assert not result.changed

    def test_a_rejected_order_stays_rejected(self, reliance: Instrument) -> None:
        order = an_order(reliance).transition_to(OrderStatus.REJECTED, reason="margin")
        result = apply_update(order, an_update(reliance, status=OrderStatus.NEW), T0)
        assert not result.changed


class TestFillsNeverRegress:
    def test_a_frame_reporting_fewer_filled_is_discarded(self, reliance: Instrument) -> None:
        """An old frame, not an execution being undone."""
        working = an_order(reliance).transition_to(OrderStatus.NEW)
        partly = apply_update(
            working, an_update(reliance, filled=60, status=OrderStatus.NEW), T0
        ).order
        assert partly is not None
        assert partly.filled_quantity == 60

        late = apply_update(partly, an_update(reliance, filled=25, status=OrderStatus.NEW), T0)
        assert not late.changed
        assert "old frame" in (late.ignored or "")

    def test_a_repeated_frame_fills_nothing_twice(self, reliance: Instrument) -> None:
        """Duplicates are routine on a push channel."""
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        update = an_update(reliance, filled=60, status=OrderStatus.NEW)

        first = apply_update(order, update, T0)
        assert first.order is not None
        assert first.order.filled_quantity == 60

        second = apply_update(first.order, update, T0)
        assert not second.changed
        assert second.fill is None

    def test_only_the_increment_becomes_a_fill(self, reliance: Instrument) -> None:
        """The broker counts cumulatively; the book accumulates."""
        working = an_order(reliance).transition_to(OrderStatus.NEW)
        partly = apply_update(working, an_update(reliance, filled=40), T0).order
        assert partly is not None

        result = apply_update(partly, an_update(reliance, filled=100), T0)
        assert result.fill is not None
        assert result.fill.quantity == 60
        assert result.order is not None
        assert result.order.filled_quantity == 100

    def test_a_fill_without_a_price_is_not_applied(self, reliance: Instrument) -> None:
        """A quantity with no price would put a zero into the average."""
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        result = apply_update(order, an_update(reliance, filled=50, average=None), T0)
        assert not result.changed
        assert "no price" in (result.ignored or "")


class TestStatus:
    def test_a_status_the_broker_did_not_send_changes_nothing(self, reliance: Instrument) -> None:
        """No status means no news, not an unknown state."""
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        result = apply_update(order, an_update(reliance, filled=0, status=None), T0)
        assert not result.changed

    def test_a_fill_moves_the_status_with_it(self, reliance: Instrument) -> None:
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        result = apply_update(order, an_update(reliance, filled=100, status=OrderStatus.FILLED), T0)
        assert result.order is not None
        assert result.order.status is OrderStatus.FILLED

    def test_a_frame_behind_the_book_does_not_roll_it_back(self, reliance: Instrument) -> None:
        """A fill already took it further than this frame knows about."""
        order = an_order(reliance).transition_to(OrderStatus.NEW)
        filled = apply_update(
            order, an_update(reliance, filled=100, status=OrderStatus.FILLED), T0
        ).order
        assert filled is not None

        late = apply_update(
            filled,
            an_update(reliance, filled=100, status=OrderStatus.NEW, at=T0 - timedelta(seconds=1)),
            T0,
        )
        assert not late.changed


class TestRoutingByTheClientOnTheFrame:
    """One dealer session carries several accounts."""

    def resolver(self) -> OrderUpdateRouter:
        accounts = {"AB1234": OWNER, "CD5678": OTHER}
        return OrderUpdateRouter(accounts.get, books={})

    def test_an_update_goes_to_the_account_it_names(self, reliance: Instrument) -> None:
        router = self.resolver()
        update = an_update(reliance, client_id="CD5678")
        assert router.route(update, arrived_on=OWNER) == OTHER

    def test_the_stream_owner_is_only_the_fallback(self, reliance: Instrument) -> None:
        router = self.resolver()
        update = an_update(reliance, client_id="")
        assert router.route(update, arrived_on=OWNER) == OWNER

    def test_an_account_the_engine_does_not_know_is_refused_not_guessed(
        self, reliance: Instrument
    ) -> None:
        """Those orders are executing and nothing is watching them."""
        router = self.resolver()
        update = an_update(reliance, client_id="ZZ9999")
        assert router.route(update, arrived_on=OWNER) is None


def _fill(instrument: Instrument, quantity: int, price: str) -> Fill:
    return Fill(
        client_order_id=ClientOrderId("gar-1"),
        instrument=instrument.id,
        side=Side.BUY,
        quantity=quantity,
        price=rupees(price),
        timestamp=T0,
    )
