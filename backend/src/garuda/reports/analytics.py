"""Analytics: the trades, cut any way the operator asks, in one answer.

The reference had four pages and twenty routes -- by user, by broker, by
strategy, by capital -- each a fixed question. The owner wants one page
where any combination of inputs is the question: these accounts, those
strategies, this product, live or paper, over this range, grouped by
whatever. So this is one function over the same trade rows the reports
use: group them, measure each group, and draw the cumulative line.

Every figure is from gross P&L, since charges are not computed yet, and
every money figure stays :class:`Money` until the wire.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from garuda.domain.money import Currency, Money
from garuda.reports.trades import TradeRow


class GroupBy(StrEnum):
    DAY = "day"
    WEEK = "week"
    MONTH = "month"
    ACCOUNT = "account"
    BROKER = "broker"
    STRATEGY = "strategy"
    SYMBOL = "symbol"
    PRODUCT = "product"
    EXIT_REASON = "exit_reason"
    DIRECTION = "direction"


@dataclass(frozen=True, slots=True)
class Bucket:
    """One group's measures."""

    key: str
    trades: int
    wins: int
    losses: int
    flat: int
    gross_pnl: Money
    average_win: Money | None
    average_loss: Money | None
    best: Money | None
    worst: Money | None
    #: The largest fall from a peak of the group's own running total, in
    #: the order its trades ended. Zero when it never fell.
    max_drawdown: Money
    #: Gross wins over gross losses. None when nothing was lost.
    profit_factor: Decimal | None

    @property
    def win_rate(self) -> Decimal | None:
        decided = self.wins + self.losses
        if decided == 0:
            return None
        return (Decimal(self.wins) / Decimal(decided) * 100).quantize(Decimal("0.01"))

    @property
    def average_trade(self) -> Money | None:
        if self.trades == 0:
            return None
        return Money(
            (self.gross_pnl.amount / Decimal(self.trades)).quantize(Decimal("0.01")),
            self.gross_pnl.currency,
        )


@dataclass(frozen=True, slots=True)
class Point:
    """One day of the cumulative line."""

    trading_day: date
    day_pnl: Money
    cumulative: Money
    trades: int


@dataclass(frozen=True, slots=True)
class Analysis:
    group_by: GroupBy
    overall: Bucket
    groups: Sequence[Bucket]
    curve: Sequence[Point]


def _week_of(day: date) -> str:
    monday = day - timedelta(days=day.weekday())
    return f"{monday.isoformat()} week"


def _key_for(group_by: GroupBy, brokers: dict[str, str]) -> Callable[[TradeRow], str]:
    def key(row: TradeRow) -> str:
        if group_by is GroupBy.DAY:
            return row.trading_day.isoformat() if row.trading_day else "undated"
        if group_by is GroupBy.WEEK:
            return _week_of(row.trading_day) if row.trading_day else "undated"
        if group_by is GroupBy.MONTH:
            return row.trading_day.strftime("%Y-%m") if row.trading_day else "undated"
        if group_by is GroupBy.ACCOUNT:
            return row.trading_client_id
        if group_by is GroupBy.BROKER:
            return brokers.get(row.trading_client_id, "unknown")
        if group_by is GroupBy.STRATEGY:
            return row.strategy
        if group_by is GroupBy.SYMBOL:
            return row.instrument_id.split(":", 1)[-1]
        if group_by is GroupBy.PRODUCT:
            return row.product
        if group_by is GroupBy.EXIT_REASON:
            return row.exit_reason or "none"
        return row.direction

    return key


def _ended(row: TradeRow) -> datetime:
    return row.ended_at or row.started_at or datetime.min.replace(tzinfo=None)


def measure(key: str, rows: Sequence[TradeRow], currency: Currency) -> Bucket:
    """One group's figures, from its closed trades in the order they ended."""
    closed = sorted(
        (r for r in rows if r.gross_pnl is not None),
        key=lambda r: r.ended_at or r.started_at or datetime.max.replace(tzinfo=None),
    )
    wins = [r.gross_pnl for r in closed if r.gross_pnl is not None and r.gross_pnl.amount > 0]
    losses = [r.gross_pnl for r in closed if r.gross_pnl is not None and r.gross_pnl.amount < 0]
    flat = sum(1 for r in closed if r.gross_pnl is not None and r.gross_pnl.amount == 0)
    gross = Decimal(0)
    peak = Decimal(0)
    drawdown = Decimal(0)
    for r in closed:
        assert r.gross_pnl is not None
        gross += r.gross_pnl.amount
        peak = max(peak, gross)
        drawdown = max(drawdown, peak - gross)
    won = sum((w.amount for w in wins), Decimal(0))
    lost = sum((lo.amount for lo in losses), Decimal(0))
    amounts = [r.gross_pnl.amount for r in closed if r.gross_pnl is not None]

    def money(value: Decimal) -> Money:
        return Money(value, currency)

    return Bucket(
        key=key,
        trades=len(closed),
        wins=len(wins),
        losses=len(losses),
        flat=flat,
        gross_pnl=money(gross),
        average_win=money((won / len(wins)).quantize(Decimal("0.01"))) if wins else None,
        average_loss=money((lost / len(losses)).quantize(Decimal("0.01"))) if losses else None,
        best=money(max(amounts)) if amounts else None,
        worst=money(min(amounts)) if amounts else None,
        max_drawdown=money(drawdown),
        profit_factor=(won / -lost).quantize(Decimal("0.01")) if lost else None,
    )


def curve_of(rows: Iterable[TradeRow], currency: Currency) -> list[Point]:
    """The running total by day, in day order."""
    by_day: dict[date, list[Decimal]] = defaultdict(list)
    for r in rows:
        if r.gross_pnl is not None and r.trading_day is not None:
            by_day[r.trading_day].append(r.gross_pnl.amount)
    running = Decimal(0)
    points: list[Point] = []
    for day in sorted(by_day):
        day_total = sum(by_day[day], Decimal(0))
        running += day_total
        points.append(
            Point(
                trading_day=day,
                day_pnl=Money(day_total, currency),
                cumulative=Money(running, currency),
                trades=len(by_day[day]),
            )
        )
    return points


def analyse(
    rows: Sequence[TradeRow],
    group_by: GroupBy,
    *,
    brokers: dict[str, str] | None = None,
    currency: Currency = Currency.INR,
) -> Analysis:
    """Everything the page shows for one question, from the rows that match it.

    The groups are ordered by their key for the time groupings, so the
    table reads as a calendar, and by gross P&L otherwise, best first.
    """
    key = _key_for(group_by, brokers or {})
    grouped: dict[str, list[TradeRow]] = defaultdict(list)
    for row in rows:
        if row.gross_pnl is None:
            continue
        grouped[key(row)].append(row)
    groups = [measure(k, members, currency) for k, members in grouped.items()]
    if group_by in (GroupBy.DAY, GroupBy.WEEK, GroupBy.MONTH):
        groups.sort(key=lambda g: g.key)
    else:
        groups.sort(key=lambda g: g.gross_pnl.amount, reverse=True)
    return Analysis(
        group_by=group_by,
        overall=measure("all", rows, currency),
        groups=groups,
        curve=curve_of(rows, currency),
    )
