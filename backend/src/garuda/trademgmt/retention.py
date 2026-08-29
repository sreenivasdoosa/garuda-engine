"""What survives a restart, and what is history.

A restart reloads the account's trades and signals, and the question is which
of them still belong in the working set. Getting it wrong is not a memory
problem, it is a correctness one: a terminal trade from last week left in
memory makes today's duplicate detection reject a fresh signal for the same
symbol, and makes the tranche gate believe a slot is already taken.

The rules are the reference engine's, and each clause is there because of the
case it names.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from garuda.domain.trade import Trade
from garuda.domain.trade_signal import TradeSignal


def started_or_ended_on(trade: Trade, day: date) -> bool:
    """Whether either end of the trade falls on a given trading day."""
    for moment in (trade.started_at, trade.ended_at):
        if moment is not None and moment.date() == day:
            return True
    return False


def should_retain_trade(trade: Trade, today: date) -> bool:
    """Whether a loaded trade belongs in today's working set.

    Kept when it is still live, or when either end of it happened today.
    A trade that is terminal and whose start and end are both on an earlier day
    is pure history: the database owns it, and holding it in memory poisons
    duplicate detection and the tranche gate on a fresh day.

    The one subtlety: a trade that is *nominally* live but has filled nothing
    and started before today is not live. Its entry order rested overnight
    unfilled, and the load cancels it rather than carrying an order the venue
    has already dropped.
    """
    live = trade.is_live
    if (
        live
        and trade.filled_quantity == 0
        and trade.started_at is not None
        and trade.started_at.date() < today
    ):
        live = False
    return live or started_or_ended_on(trade, today)


def retained_signal_ids(trades: Iterable[Trade], today: date) -> frozenset[str]:
    """The signals still backing a retained trade.

    A trade's signal has to come back with it, or the trade reloads with no
    signal to consult for its levels and its group.
    """
    return frozenset(
        trade.signal_id
        for trade in trades
        if trade.signal_id is not None and should_retain_trade(trade, today)
    )


def should_retain_signal(
    signal: TradeSignal, today: date, backing_retained: frozenset[str]
) -> bool:
    """Whether a loaded signal belongs in today's working set.

    Three ways to qualify: it was generated today, it is still a live working
    order waiting for its price, or it backs a trade being retained.

    An earlier day's signal whose trade is terminal is dropped, so it cannot be
    mistaken for today's activity -- which is exactly what the tranche gate and
    duplicate detection would do with it.
    """
    generated_today = signal.generated_at.date() == today
    still_working = not signal.is_triggered and not signal.disabled
    return generated_today or still_working or signal.id in backing_retained


def retain(
    trades: Iterable[Trade], signals: Iterable[TradeSignal], today: date
) -> tuple[tuple[Trade, ...], tuple[TradeSignal, ...]]:
    """Filter a loaded set down to what today's working set should hold."""
    kept_trades = tuple(trade for trade in trades if should_retain_trade(trade, today))
    backing = retained_signal_ids(kept_trades, today)
    kept_signals = tuple(
        signal for signal in signals if should_retain_signal(signal, today, backing)
    )
    return kept_trades, kept_signals
