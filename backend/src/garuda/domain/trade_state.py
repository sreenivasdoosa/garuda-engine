"""What state a trade is in, and why it left.

Two vocabularies that the whole of trade management is written in.

``TradeState`` is four values, not two booleans. The reference engine encoded
this as ``isActive`` plus ``isCancelled`` and had to keep a comment explaining
that ``isActive`` covered both "placed, nothing filled" and "filled, position
live" -- which are entirely different situations. One says an order is sitting
at the exchange, the other says money is at risk.

``TradeExitReason`` is long because it is what an operator reads on a closed
trade. "It exited" is not an answer; whether it hit its own stop, the group's
stop, followed its hedge out, expired worthless, or gave up after the maximum
square-off attempts are five different things to do next.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Final


class TradeState(StrEnum):
    """Where a trade is in its life."""

    #: The entry order is placed and not one quantity has filled. Nothing is
    #: at risk yet; cancelling costs nothing.
    OPEN = "OPEN"
    #: The entry filled and the position is live. This is the state in which
    #: money moves.
    ACTIVE = "ACTIVE"
    #: Exited or squared off. The reason says which.
    COMPLETED = "COMPLETED"
    #: Never became a position: rejected, unfilled, expired or cancelled.
    CANCELLED = "CANCELLED"

    @property
    def is_terminal(self) -> bool:
        return self in (TradeState.COMPLETED, TradeState.CANCELLED)

    @property
    def is_live(self) -> bool:
        """Placed and not finished -- the broader sense of "in flight"."""
        return self in (TradeState.OPEN, TradeState.ACTIVE)


#: What may follow what. A trade that never filled cannot complete, and a
#: terminal trade goes nowhere: a later frame claiming otherwise was overtaken
#: in flight, which is the same rule the order book holds to.
TRADE_TRANSITIONS: Final[dict[TradeState, frozenset[TradeState]]] = {
    TradeState.OPEN: frozenset({TradeState.ACTIVE, TradeState.CANCELLED}),
    # ACTIVE cannot become CANCELLED: something filled, so there is a position,
    # and a position is closed rather than cancelled. Recording it as cancelled
    # loses a real execution from the day's P&L.
    TradeState.ACTIVE: frozenset({TradeState.COMPLETED}),
    TradeState.COMPLETED: frozenset(),
    TradeState.CANCELLED: frozenset(),
}


class TradeExitReason(StrEnum):
    """Why a trade ended. Ported whole; each is a different thing to do next."""

    # -- the trade's own levels -------------------------------------------
    STOP_LOSS = "SL"
    TRAILING_STOP_LOSS = "TRAIL SL"
    TARGET = "TARGET"
    TRAIL_DYNAMIC = "TRAIL DYNAMIC"
    REACHED_TARGET = "REACHED TARGET"

    # -- levels belonging to something larger ------------------------------
    PORTFOLIO_STOP_LOSS = "PORTFOLIO SL"
    PORTFOLIO_TARGET = "PORTFOLIO TARGET"
    GROUP_STOP_LOSS = "GROUP SL HIT"
    GROUP_TARGET = "GROUP TARGET HIT"
    GROUP_EXIT = "GROUP EXIT"
    GROUP_ROLLBACK = "GROUP ROLLBACK"

    # -- time and the calendar ---------------------------------------------
    SQUARE_OFF = "SQUARE OFF"
    TIME_BASED_EXIT = "TIME BASED EXIT"
    MAX_HOLDING = "MAX HOLDING"
    EXIT_SIGNAL = "EXIT SIGNAL"
    SIGNAL_FLIP = "SIGNAL FLIP"

    # -- the operator -------------------------------------------------------
    MANUAL_EXIT = "MANUAL EXIT"
    MANUAL_SQUARE_OFF = "MANUAL SQUAREOFF"
    SET_TO_COMPLETED = "SET TO COMPLETED"
    SET_TO_CANCELLED = "SET TO CANCELLED"

    # -- the system decided --------------------------------------------------
    SET_TO_COMPLETED_BY_SYSTEM = "SET TO COMPLETED BY SYSTEM"
    SET_TO_CANCELLED_BY_SYSTEM = "SET TO CANCELLED BY SYSTEM"
    SYSTEM_SHUTDOWN = "SYSTEM SHUTDOWN"
    DAILY_LOSS_BREACH = "DAILY LOSS BREACH"

    # -- something went wrong ------------------------------------------------
    ENTRY_FAILED = "ENTRY FAILED"
    EXIT_FAILED = "EXIT FAILED"
    NO_POSITION_FOUND = "NO POS FOUND"
    #: The protective order vanished at the broker without the engine
    #: cancelling it. The position is unprotected, so it is closed.
    STOP_LOSS_CANCELLED_OUTSIDE = "SL CANCELLED"
    TARGET_CANCELLED_OUTSIDE = "TARGET CANCELLED"
    STOP_LOSS_REJECTED = "SL REJECTED"
    #: The stop sits above the exchange's upper circuit, so it can never
    #: trigger and the position would run unprotected.
    STOP_LOSS_ABOVE_UPPER_CIRCUIT = "SL ABOVE UC"
    MAX_SQUARE_OFF_ATTEMPTS = "MAX SQUAREOFF ATTEMPTS"

    # -- option decay and expiry ---------------------------------------------
    #: A long option that has lost almost all its value. Holding costs the
    #: remainder for no upside.
    MAX_DECAY_90 = "MAX DECAY 90"
    MAX_DECAY_95 = "MAX DECAY 95"
    BELOW_ONE_RUPEE = "BELOW ONE RUPEE"

    # -- one leg leaving takes another with it -------------------------------
    #: The hedge exited first, leaving the main leg unprotected.
    HEDGE_EXIT = "HEDGE EXIT"
    #: The main leg exited, so its hedge has nothing left to protect. The
    #: common direction of the two.
    MAIN_LEG_EXIT = "MAIN LEG EXIT"
    HEDGE_REPLACE = "HEDGE REPLACE"
    HEDGE_ENTRY_FAILED = "HEDGE ENTRY FAILED"
    #: A hedge whose main leg never placed at all.
    HEDGE_ORPHANED = "HEDGE ORPHAN - MAIN NOT PLACED"
    PAIR_TRADE_ENTRY_FAILED = "PAIR TRADE ENTRY FAILED"


#: Reasons that mean the trade never became a position. Everything else ends a
#: position that existed.
CANCELLING_REASONS: Final[frozenset[TradeExitReason]] = frozenset(
    {
        TradeExitReason.ENTRY_FAILED,
        TradeExitReason.HEDGE_ENTRY_FAILED,
        TradeExitReason.PAIR_TRADE_ENTRY_FAILED,
        TradeExitReason.SET_TO_CANCELLED,
        TradeExitReason.SET_TO_CANCELLED_BY_SYSTEM,
    }
)


#: How urgently a square-off should happen, when two reasons collide. A trade
#: already queued to exit for one reason can be asked again for another; the
#: more urgent wins, so a daily-loss breach is not downgraded to a routine
#: end-of-day square-off.
_EXIT_PRIORITY: Final[dict[TradeExitReason, int]] = {
    TradeExitReason.DAILY_LOSS_BREACH: 100,
    TradeExitReason.SYSTEM_SHUTDOWN: 95,
    TradeExitReason.MANUAL_SQUARE_OFF: 90,
    TradeExitReason.MANUAL_EXIT: 90,
    TradeExitReason.PORTFOLIO_STOP_LOSS: 85,
    TradeExitReason.STOP_LOSS_CANCELLED_OUTSIDE: 80,
    TradeExitReason.STOP_LOSS_REJECTED: 80,
    TradeExitReason.STOP_LOSS_ABOVE_UPPER_CIRCUIT: 80,
    TradeExitReason.GROUP_STOP_LOSS: 75,
    TradeExitReason.STOP_LOSS: 70,
    TradeExitReason.TRAILING_STOP_LOSS: 70,
    TradeExitReason.HEDGE_EXIT: 65,
    TradeExitReason.MAIN_LEG_EXIT: 60,
    TradeExitReason.SQUARE_OFF: 50,
    TradeExitReason.TIME_BASED_EXIT: 45,
}
_DEFAULT_EXIT_PRIORITY = 40


def exit_priority(reason: TradeExitReason) -> int:
    return _EXIT_PRIORITY.get(reason, _DEFAULT_EXIT_PRIORITY)


def more_urgent(existing: TradeExitReason, incoming: TradeExitReason) -> TradeExitReason:
    """Which of two reasons a queued square-off should keep.

    Ties keep the existing one: the first reason recorded is the one that
    actually caused the exit, and rewriting it to a later synonym makes the
    trade harder to explain afterwards.
    """
    return incoming if exit_priority(incoming) > exit_priority(existing) else existing
