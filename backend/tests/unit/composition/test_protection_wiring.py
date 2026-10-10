"""Order protection, from the rows the Broker Config page edits.

What matters is what reaches the broker: a MARKET order on an unconfigured
venue leaves as a marketable LIMIT, a venue configured to allow raw market
orders leaves it alone, a zero in a row means the default, and a row written
while the engine runs is read by the next order.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.websocket import Connector
from garuda.composition.engine import build_engine
from garuda.composition.protection import (
    ProtectionBook,
    key_of,
    protected_modification,
    protected_placement,
    protection_from,
)
from garuda.composition.venues import Venues
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, OrderType, ProductType
from garuda.domain.instrument import Instrument
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.protection import DEFAULT_BUFFERS, ProtectionSegment
from garuda.ordermgmt.protection import ExchangeProtection, MarketProtection
from garuda.persistence.models import BrokerExchangeConfigRow
from garuda.protocols.broker import OrderChanges

from .conftest import APPA, NOW, account, resolver_for, session


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def row(**overrides: object) -> BrokerExchangeConfigRow:
    values: dict[str, object] = {
        "broker_name": "zerodha",
        "exchange_code": "NSE",
        "market_orders_allowed": False,
        "limit_order_buffer_equity": Decimal(0),
        "limit_order_buffer_futures": Decimal(0),
        "limit_order_buffer_options": Decimal(0),
        "sl_trigger_to_limit_gap_equity": Decimal(0),
        "sl_trigger_to_limit_gap_futures": Decimal(0),
        "sl_trigger_to_limit_gap_options": Decimal(0),
    }
    values.update(overrides)
    return BrokerExchangeConfigRow(**values)


def market_buy(instrument: Instrument) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId("gar-1"),
        trading_client=APPA,
        instrument=instrument.id,
        side=Side.BUY,
        quantity=75,
        order_type=OrderType.MARKET,
        product=ProductType.NRML,
    )


def guard(book: ProtectionBook, instrument: Instrument, last: Money | None) -> MarketProtection:
    return MarketProtection("zerodha", book.lookup, lambda _: last, lambda _: instrument)


class TestARowAsTheEngineReadsIt:
    def test_zero_means_the_segments_default(self) -> None:
        protection = protection_from(row())
        for segment in ProtectionSegment:
            assert protection.for_segment(segment) == DEFAULT_BUFFERS[segment]
        assert protection.market_orders_allowed is False

    def test_a_configured_buffer_wins_over_the_default(self) -> None:
        protection = protection_from(row(limit_order_buffer_options=Decimal("7.5")))
        options = protection.for_segment(ProtectionSegment.OPTIONS)
        assert options.limit_buffer_percent == Decimal("7.5")
        assert options.sl_gap_percent == DEFAULT_BUFFERS[ProtectionSegment.OPTIONS].sl_gap_percent

    def test_market_orders_allowed_is_carried(self) -> None:
        assert protection_from(row(market_orders_allowed=True)).market_orders_allowed is True


class TestTheBook:
    def test_lookups_do_not_care_about_case(self) -> None:
        book = ProtectionBook({key_of("zerodha", "nse"): protection_from(row())})
        assert book.lookup("ZERODHA", "Nse") is not None
        assert book.lookup("zerodha", "MCX") is None

    def test_the_stop_gap_comes_from_the_row_or_the_default(
        self, nifty_call: Instrument, reliance: Instrument
    ) -> None:
        book = ProtectionBook(
            {
                key_of("zerodha", "NSE"): protection_from(
                    row(sl_trigger_to_limit_gap_options=Decimal(9))
                )
            }
        )
        assert book.sl_gap_percent("zerodha", nifty_call) == Decimal(9)
        assert book.sl_gap_percent("zerodha", reliance) == Decimal(1), "equity left at default"
        assert book.sl_gap_percent("dhan", nifty_call) == Decimal(18), "no row: the default"

    def test_replacing_takes_the_table_whole(self) -> None:
        book = ProtectionBook({key_of("zerodha", "NSE"): protection_from(row())})
        book.replace({})
        assert book.lookup("zerodha", "NSE") is None
        assert book.version == 1


class TestWhatReachesTheBroker:
    async def test_an_unconfigured_venue_turns_a_market_order_into_a_limit(
        self, nifty_call: Instrument
    ) -> None:
        """Fail closed: no row means protect."""
        sent: list[OrderRequest] = []

        async def place(request: OrderRequest) -> BrokerOrderId:
            sent.append(request)
            return BrokerOrderId("b-1")

        placement = protected_placement(place, guard(ProtectionBook(), nifty_call, rupees("100")))
        await placement(market_buy(nifty_call))

        [request] = sent
        assert request.order_type is OrderType.LIMIT
        assert request.price == rupees("115"), "15% above the last price for an option"

    async def test_a_venue_allowing_market_orders_sends_it_as_it_is(
        self, nifty_call: Instrument
    ) -> None:
        sent: list[OrderRequest] = []

        async def place(request: OrderRequest) -> BrokerOrderId:
            sent.append(request)
            return BrokerOrderId("b-1")

        book = ProtectionBook(
            {key_of("zerodha", "NSE"): ExchangeProtection(market_orders_allowed=True)}
        )
        await protected_placement(place, guard(book, nifty_call, rupees("100")))(
            market_buy(nifty_call)
        )

        assert sent[0].order_type is OrderType.MARKET

    async def test_a_row_written_while_running_is_read_by_the_next_order(
        self, nifty_call: Instrument
    ) -> None:
        """The book is swapped, and the wrapper holds the book, not a copy."""
        sent: list[OrderRequest] = []

        async def place(request: OrderRequest) -> BrokerOrderId:
            sent.append(request)
            return BrokerOrderId("b-1")

        book = ProtectionBook()
        placement = protected_placement(place, guard(book, nifty_call, rupees("100")))
        await placement(market_buy(nifty_call))
        book.replace({key_of("zerodha", "NSE"): protection_from(row(market_orders_allowed=True))})
        await placement(market_buy(nifty_call))

        assert [r.order_type for r in sent] == [OrderType.LIMIT, OrderType.MARKET]

    async def test_a_moved_stop_is_kept_inside_the_band(self, reliance: Instrument) -> None:
        sent: list[OrderChanges] = []

        async def modify(order_id: BrokerOrderId, changes: OrderChanges) -> None:
            sent.append(changes)

        modification = protected_modification(
            modify, guard(ProtectionBook(), reliance, rupees("2500")), lambda _: reliance
        )
        await modification(
            BrokerOrderId("b-1"),
            OrderChanges(price=rupees("2400"), trigger_price=rupees("2500")),
        )

        assert sent[0].price == rupees("2475")
        assert sent[0].trigger_price == rupees("2500")

    async def test_a_modify_on_an_order_the_book_does_not_know_goes_out_untouched(
        self, reliance: Instrument
    ) -> None:
        sent: list[OrderChanges] = []

        async def modify(order_id: BrokerOrderId, changes: OrderChanges) -> None:
            sent.append(changes)

        modification = protected_modification(
            modify, guard(ProtectionBook(), reliance, rupees("2500")), lambda _: None
        )
        changes = OrderChanges(price=rupees("2400"), trigger_price=rupees("2500"))
        await modification(BrokerOrderId("b-1"), changes)
        assert sent[0] is changes


class TestTheEngineHoldsTheBook:
    def test_the_book_handed_in_is_the_one_every_account_reads(
        self,
        sessions: async_sessionmaker[AsyncSession],
        venues: Venues,
        clock: ReplayClock,
        connector: Connector,
    ) -> None:
        book = ProtectionBook()
        engine = build_engine(
            sessions=sessions,
            resolver=resolver_for([account(APPA, "AB1234")], {APPA: session("AB1234")}),
            venues=venues,
            clock=clock,
            now=NOW,
            connector=connector,
            protection=book,
        )
        assert engine.parts.protection is book
        assert APPA in engine.parts.clients

    def test_without_rows_an_engine_still_protects(
        self,
        sessions: async_sessionmaker[AsyncSession],
        venues: Venues,
        clock: ReplayClock,
        connector: Connector,
    ) -> None:
        engine = build_engine(
            sessions=sessions,
            resolver=resolver_for([account(APPA, "AB1234")], {APPA: session("AB1234")}),
            venues=venues,
            clock=clock,
            now=NOW,
            connector=connector,
        )
        assert engine.parts.protection.lookup("zerodha", "NSE") is None
