"""The trade report and the daily P&L, from the trades themselves.

Behavioural: trades in known states go in, and the claims are about the
rows and sums that come out -- which day a trade counts on, what a
cancelled trade adds, and how the strategy-wise view splits a day.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain import Currency, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason
from garuda.reports.trades import TradeRow, daily_rows, totals_of, trade_row, trading_day_of

IST = ZoneInfo("Asia/Kolkata")
APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")
CALL = InstrumentId("NSE:NIFTY26OCT25000CE")
#: 10:00 IST on Monday the 12th.
MONDAY = datetime(2026, 10, 12, 4, 30, tzinfo=UTC)
#: 20:00 UTC on Monday is 01:30 IST on Tuesday: the venue's day has moved on.
LATE_MONDAY_UTC = datetime(2026, 10, 12, 20, 0, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_trade(
    trade_id: str,
    *,
    client: TradingClientId = APPA,
    strategy: str = "straddle",
    product: ProductType = ProductType.MIS,
    is_paper: bool = False,
    direction: Direction = Direction.SHORT,
) -> Trade:
    return Trade(
        id=TradeId(trade_id),
        trading_client=client,
        instrument=CALL,
        strategy=strategy,
        direction=direction,
        product=product,
        quantity=75,
        is_paper=is_paper,
    )


def closed(trade: Trade, entry: str, exit_price: str, *, at: datetime = MONDAY) -> Trade:
    return trade.with_entry_fill(trade.quantity, rupees(entry), at).closed(
        rupees(exit_price), TradeExitReason.TARGET, at
    )


class TestATradeRow:
    def test_a_closed_short_books_its_gain_on_the_day_it_ended(self) -> None:
        row = trade_row(closed(a_trade("t-1"), "120", "100"), IST)
        assert row.gross_pnl == rupees("1500"), "75 units, 20 points, short"
        assert row.trading_day == date(2026, 10, 12)
        assert row.exit_reason == "TARGET"
        assert row.state == "COMPLETED"

    def test_the_day_is_the_venues_not_utcs(self) -> None:
        row = trade_row(closed(a_trade("t-1"), "120", "100", at=LATE_MONDAY_UTC), IST)
        assert row.trading_day == date(2026, 10, 13)
        assert trading_day_of(a_trade("t-2"), IST) is None, "never started: no day yet"

    def test_an_open_trade_has_no_pnl_in_the_report(self) -> None:
        row = trade_row(a_trade("t-1").with_entry_fill(75, rupees("120"), MONDAY), IST)
        assert row.gross_pnl is None
        assert row.entry == rupees("120")
        assert row.exit is None


class TestTheTotals:
    def test_wins_losses_and_the_sum(self) -> None:
        rows = [
            trade_row(closed(a_trade("w"), "120", "100"), IST),
            trade_row(closed(a_trade("l"), "100", "130"), IST),
            trade_row(closed(a_trade("f"), "100", "100"), IST),
            trade_row(a_trade("open").with_entry_fill(75, rupees("1"), MONDAY), IST),
        ]
        totals = totals_of(rows)
        assert totals.trades == 4
        assert totals.closed == 3
        assert (totals.wins, totals.losses, totals.flat) == (1, 1, 1)
        assert totals.gross_pnl == rupees("-750")
        assert totals.best == rupees("1500")
        assert totals.worst == rupees("-2250")
        assert totals.win_rate == Decimal("50.00"), "a flat trade decides nothing"

    def test_nothing_closed_sums_to_nothing(self) -> None:
        totals = totals_of([trade_row(a_trade("open"), IST)])
        assert totals.closed == 0
        assert totals.win_rate is None
        assert totals.gross_pnl == rupees("0")


class TestTheDay:
    def rows(self) -> list[TradeRow]:
        return [
            trade_row(closed(a_trade("a1", strategy="straddle"), "120", "100"), IST),
            trade_row(closed(a_trade("a2", strategy="strangle"), "100", "110"), IST),
            trade_row(closed(a_trade("a3", client=AMMA, strategy="straddle"), "120", "110"), IST),
            trade_row(
                closed(a_trade("b1", strategy="straddle"), "120", "100", at=LATE_MONDAY_UTC),
                IST,
            ),
            trade_row(closed(a_trade("p1", is_paper=True), "120", "100"), IST),
            trade_row(a_trade("open").with_entry_fill(75, rupees("1"), MONDAY), IST),
        ]

    def test_a_day_pools_everything_selected_apart_from_paper(self) -> None:
        days = daily_rows(self.rows())
        by_key = {(d.trading_day.isoformat(), d.is_paper): d for d in days}
        monday = by_key[("2026-10-12", False)]
        assert monday.trades == 3
        assert monday.gross_pnl == rupees("1500")  # 1500 - 750 + 750
        assert (monday.wins, monday.losses) == (2, 1)
        assert monday.strategy is None
        assert by_key[("2026-10-12", True)].gross_pnl == rupees("1500")
        assert by_key[("2026-10-13", False)].trades == 1
        assert days[0].trading_day.isoformat() == "2026-10-13", "newest first"

    def test_the_strategy_wise_view_splits_a_day_and_nothing_else(self) -> None:
        days = daily_rows(self.rows(), by_strategy=True)
        monday = [d for d in days if d.trading_day.isoformat() == "2026-10-12" and not d.is_paper]
        assert {d.strategy: str(d.gross_pnl.amount) for d in monday} == {
            "straddle": "2250",
            "strangle": "-750",
        }
        assert sum(d.trades for d in monday) == 3, "the same trades, split"

    def test_by_account_as_well(self) -> None:
        days = daily_rows(self.rows(), by_strategy=True, by_account=True)
        monday = [
            d
            for d in days
            if d.trading_day.isoformat() == "2026-10-12"
            and not d.is_paper
            and d.strategy == "straddle"
        ]
        assert {d.trading_client_id: str(d.gross_pnl.amount) for d in monday} == {
            "appa": "1500",
            "amma": "750",
        }

    def test_net_is_gross_until_charges_exist(self) -> None:
        [day] = daily_rows([trade_row(closed(a_trade("a1"), "120", "100"), IST)])
        assert day.charges is None
        assert day.net_pnl == day.gross_pnl
