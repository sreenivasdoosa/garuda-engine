"""The trade report and the daily P&L, from the trades themselves.

Both are read off :class:`Trade`: the report is one row per trade, the
daily P&L is those rows summed by the day each trade **ended**, which is
the owner's rule for positional trades too -- a carry-forward position
books its whole P&L on the day it exits, and is marked on no day before
that. Nothing here reads a table; the API and the day's report task hand
in the trades and take the rows.

Charges are not computed yet (the charges phase), so every charge is
``None`` rather than a zero that would read as a fact, and net equals
gross until then. Money stays :class:`Money`; the wire turns it into text.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, tzinfo
from decimal import Decimal

from garuda.domain.money import Currency, Money
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeState


@dataclass(frozen=True, slots=True)
class TradeRow:
    """One trade as the report shows it."""

    trade_id: str
    trading_client_id: str
    strategy: str
    instrument_id: str
    product: str
    direction: str
    is_paper: bool
    state: str
    quantity: int
    filled_quantity: int
    entry: Money | None
    exit: Money | None
    started_at: datetime | None
    ended_at: datetime | None
    exit_reason: str | None
    failure_reason: str | None
    #: The day the trade counts on: when it ended, on the venue's clock.
    trading_day: date | None
    gross_pnl: Money | None
    group: str
    tranche: int


@dataclass(frozen=True, slots=True)
class Totals:
    trades: int = 0
    closed: int = 0
    wins: int = 0
    losses: int = 0
    flat: int = 0
    gross_pnl: Money | None = None
    best: Money | None = None
    worst: Money | None = None

    @property
    def win_rate(self) -> Decimal | None:
        decided = self.wins + self.losses
        if decided == 0:
            return None
        return (Decimal(self.wins) / Decimal(decided) * 100).quantize(Decimal("0.01"))


@dataclass(frozen=True, slots=True)
class DailyRow:
    """One day's P&L, for whatever was selected -- or one strategy of it."""

    trading_day: date
    trading_client_id: str | None
    strategy: str | None
    product: str | None
    is_paper: bool
    trades: int
    wins: int
    losses: int
    gross_pnl: Money
    #: Not computed until the charges phase. None, never zero.
    charges: Money | None = None

    @property
    def net_pnl(self) -> Money:
        return self.gross_pnl if self.charges is None else self.gross_pnl - self.charges


@dataclass
class _Sum:
    trades: int = 0
    wins: int = 0
    losses: int = 0
    gross: Decimal = Decimal(0)
    currency: Currency = Currency.INR
    rows: list[TradeRow] = field(default_factory=list)


def trading_day_of(trade: Trade, zone: tzinfo) -> date | None:
    """The day a trade counts on: the day it ended, on the venue's clock."""
    moment = trade.ended_at if trade.ended_at is not None else trade.started_at
    return None if moment is None else moment.astimezone(zone).date()


def trade_row(trade: Trade, zone: tzinfo) -> TradeRow:
    return TradeRow(
        trade_id=trade.id.value,
        trading_client_id=trade.trading_client.value,
        strategy=trade.strategy,
        instrument_id=trade.instrument.value,
        product=trade.product.value,
        direction=trade.direction.value,
        is_paper=trade.is_paper,
        state=trade.state.value,
        quantity=trade.quantity,
        filled_quantity=trade.filled_quantity,
        entry=trade.entry,
        exit=trade.exit,
        started_at=trade.started_at,
        ended_at=trade.ended_at,
        exit_reason=trade.exit_reason.value if trade.exit_reason else None,
        failure_reason=trade.failure_reason,
        trading_day=trading_day_of(trade, zone),
        gross_pnl=trade.realised_pnl if trade.state is TradeState.COMPLETED else None,
        group=trade.group,
        tranche=trade.tranche,
    )


def totals_of(rows: Iterable[TradeRow], currency: Currency = Currency.INR) -> Totals:
    """What the rows add up to. A trade without a P&L counts, but adds nothing."""
    trades = closed = wins = losses = flat = 0
    gross: Money | None = None
    best: Money | None = None
    worst: Money | None = None
    for row in rows:
        trades += 1
        if row.gross_pnl is None:
            continue
        closed += 1
        gross = row.gross_pnl if gross is None else gross + row.gross_pnl
        if row.gross_pnl.amount > 0:
            wins += 1
        elif row.gross_pnl.amount < 0:
            losses += 1
        else:
            flat += 1
        if best is None or row.gross_pnl.amount > best.amount:
            best = row.gross_pnl
        if worst is None or row.gross_pnl.amount < worst.amount:
            worst = row.gross_pnl
    if gross is None and closed == 0 and trades:
        gross = Money(Decimal(0), currency)
    return Totals(
        trades=trades,
        closed=closed,
        wins=wins,
        losses=losses,
        flat=flat,
        gross_pnl=gross,
        best=best,
        worst=worst,
    )


def daily_rows(
    rows: Iterable[TradeRow],
    *,
    by_strategy: bool = False,
    by_account: bool = False,
    by_product: bool = False,
    currency: Currency = Currency.INR,
) -> Sequence[DailyRow]:
    """Closed trades summed by the day they ended, newest first.

    The reference's rule: the filters have already been applied to the
    rows, so a day's row means "this day, for whatever was selected". The
    grouping only splits a day further -- by strategy for the owner's
    strategy-wise view, by account or product where asked -- and never
    changes what the day covers.
    """
    sums: dict[tuple[date, str | None, str | None, str | None, bool], _Sum] = defaultdict(_Sum)
    for row in rows:
        if row.gross_pnl is None or row.trading_day is None:
            continue
        key = (
            row.trading_day,
            row.trading_client_id if by_account else None,
            row.strategy if by_strategy else None,
            row.product if by_product else None,
            row.is_paper,
        )
        bucket = sums[key]
        bucket.trades += 1
        bucket.gross += row.gross_pnl.amount
        bucket.currency = row.gross_pnl.currency
        if row.gross_pnl.amount > 0:
            bucket.wins += 1
        elif row.gross_pnl.amount < 0:
            bucket.losses += 1
    out = [
        DailyRow(
            trading_day=day,
            trading_client_id=account,
            strategy=strategy,
            product=product,
            is_paper=paper,
            trades=total.trades,
            wins=total.wins,
            losses=total.losses,
            gross_pnl=Money(total.gross, total.currency if total.trades else currency),
        )
        for (day, account, strategy, product, paper), total in sums.items()
    ]
    return sorted(
        out,
        key=lambda r: (r.trading_day, r.trading_client_id or "", r.strategy or "", r.product or ""),
        reverse=True,
    )
