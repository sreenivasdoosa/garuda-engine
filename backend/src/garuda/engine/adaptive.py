"""What happens when a tranche's last trade closes, and after a stop.

Two of the reference's behaviours that start from an exit rather than a time
(`STRATEGY_ENGINE.md` §4):

* **Adaptive tranches** (`adaptive_tranches_enabled`): when every trade of a
  tranche has closed, the next tranche enters at once -- unless the exit was
  one that should stop the cascade (a square-off, a manual exit, a portfolio
  stop or target, a trade marked done by hand), `max_tranches` is reached,
  the stop time has passed, or the 0DTE stop rules say enough: no further
  tranche once `stop_after_loss_tranches` closed at a loss or
  `stop_after_profit_tranches` at a profit.
* **Re-entry after a stop** (`re_entry`): a short position stopped out at a
  loss of at least `min_reentry_loss_percentage` arms a watch to sell the
  same option again if it falls back to the original entry price, up to
  `max_reentries` times a tranche, before the cutoff.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from garuda.domain.enums import Direction
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.engine.config import ResolvedConfig

#: The reference's `TranchCompleteEvent` cascade-suppressing exit reasons.
SUPPRESSING = frozenset(
    {
        TradeExitReason.SQUARE_OFF,
        TradeExitReason.MANUAL_SQUARE_OFF,
        TradeExitReason.MANUAL_EXIT,
        TradeExitReason.PORTFOLIO_STOP_LOSS,
        TradeExitReason.PORTFOLIO_TARGET,
        TradeExitReason.SET_TO_COMPLETED,
        TradeExitReason.SET_TO_COMPLETED_BY_SYSTEM,
    }
)
#: Exits that count as a stop for re-entry.
STOPS = frozenset({TradeExitReason.STOP_LOSS, TradeExitReason.TRAILING_STOP_LOSS})
#: The reference's adaptive default when `max_tranches` is not set.
DEFAULT_MAX_TRANCHES = 5
HUNDRED = Decimal(100)


@dataclass(frozen=True, slots=True)
class TrancheResult:
    """A tranche whose trades have all closed."""

    tranche: int
    pnl: Decimal
    exit_reason: TradeExitReason | None

    @classmethod
    def of(cls, tranche: int, trades: Sequence[Trade]) -> TrancheResult | None:
        """None while any trade of the tranche is still open."""
        if not trades or any(
            trade.state not in (TradeState.COMPLETED, TradeState.CANCELLED) for trade in trades
        ):
            return None
        pnl = Decimal(0)
        for trade in trades:
            realised = trade.realised_pnl
            if realised is not None:
                pnl += realised.amount
        # The reference reads the reason off the short (main) legs.
        shorts = [t for t in trades if t.direction is Direction.SHORT and t.exit_reason]
        chosen = shorts or [t for t in trades if t.exit_reason]
        return cls(tranche, pnl, chosen[0].exit_reason if chosen else None)


@dataclass(frozen=True, slots=True)
class Cascade:
    """Whether the next tranche goes on, and why not when it does not."""

    next_tranche: int | None
    because: str


def next_after(
    result: TrancheResult,
    config: ResolvedConfig,
    *,
    losses: int,
    profits: int,
    signalled: frozenset[int],
    past_stop: bool,
) -> Cascade:
    """The reference's `shouldTriggerNextTranch` and the 0DTE stop rules.

    ``losses`` and ``profits`` count today's completed tranches including
    this one.
    """
    if result.exit_reason in SUPPRESSING:
        return Cascade(None, f"tranche {result.tranche} ended by {result.exit_reason}")
    cap = config.whole("max_tranches") or DEFAULT_MAX_TRANCHES
    following = result.tranche + 1
    if following > cap:
        return Cascade(None, f"max tranches {cap} reached")
    if past_stop:
        return Cascade(None, "past the stop time")
    stop_losses = config.whole("stop_after_loss_tranches")
    if stop_losses and losses >= stop_losses:
        return Cascade(None, f"{losses} tranche(s) closed at a loss; the limit is {stop_losses}")
    stop_profits = config.whole("stop_after_profit_tranches")
    if stop_profits and profits >= stop_profits:
        return Cascade(
            None, f"{profits} tranche(s) closed at a profit; the limit is {stop_profits}"
        )
    if following in signalled:
        return Cascade(None, f"tranche {following} already signalled")
    return Cascade(
        following, f"tranche {result.tranche} closed {result.pnl}; tranche {following} next"
    )


@dataclass(frozen=True, slots=True)
class ReEntry:
    """A stopped short to sell again at its entry price."""

    trade: Trade
    attempt: int
    trigger: Decimal


def re_entry_for(
    trade: Trade, config: ResolvedConfig, *, done: int, now: dt.datetime, cutoff: dt.datetime | None
) -> ReEntry | str:
    """Whether a closed trade earns a re-entry watch, or why not."""
    if not config.flag("re_entry"):
        return "re-entry is off"
    if trade.exit_reason not in STOPS:
        return f"exited by {trade.exit_reason}, not a stop"
    if trade.direction is not Direction.SHORT:
        return "only a short position re-enters"
    if trade.entry is None or trade.exit is None or trade.entry.amount <= 0:
        return "no entry and exit prices"
    allowed = config.whole("max_reentries") or 1
    if done >= allowed:
        return f"{done} re-entr(ies) already; the limit is {allowed}"
    loss_percent = (trade.exit.amount - trade.entry.amount) / trade.entry.amount * HUNDRED
    floor = config.number("min_reentry_loss_percentage") or Decimal(0)
    if loss_percent < floor:
        return f"loss {loss_percent:.2f}% is under {floor}%"
    if cutoff is not None and now >= cutoff:
        return "past the cutoff"
    return ReEntry(trade=trade, attempt=done + 1, trigger=trade.entry.amount)
