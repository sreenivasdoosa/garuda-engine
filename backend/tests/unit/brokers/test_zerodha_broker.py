"""The Zerodha adapter, driven against a fake Kite.

The claims are about what goes out on the wire, what comes back as engine
types, and which of Kite's refusals mean which thing to the engine.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest

from garuda.brokers.zerodha.broker import MAX_TAG_LENGTH, ZerodhaBroker
from garuda.brokers.zerodha.mapping import status_from_kite
from garuda.brokers.zerodha.rest import KiteClient
from garuda.domain import Currency, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.broker import (
    AuthExpiredError,
    FatalBrokerError,
    OrderChanges,
    OrderRejectedError,
    RateLimitedError,
    RetryableBrokerError,
)

CLIENT = TradingClientId("appa-zerodha")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


class FakeKite:
    """Records requests; answers with whatever the test sets up."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.responses: list[tuple[int, dict[str, Any]]] = []

    def answer(self, payload: dict[str, Any], status: int = 200) -> None:
        self.responses.append((status, payload))

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if not self.responses:
            return httpx.Response(200, json={"status": "success", "data": {}})
        status, payload = self.responses.pop(0)
        return httpx.Response(status, json=payload)

    @property
    def last(self) -> httpx.Request:
        return self.requests[-1]

    def form(self) -> dict[str, str]:
        from urllib.parse import parse_qs

        body = self.last.content.decode()
        return {k: v[0] for k, v in parse_qs(body).items()}


@pytest.fixture
def kite() -> FakeKite:
    return FakeKite()


@pytest.fixture
def registry(nifty_call: Instrument, reliance: Instrument) -> InstrumentRegistry:
    return InstrumentRegistry.build([nifty_call, reliance])


@pytest.fixture
def broker(kite: FakeKite, registry: InstrumentRegistry) -> ZerodhaBroker:
    client = httpx.AsyncClient(transport=httpx.MockTransport(kite.handler))
    return ZerodhaBroker(CLIENT, KiteClient("key", "token", client), lambda: registry)


def a_request(
    instrument: Instrument,
    order_type: OrderType = OrderType.LIMIT,
    price: Money | None = None,
    trigger_price: Money | None = None,
    product: ProductType = ProductType.NRML,
    order_id: str = "gar-1",
) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId(order_id),
        trading_client=CLIENT,
        instrument=instrument.id,
        side=Side.BUY,
        quantity=75,
        order_type=order_type,
        product=product,
        price=price
        if price is not None
        else (rupees("120") if order_type.name.endswith("LIMIT") else None),
        trigger_price=trigger_price,
    )


class TestAuthentication:
    async def test_every_call_is_signed(self, broker: ZerodhaBroker, kite: FakeKite) -> None:
        kite.answer({"status": "success", "data": []})
        await broker.fetch_orders()
        assert kite.last.headers["authorization"] == "token key:token"
        assert kite.last.headers["x-kite-version"] == "3"


class TestPlacing:
    async def test_an_order_goes_out_in_kites_vocabulary(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "260831000001"}})
        order_id = await broker.place(a_request(nifty_call))

        assert order_id == BrokerOrderId("260831000001")
        form = kite.form()
        assert form["tradingsymbol"] == nifty_call.trading_symbol
        assert form["transaction_type"] == "BUY"
        assert form["order_type"] == "LIMIT"
        assert form["quantity"] == "75"
        assert form["product"] == "NRML"
        assert form["validity"] == "DAY"
        assert form["price"] == "120"

    async def test_a_derivative_is_routed_to_its_segment_exchange(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """Kite lists options under NFO, not under the venue that lists them."""
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(nifty_call))
        assert kite.form()["exchange"] == "NFO"

    async def test_a_stock_goes_to_the_venue_itself(
        self, broker: ZerodhaBroker, kite: FakeKite, reliance: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(reliance))
        assert kite.form()["exchange"] == "NSE"

    async def test_the_client_order_id_travels_as_the_tag(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """The tag is how an order coming back is matched to the one sent."""
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(nifty_call, order_id="gar-42"))
        assert kite.form()["tag"] == "gar-42"

    async def test_a_tag_too_long_for_kite_is_refused_not_truncated(
        self, broker: ZerodhaBroker, nifty_call: Instrument
    ) -> None:
        """Kite shortens it silently, and a shortened tag matches nothing."""
        with pytest.raises(OrderRejectedError, match="at most 20"):
            await broker.place(a_request(nifty_call, order_id="g" * (MAX_TAG_LENGTH + 1)))

    async def test_a_stop_order_carries_its_trigger(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(
            a_request(
                nifty_call,
                OrderType.SL_LIMIT,
                price=rupees("118"),
                trigger_price=rupees("120"),
            )
        )
        form = kite.form()
        assert form["order_type"] == "SL"
        assert form["trigger_price"] == "120"

    async def test_a_market_order_carries_no_price(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(nifty_call, OrderType.MARKET))
        assert "price" not in kite.form()

    async def test_a_cover_order_uses_its_own_variety(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """Kite distinguishes cover and bracket by endpoint, not by product."""
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(nifty_call, product=ProductType.CO))
        assert str(kite.last.url).endswith("/orders/co")
        assert kite.form()["product"] == "MIS"

    async def test_a_price_never_goes_out_in_scientific_notation(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.place(a_request(nifty_call, price=rupees("0.05")))
        assert kite.form()["price"] == "0.05"

    async def test_an_accepted_order_with_no_id_is_a_rejection(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """Nothing can be reconciled against an order with no broker id."""
        kite.answer({"status": "success", "data": {}})
        with pytest.raises(OrderRejectedError, match="no order id"):
            await broker.place(a_request(nifty_call))


class TestTheErrorTaxonomy:
    """A caller decides what to do from the type, never from the message."""

    @pytest.mark.parametrize(
        ("error_type", "expected"),
        [
            ("TokenException", AuthExpiredError),
            ("OrderException", OrderRejectedError),
            ("InputException", OrderRejectedError),
            ("MarginException", OrderRejectedError),
            ("PermissionException", FatalBrokerError),
            ("NetworkException", RetryableBrokerError),
            ("GatewayException", RetryableBrokerError),
            ("TooManyRequestsException", RateLimitedError),
        ],
    )
    async def test_kites_error_types_map_to_the_engines(
        self,
        broker: ZerodhaBroker,
        kite: FakeKite,
        nifty_call: Instrument,
        error_type: str,
        expected: type[Exception],
    ) -> None:
        kite.answer({"status": "error", "message": "no", "error_type": error_type}, status=400)
        with pytest.raises(expected):
            await broker.place(a_request(nifty_call))

    async def test_the_brokers_own_words_survive(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """The body's message is the operator's only account of what went wrong."""
        kite.answer(
            {
                "status": "error",
                "message": "Market orders without market protection are not allowed via API",
                "error_type": "InputException",
            },
            status=400,
        )
        with pytest.raises(OrderRejectedError, match="market protection"):
            await broker.place(a_request(nifty_call))

    async def test_an_unmapped_error_type_is_fatal_not_retried(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """Retrying what nobody classified turns one rejection into six."""
        kite.answer(
            {"status": "error", "message": "?", "error_type": "BrandNewException"}, status=400
        )
        with pytest.raises(FatalBrokerError):
            await broker.place(a_request(nifty_call))

    async def test_a_gateway_returning_html_is_retryable(
        self, broker: ZerodhaBroker, kite: FakeKite
    ) -> None:
        """It says nothing about the request, only about the path it took."""
        transport = httpx.MockTransport(lambda r: httpx.Response(502, text="<html>nope"))
        client = KiteClient("key", "token", httpx.AsyncClient(transport=transport))
        subject = ZerodhaBroker(CLIENT, client, lambda: InstrumentRegistry())
        with pytest.raises(RetryableBrokerError):
            await subject.fetch_orders()

    async def test_a_timeout_is_retryable_because_the_order_may_have_landed(self) -> None:
        def timeout(request: httpx.Request) -> httpx.Response:
            raise httpx.ReadTimeout("too slow", request=request)

        client = KiteClient(
            "key", "token", httpx.AsyncClient(transport=httpx.MockTransport(timeout))
        )
        subject = ZerodhaBroker(CLIENT, client, lambda: InstrumentRegistry())
        with pytest.raises(RetryableBrokerError, match="timed out"):
            await subject.fetch_orders()


class TestReadingTheOrderBook:
    def row(self, symbol: str, **overrides: Any) -> dict[str, Any]:
        row = {
            "order_id": "260831000001",
            "tag": "gar-1",
            "tradingsymbol": symbol,
            "exchange": "NFO",
            "transaction_type": "BUY",
            "order_type": "LIMIT",
            "product": "NRML",
            "quantity": 75,
            "filled_quantity": 0,
            "status": "OPEN",
            "average_price": 0,
        }
        row.update(overrides)
        return row

    async def test_an_order_comes_back_as_engine_types(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer({"status": "success", "data": [self.row(nifty_call.trading_symbol)]})
        (order,) = await broker.fetch_orders()

        assert order.broker_order_id == BrokerOrderId("260831000001")
        assert order.client_order_id == ClientOrderId("gar-1")
        assert order.instrument == nifty_call.id
        assert order.side is Side.BUY
        assert order.status is OrderStatus.NEW
        assert order.product is ProductType.NRML

    async def test_an_order_for_something_not_in_the_master_is_skipped(
        self, broker: ZerodhaBroker, kite: FakeKite
    ) -> None:
        """A manual trade in an unsubscribed symbol must not stop the book."""
        kite.answer({"status": "success", "data": [self.row("SOMETHINGELSE")]})
        assert await broker.fetch_orders() == []

    async def test_a_partly_filled_live_order_says_so(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """Kite does not distinguish it from OPEN at all."""
        kite.answer(
            {
                "status": "success",
                "data": [self.row(nifty_call.trading_symbol, filled_quantity=25)],
            }
        )
        (order,) = await broker.fetch_orders()
        assert order.status is OrderStatus.PARTIALLY_FILLED
        assert order.filled_quantity == 25


class TestStatusTranslation:
    def test_kites_statuses_map_explicitly(self) -> None:
        assert status_from_kite("COMPLETE") is OrderStatus.FILLED
        assert status_from_kite("OPEN") is OrderStatus.NEW
        assert status_from_kite("REJECTED") is OrderStatus.REJECTED
        assert status_from_kite("TRIGGER PENDING") is OrderStatus.NEW
        assert status_from_kite("PUT ORDER REQ RECEIVED") is OrderStatus.PENDING_NEW

    def test_cancelled_with_a_fill_is_filled(self) -> None:
        """What executed, executed. Calling it cancelled loses a real position."""
        assert status_from_kite("CANCELLED", filled_quantity=75) is OrderStatus.FILLED
        assert status_from_kite("CANCELLED", filled_quantity=0) is OrderStatus.CANCELLED

    def test_a_status_nobody_mapped_is_unknown_not_passed_through(self) -> None:
        """A status Kite has only just introduced must not look understood."""
        assert status_from_kite("SOME NEW STATE") is OrderStatus.UNKNOWN

    def test_a_silent_broker_is_not_a_status(self) -> None:
        """No news. The caller keeps the state it already had."""
        assert status_from_kite(None) is None
        assert status_from_kite("") is None
        assert status_from_kite("   ") is None

    def test_casing_and_padding_do_not_matter(self) -> None:
        assert status_from_kite(" complete ") is OrderStatus.FILLED


class TestPositionsAndFunds:
    async def test_the_net_book_is_read_not_the_day_book(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        """A carry-forward position is absent from the day book entirely."""
        kite.answer(
            {
                "status": "success",
                "data": {
                    "day": [],
                    "net": [
                        {
                            "tradingsymbol": nifty_call.trading_symbol,
                            "exchange": "NFO",
                            "product": "NRML",
                            "quantity": -75,
                            "average_price": 121.5,
                        }
                    ],
                },
            }
        )
        (position,) = await broker.fetch_positions()
        assert position.instrument == nifty_call.id
        assert position.quantity == -75
        assert position.average_price == rupees("121.5")

    async def test_a_position_price_is_exact(
        self, broker: ZerodhaBroker, kite: FakeKite, nifty_call: Instrument
    ) -> None:
        kite.answer(
            {
                "status": "success",
                "data": {
                    "net": [
                        {
                            "tradingsymbol": nifty_call.trading_symbol,
                            "exchange": "NFO",
                            "product": "NRML",
                            "quantity": 75,
                            "average_price": 120.55,
                        }
                    ]
                },
            }
        )
        (position,) = await broker.fetch_positions()
        assert position.average_price.amount == Money.of("120.55", Currency.INR).amount

    async def test_funds_come_back_as_money(self, broker: ZerodhaBroker, kite: FakeKite) -> None:
        kite.answer(
            {
                "status": "success",
                "data": {
                    "equity": {
                        "net": 250000,
                        "available": {"live_balance": 180000},
                        "utilised": {"debits": 70000},
                    }
                },
            }
        )
        funds = await broker.fetch_funds()
        assert funds.available == rupees("180000")
        assert funds.used == rupees("70000")
        assert funds.total == rupees("250000")


class TestModifyAndCancel:
    async def test_a_modification_sends_only_what_changed(
        self, broker: ZerodhaBroker, kite: FakeKite
    ) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.modify(BrokerOrderId("1"), OrderChanges(price=rupees("119")))
        form = kite.form()
        assert form == {"price": "119"}

    async def test_a_modification_that_changes_nothing_is_refused(
        self, broker: ZerodhaBroker
    ) -> None:
        with pytest.raises(OrderRejectedError, match="changes nothing"):
            await broker.modify(BrokerOrderId("1"), OrderChanges())

    async def test_cancelling_names_the_order(self, broker: ZerodhaBroker, kite: FakeKite) -> None:
        kite.answer({"status": "success", "data": {"order_id": "1"}})
        await broker.cancel(BrokerOrderId("260831000001"))
        assert kite.last.method == "DELETE"
        assert str(kite.last.url).endswith("/orders/regular/260831000001")
