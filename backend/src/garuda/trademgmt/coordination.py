"""What one leg leaving does to the legs it was entered with.

A multi-leg position is not several trades that happen to share a name. A
hedge exists to bound the loss on the leg it protects; a pair's two sides are
one view expressed twice. When one side goes, the others are no longer what
the strategy asked for, and leaving them alone is a decision -- usually the
wrong one.

Three relationships, each with its own consequence:

**A main leg exits, so its hedge follows.** The hedge was bought to cap the
main's loss. With the main gone it is a naked long option decaying to nothing,
and holding it costs the premium for no reason.

**A hedge's main never arrived, so the hedge is orphaned.** This is the
dangerous one. The engine sold nothing, so the bought protection is a position
in its own right that nobody chose. The flag saying so is written on the hedge
itself and persists, because by the time anyone looks, the failed main may be
gone -- and an orphan must still be closed after a restart.

**A pair's other side failed to enter.** One side of a two-sided view is a
directional position the strategy never asked for.

The reverse of the first -- a hedge exiting and leaving its main unprotected --
is deliberately *not* an automatic exit. The reference engine reserved a reason
for it and never wired one, and inventing the policy here would be choosing for
the operator. The main is flagged and the operator told, loudly, because the
risk on that position has changed.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.trade import Trade
from garuda.domain.trade_signal import TradeSignal
from garuda.domain.trade_state import TradeExitReason
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.legs import is_hedge

logger = logging.getLogger(__name__)

#: Asks for a position to be closed. The square-off service, in practice.
type RequestExit = Callable[[Trade, TradeExitReason], Awaitable[bool]]


class LegAction(StrEnum):
    #: Nothing to do; the group is as the strategy asked for.
    SETTLED = "SETTLED"
    #: A relationship is still forming -- the other leg is placing.
    WAITING = "WAITING"
    #: An exit was requested for this leg.
    EXITING = "EXITING"
    #: Marked as orphaned, durably, so it is closed even after a restart.
    FLAGGED = "FLAGGED"
    #: The operator was told the risk changed, and nothing was closed.
    REPORTED = "REPORTED"


@dataclass(frozen=True, slots=True)
class Coordination:
    trade: Trade
    action: LegAction
    reason: TradeExitReason | None = None
    detail: str | None = None


class LegCoordinator:
    """Keeps a multi-leg position coherent as its legs finish."""

    def __init__(
        self,
        book: TradingClientManager,
        request_exit: RequestExit,
        alerts: AlertManager,
    ) -> None:
        self._book = book
        self._request_exit = request_exit
        self._alerts = alerts

    # -- a leg has gone ------------------------------------------------------

    async def on_exit(self, trade: Trade) -> Sequence[Coordination]:
        """Pull whatever depended on the leg that just finished."""
        if is_hedge(trade):
            return await self._hedge_has_gone(trade)
        return await self._main_has_gone(trade)

    async def _main_has_gone(self, main: Trade) -> Sequence[Coordination]:
        """The protected leg is out, so its protection has nothing left to do."""
        hedge = await self._book.hedge_for(main)
        if hedge is None or not hedge.is_live:
            return []
        logger.info(
            "%s: %s exited, so its hedge %s follows",
            self._book.label,
            main.instrument,
            hedge.instrument,
        )
        await self._request_exit(hedge, TradeExitReason.MAIN_LEG_EXIT)
        return [Coordination(hedge, LegAction.EXITING, TradeExitReason.MAIN_LEG_EXIT)]

    async def _hedge_has_gone(self, hedge: Trade) -> Sequence[Coordination]:
        """The protection is out and the position it capped is still open.

        Not closed automatically. Which way that should go depends on the
        strategy -- replace the hedge, or take the position off -- and it is
        the operator's call, not one to infer here. What is not optional is
        saying so: the risk on that position has changed materially.
        """
        main = await self._book.hedge_for(hedge)
        if main is None or not main.is_live:
            return []
        await self._alerts.critical(
            EntityType.RISK,
            self._book.label,
            "hedge",
            f"{main.instrument} has lost its hedge ({hedge.instrument} exited on "
            f"{hedge.exit_reason}) and is now running unhedged. It has NOT been closed "
            f"automatically — decide whether to replace the hedge or exit the position.",
            key=f"main-unhedged:{main.id}",
        )
        return [Coordination(main, LegAction.REPORTED, detail="running unhedged")]

    # -- the periodic sweep --------------------------------------------------

    async def sweep(self, now: datetime) -> Sequence[Coordination]:
        """Check every live leg against the state of the ones it belongs with.

        A sweep as well as the exit hook, because the cases that matter most
        are the ones where nothing exited at all: a main that never placed
        leaves no exit to react to.
        """
        results: list[Coordination] = []
        for trade in self._book.live_trades():
            if is_hedge(trade):
                results.append(await self._check_hedge(trade, now))
            else:
                outcome = await self._check_pair(trade)
                if outcome is not None:
                    results.append(outcome)
        return [result for result in results if result.action is not LegAction.SETTLED]

    async def _check_hedge(self, hedge: Trade, now: datetime) -> Coordination:
        if hedge.relationships.main_entry_failed:
            # The flag alone is enough. It is durable precisely so this works
            # when the failed main is no longer anywhere to be found.
            await self._request_exit(hedge, TradeExitReason.HEDGE_ORPHANED)
            return Coordination(hedge, LegAction.EXITING, TradeExitReason.HEDGE_ORPHANED)

        main = await self._book.hedge_for(hedge)
        if main is not None and main.is_terminal:
            await self._request_exit(hedge, TradeExitReason.MAIN_LEG_EXIT)
            return Coordination(hedge, LegAction.EXITING, TradeExitReason.MAIN_LEG_EXIT)
        if main is not None:
            return Coordination(hedge, LegAction.SETTLED)

        return await self._hedge_without_a_main(hedge, now)

    async def _hedge_without_a_main(self, hedge: Trade, now: datetime) -> Coordination:
        """No main trade at all. Either it is still placing, or it never will.

        Told apart by the main's *signal*: if it is disabled or its validity
        has passed without producing a trade, the main is never coming. The
        time check matters as much as the disabled flag, because during a tick
        outage nothing ever runs the code that would have disabled it.
        """
        main_signal = self._main_signal_for(hedge)
        if main_signal is None or not self._is_dead(main_signal, now):
            # Normal: the hedge is placed first and the main is following.
            return Coordination(hedge, LegAction.WAITING, detail="its main leg is still placing")

        if hedge.filled_quantity < hedge.quantity:
            # An unfilled hedge is not yet a naked position. If it fills, the
            # next sweep catches it.
            return Coordination(hedge, LegAction.WAITING, detail="orphaned, but not filled yet")

        flagged = replace(
            hedge,
            relationships=replace(hedge.relationships, main_entry_failed=True),
        )
        self._book.replace_trade(flagged)
        await self._alerts.critical(
            EntityType.RISK,
            self._book.label,
            "hedge",
            f"{hedge.instrument} is an orphaned hedge: the leg it protects never entered "
            f"({main_signal.disabled_reason or 'its signal expired'}). It is a naked "
            f"position nobody asked for and is being closed.",
            key=f"hedge-orphaned:{hedge.id}",
        )
        await self._request_exit(flagged, TradeExitReason.HEDGE_ORPHANED)
        return Coordination(flagged, LegAction.EXITING, TradeExitReason.HEDGE_ORPHANED)

    async def _check_pair(self, trade: Trade) -> Coordination | None:
        """One side of a two-sided view is a bet the strategy never made."""
        correlation = trade.relationships.pair_correlation_id
        if correlation is None:
            return None

        other = self._book.pair_for(trade)
        if other is not None and not other.is_terminal:
            return Coordination(trade, LegAction.SETTLED)
        if other is not None:
            return Coordination(trade, LegAction.SETTLED)

        signal = self._pair_signal_for(trade)
        if signal is None or not signal.disabled:
            return Coordination(trade, LegAction.WAITING, detail="its pair is still placing")
        if trade.filled_quantity < trade.quantity:
            return Coordination(trade, LegAction.WAITING, detail="pair failed, not filled yet")

        await self._alerts.warning(
            EntityType.TRADE,
            self._book.label,
            "pair",
            f"{trade.instrument} is holding one side of a pair on its own: the other side "
            f"failed to enter ({signal.disabled_reason or 'its signal was disabled'}). "
            f"Closing it.",
            key=f"pair-orphaned:{trade.id}",
        )
        await self._request_exit(trade, TradeExitReason.PAIR_TRADE_ENTRY_FAILED)
        return Coordination(trade, LegAction.EXITING, TradeExitReason.PAIR_TRADE_ENTRY_FAILED)

    # -- finding the other side ---------------------------------------------

    def _main_signal_for(self, hedge: Trade) -> TradeSignal | None:
        correlation = hedge.relationships.hedge_correlation_id
        if correlation is None:
            return None
        for signal in self._book.signals():
            if signal.relationships.hedge_correlation_id == correlation and not is_hedge(signal):
                return signal
        return None

    def _pair_signal_for(self, trade: Trade) -> TradeSignal | None:
        correlation = trade.relationships.pair_correlation_id
        if correlation is None:
            return None
        for signal in self._book.signals():
            if (
                signal.relationships.pair_correlation_id == correlation
                and signal.id != trade.signal_id
            ):
                return signal
        return None

    @staticmethod
    def _is_dead(signal: TradeSignal, now: datetime) -> bool:
        """Whether a signal will never produce a trade.

        Disabled for any reason, or simply out of time. The second half is
        what makes this work during an outage: the tick-driven path that would
        have disabled it never ran, but the clock moved anyway.
        """
        if signal.is_triggered:
            return False
        return signal.disabled or signal.has_expired(now)
