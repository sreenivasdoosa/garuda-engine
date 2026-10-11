"""Analytics: the trades cut any way, measured.

Behavioural: a handful of closed trades go in with a grouping, and the
claims are about the groups, their figures and the running line.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain import Currency, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction
from garuda.domain.instrument import InstrumentId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason
from garuda.reports.analytics import GroupBy, analyse
from garuda.reports.trades import TradeRow, trade_row

IST = ZoneInfo("Asia/Kolkata")
APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")
MONDAY = datetime(2026, 10, 12, 4, 30, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def closed(
    trade_id: str,
    entry: str,
    exit_price: str,
    *,
    client: TradingClientId = APPA,
    strategy: str = "straddle",
    at: datetime = MONDAY,
    reason: TradeExitReason = TradeExitReason.TARGET,
) -> TradeRow:
    trade = Trade(
        id=TradeId(trade_id),
        trading_client=client,
        instrument=InstrumentId("NSE:NIFTY26OCT25000CE"),
        strategy=strategy,
        direction=Direction.SHORT,
        product=ProductType.MIS,
        quantity=75,
    )
    done = trade.with_entry_fill(75, rupees(entry), at).closed(rupees(exit_price), reason, at)
    return trade_row(done, IST)


def rows() -> list[TradeRow]:
    day = timedelta(days=1)
    return [
        closed("1", "120", "100"),  # +1500 Monday
        closed("2", "100", "110", strategy="strangle", reason=TradeExitReason.STOP_LOSS),  # -750
        closed("3", "120", "110", client=AMMA, at=MONDAY + day),  # +750 Tuesday
        closed("4", "100", "140", at=MONDAY + 2 * day, reason=TradeExitReason.STOP_LOSS),  # -3000
        closed("5", "120", "100", at=MONDAY + 3 * day),  # +1500 Thursday
    ]


class TestTheWhole:
    def test_the_overall_figures(self) -> None:
        analysis = analyse(rows(), GroupBy.DAY)
        whole = analysis.overall
        assert whole.trades == 5
        assert (whole.wins, whole.losses) == (3, 2)
        assert whole.gross_pnl == rupees("0")
        assert whole.win_rate == Decimal("60.00")
        assert whole.average_win == rupees("1250.00")
        assert whole.average_loss == rupees("-1875.00")
        assert whole.best == rupees("1500")
        assert whole.worst == rupees("-3000")
        assert whole.profit_factor == Decimal("1.00")
        assert whole.max_drawdown == rupees("3000"), "from the 1500 peak down to -1500"

    def test_the_running_line_by_day(self) -> None:
        curve = analyse(rows(), GroupBy.DAY).curve
        assert [(p.trading_day.day, str(p.cumulative.amount)) for p in curve] == [
            (12, "750"),
            (13, "1500"),
            (14, "-1500"),
            (15, "0"),
        ]
        assert curve[0].trades == 2


class TestTheGroups:
    def test_by_strategy_best_first(self) -> None:
        groups = analyse(rows(), GroupBy.STRATEGY).groups
        assert [(g.key, str(g.gross_pnl.amount)) for g in groups] == [
            ("straddle", "750"),
            ("strangle", "-750"),
        ]
        straddle = groups[0]
        assert straddle.trades == 4
        assert straddle.max_drawdown == rupees("3000")

    def test_by_account_and_by_broker(self) -> None:
        by_account = analyse(rows(), GroupBy.ACCOUNT).groups
        assert {g.key: g.trades for g in by_account} == {"appa": 4, "amma": 1}
        by_broker = analyse(
            rows(), GroupBy.BROKER, brokers={"appa": "zerodha", "amma": "dhan"}
        ).groups
        assert {g.key: str(g.gross_pnl.amount) for g in by_broker} == {
            "zerodha": "-750",
            "dhan": "750",
        }

    def test_by_time_reads_as_a_calendar(self) -> None:
        by_day = analyse(rows(), GroupBy.DAY).groups
        assert [g.key for g in by_day] == ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"]
        by_week = analyse(rows(), GroupBy.WEEK).groups
        assert [g.key for g in by_week] == ["2026-10-12 week"]
        by_month = analyse(rows(), GroupBy.MONTH).groups
        assert [g.key for g in by_month] == ["2026-10"]

    def test_by_exit_reason(self) -> None:
        groups = analyse(rows(), GroupBy.EXIT_REASON).groups
        assert {g.key: g.trades for g in groups} == {"TARGET": 3, "SL": 2}

    def test_nothing_closed_is_an_empty_answer(self) -> None:
        analysis = analyse([], GroupBy.STRATEGY)
        assert analysis.groups == []
        assert analysis.curve == []
        assert analysis.overall.trades == 0
        assert analysis.overall.win_rate is None
