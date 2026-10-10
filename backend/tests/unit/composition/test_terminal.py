"""What the Terminal shows, from the engine's own book.

Behavioural: trades go into an account's book, ticks into the hub, and the
claims are about the rows that come out -- counts, money, and what an
operator's square-off sets in motion. Every figure is stated, not recomputed
from the expressions the view uses.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from garuda.composition.engine import Engine
from garuda.composition.terminal import (
    AccountNotTradingError,
    TerminalView,
    UnknownAccountError,
)
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, ProductType
from garuda.domain.enums import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.feed import TicksReceived

from .conftest import AMMA, APPA, NOW, EngineBuilder, account, session

CALL = InstrumentId("NSE:NIFTY26AUG25000CE")
PUT = InstrumentId("NSE:NIFTY26AUG25000PE")
AT = datetime(2026, 8, 31, 4, 0, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def trade(
    trade_id: str,
    instrument: InstrumentId = CALL,
    *,
    direction: Direction = Direction.LONG,
    product: ProductType = ProductType.NRML,
    quantity: int = 75,
    is_paper: bool = False,
    strategy: str = "straddle",
) -> Trade:
    return Trade(
        id=TradeId(trade_id),
        trading_client=APPA,
        instrument=instrument,
        strategy=strategy,
        direction=direction,
        product=product,
        quantity=quantity,
        is_paper=is_paper,
    )


def filled(a_trade: Trade, price: str) -> Trade:
    return a_trade.with_entry_fill(a_trade.quantity, rupees(price), AT)


def closed(a_trade: Trade, entry: str, exit_price: str) -> Trade:
    return filled(a_trade, entry).closed(rupees(exit_price), TradeExitReason.TARGET, AT)


async def ticked(engine: Engine, instrument: InstrumentId, price: str) -> None:
    """A tick, subscribed, staged and dispatched, as the feed would deliver it."""
    hub = engine.parts.hub
    await hub.subscribe([instrument])
    await hub.consume([TicksReceived((Tick(instrument, rupees(price), AT),))])
    await hub.dispatch_once()


@pytest.fixture
def engine(build_with: EngineBuilder) -> Engine:
    return build_with(
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234")},
    )


@pytest.fixture
def view(engine: Engine) -> TerminalView:
    return TerminalView(engine, ReplayClock(NOW))


class TestTheSummaries:
    def test_every_account_appears_trading_or_not(self, view: TerminalView) -> None:
        rows = {row.trading_client_id: row for row in view.summaries()}
        assert rows[APPA].is_trading is True
        assert rows[AMMA].is_trading is False
        assert "no broker session" in (rows[AMMA].unavailable_because or "")

    def test_rows_are_in_display_order(self, view: TerminalView) -> None:
        assert [row.display_name for row in view.summaries()] == ["Amma", "Appa"]

    async def test_counts_and_money_come_from_the_book(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-active"), "100"))
        book.add_trade(closed(trade("t-done", PUT), "50", "40"))
        book.add_trade(trade("t-open"))
        book.add_trade(trade("t-gone").cancelled(TradeExitReason.SET_TO_CANCELLED, AT))
        await ticked(engine, CALL, "110")

        row = view.summary(APPA)

        assert (row.counts.open, row.counts.active, row.counts.completed) == (1, 1, 1)
        assert row.counts.cancelled == 1
        assert row.pnl.realised == rupees("-750"), "(40 - 50) * 75"
        assert row.pnl.unrealised == rupees("750"), "(110 - 100) * 75"
        assert row.pnl.total == rupees("0")
        assert row.pnl.unpriced == 0
        assert row.positions == 1

    async def test_an_active_position_with_no_tick_is_unpriced_not_zero(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-active"), "100"))

        row = view.summary(APPA)

        assert row.pnl.unrealised == rupees("0")
        assert row.pnl.unpriced == 1, "the total is not the whole story, and says so"

    async def test_paper_trades_are_counted_apart(self, engine: Engine, view: TerminalView) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-live"), "100"))
        book.add_trade(filled(trade("t-paper", PUT, is_paper=True), "100"))
        await ticked(engine, CALL, "110")
        await ticked(engine, PUT, "90")

        row = view.summary(APPA)

        assert row.counts.active == 1
        assert row.paper_counts.active == 1
        assert row.pnl.unrealised == rupees("750")
        assert row.paper_pnl.unrealised == rupees("-750")

    def test_a_short_position_gains_when_the_price_falls(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(closed(trade("t-short", direction=Direction.SHORT), "100", "80"))
        assert view.summary(APPA).pnl.realised == rupees("1500")


class TestPositions:
    async def test_a_round_trip_shows_flat_with_its_result(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(closed(trade("t-1"), "100", "120"))
        await ticked(engine, CALL, "125")

        [row] = view.positions(APPA)

        assert row.net_quantity == 0
        assert (row.buy_quantity, row.sell_quantity) == (75, 75)
        assert row.buy_average == rupees("100")
        assert row.sell_average == rupees("120")
        assert row.realised == rupees("1500")
        assert row.unrealised == rupees("0")
        assert row.last_price == rupees("125")

    async def test_two_trades_on_one_instrument_are_one_row(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-1"), "100"))
        book.add_trade(filled(trade("t-2"), "110"))
        await ticked(engine, CALL, "120")

        [row] = view.positions(APPA)

        assert row.net_quantity == 150
        assert row.buy_average == rupees("105")
        assert row.unrealised == rupees("2250"), "20 * 75 + 10 * 75"
        assert set(row.trade_ids) == {"t-1", "t-2"}

    def test_an_unfilled_trade_is_not_a_position(self, engine: Engine, view: TerminalView) -> None:
        engine.parts.clients[APPA].book.add_trade(trade("t-open"))
        assert view.positions(APPA) == []


class TestTheTradeLists:
    def test_trades_are_grouped_by_what_they_are(self, engine: Engine, view: TerminalView) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(trade("t-open"))
        book.add_trade(filled(trade("t-active", PUT), "50"))
        book.add_trade(closed(trade("t-done", PUT), "50", "60"))

        groups = view.trades(APPA)

        assert [t.id.value for t in groups.open] == ["t-open"]
        assert [t.id.value for t in groups.active] == ["t-active"]
        assert [t.id.value for t in groups.completed] == ["t-done"]
        assert groups.cancelled == []
        assert groups.failed == []


class TestRefusals:
    def test_an_unknown_account_is_refused_by_name(self, view: TerminalView) -> None:
        from garuda.domain.client import TradingClientId

        with pytest.raises(UnknownAccountError, match="nobody"):
            view.trades(TradingClientId("nobody"))

    def test_an_account_not_trading_is_refused_with_the_reason(self, view: TerminalView) -> None:
        with pytest.raises(AccountNotTradingError, match="no broker session"):
            view.positions(AMMA)
        summary = view.summary(AMMA)
        assert summary.is_trading is False


class TestSquaringOff:
    async def test_every_live_trade_is_asked_to_exit(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-1"), "100"))
        book.add_trade(filled(trade("t-2", PUT, product=ProductType.MIS), "50"))
        book.add_trade(closed(trade("t-done", PUT), "50", "60"))

        report = await view.square_off(APPA)

        assert set(report.requested) == {"t-1", "t-2"}
        assert report.skipped == {}

    async def test_intraday_scopes_to_mis(self, engine: Engine, view: TerminalView) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-nrml"), "100"))
        book.add_trade(filled(trade("t-mis", PUT, product=ProductType.MIS), "50"))

        assert (await view.square_off(APPA, product="INTRADAY")).requested == ("t-mis",)
        assert (await view.square_off(APPA, product="POSITIONAL")).requested == ("t-nrml",)

    async def test_a_strategy_can_be_squared_off_alone(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-a", strategy="a"), "100"))
        book.add_trade(filled(trade("t-b", PUT, strategy="b"), "50"))

        report = await view.square_off(APPA, strategies=["b"])

        assert report.requested == ("t-b",)

    async def test_one_trade_by_id(self, engine: Engine, view: TerminalView) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(filled(trade("t-1"), "100"))
        book.add_trade(filled(trade("t-2", PUT), "50"))

        report = await view.square_off(APPA, trade_id="t-2")

        assert report.requested == ("t-2",)

    async def test_a_finished_or_unknown_trade_is_reported_not_requested(
        self, engine: Engine, view: TerminalView
    ) -> None:
        book = engine.parts.clients[APPA].book
        book.add_trade(closed(trade("t-done"), "100", "110"))

        finished = await view.square_off(APPA, trade_id="t-done")
        assert finished.requested == ()
        assert "finished" in finished.skipped["t-done"]

        unknown = await view.square_off(APPA, trade_id="t-nope")
        assert "no such trade" in unknown.skipped["t-nope"]

    async def test_a_bad_scope_is_refused_by_name(self, engine: Engine, view: TerminalView) -> None:
        engine.parts.clients[APPA].book.add_trade(filled(trade("t-1"), "100"))
        with pytest.raises(ValueError, match="OVERNIGHT"):
            await view.square_off(APPA, product="OVERNIGHT")

    async def test_the_request_is_queued_on_the_accounts_square_off_service(
        self, engine: Engine, view: TerminalView
    ) -> None:
        """The same service the day model uses at the close."""
        client = engine.parts.clients[APPA]
        client.book.add_trade(filled(trade("t-1"), "100"))

        await view.square_off(APPA)

        assert [r.trade_id for r in client.square_off.pending] == [TradeId("t-1")]
