"""Advancing a trade as its orders move.

Everything that happens to a position after it is placed arrives as an update
about one of its orders. What that update *means* depends entirely on which
order it is: filled on the entry opened a position, filled on the stop closed
it at a loss, filled on the target closed it at a profit. The role is
therefore the first thing consulted, and the reason the book records one.

**One fold, two sources.** The broker pushes updates and the engine also polls
the order book, and the reference engine folded each through its own code. Here
a polled row is turned into the same update the stream would have produced and
goes through the same rules -- which is what makes the poll a genuine backstop
rather than a second implementation to keep in step.

The rules that fold an update into an order (a terminal order is frozen, a
fill never regresses, an update belongs to the client it names) live in
ordermgmt. What is here is what those folds mean to the *trade*.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from enum import StrEnum

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.enums import OrderStatus
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Trade
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.account import OrderUpdate
from garuda.protocols.broker import BrokerOrder
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager

logger = logging.getLogger(__name__)

#: Cancels an order at the broker. Failure is reported, never raised: a stop
#: that could not be cancelled is a problem to tell someone about, not a
#: reason to abandon the rest of the cleanup.
type CancelOrder = Callable[[BrokerOrderId], Awaitable[None]]


class TrackOutcome(StrEnum):
    #: The update said nothing the trade did not already know.
    UNCHANGED = "UNCHANGED"
    #: The entry filled, in whole or in part.
    ENTERED = "ENTERED"
    #: The position closed.
    EXITED = "EXITED"
    #: The entry never became a position.
    ENTRY_FAILED = "ENTRY_FAILED"


@dataclass(frozen=True, slots=True)
class TrackResult:
    outcome: TrackOutcome
    trade: Trade
    detail: str | None = None


class TradeTracker:
    """Turns order updates into what happened to the position."""

    def __init__(
        self,
        book: TradingClientManager,
        cancel_order: CancelOrder,
        clock: Clock,
        alerts: AlertManager,
    ) -> None:
        self._book = book
        self._cancel = cancel_order
        self._clock = clock
        self._alerts = alerts

    async def on_order_update(self, update: OrderUpdate) -> TrackResult | None:
        """Fold one order update into the trade it belongs to.

        None when the order belongs to no trade the engine knows -- a manual
        order placed in the same account, which is not the engine's to track.
        """
        trade = self._book.trade_for_order(update.broker_order_id)
        if trade is None:
            return None
        role = self._book.role_of(update.broker_order_id) or OrderRole.ENTRY

        if trade.is_terminal:
            return TrackResult(TrackOutcome.UNCHANGED, trade, "the trade is already finished")

        if role is OrderRole.ENTRY:
            return await self._entry_moved(trade, update)
        return await self._exit_moved(trade, update, role)

    # -- the entry ----------------------------------------------------------

    async def _entry_moved(self, trade: Trade, update: OrderUpdate) -> TrackResult:
        filled = update.filled_quantity

        if filled > trade.filled_quantity:
            price = update.average_price
            if price is None:
                # A quantity with no price would put a zero into the average,
                # and a wrong average is a wrong P&L on every report after it.
                return TrackResult(
                    TrackOutcome.UNCHANGED, trade, "filled, but the broker sent no price"
                )
            entered = trade.with_entry_fill(
                filled - trade.filled_quantity, price, self._now(update)
            )
            self._book.replace_trade(entered)
            logger.info(
                "%s: %s filled %d of %d at %s",
                self._book.label,
                trade.instrument,
                entered.filled_quantity,
                entered.quantity,
                price,
            )
            return TrackResult(TrackOutcome.ENTERED, entered)

        if update.status in (OrderStatus.REJECTED, OrderStatus.CANCELLED):
            return await self._entry_ended_without_a_position(trade, update)

        return TrackResult(TrackOutcome.UNCHANGED, trade)

    async def _entry_ended_without_a_position(
        self, trade: Trade, update: OrderUpdate
    ) -> TrackResult:
        """The entry order is gone. Whether that ends the trade depends on
        whether anything filled first.

        A partially filled entry that is then cancelled is a real position for
        what filled, and is kept. Only an entry with nothing at all behind it
        cancels the trade.
        """
        if trade.filled_quantity > 0:
            logger.info(
                "%s: %s entry %s but %d had already filled; keeping the position",
                self._book.label,
                trade.instrument,
                update.status,
                trade.filled_quantity,
            )
            return TrackResult(TrackOutcome.UNCHANGED, trade, "partly filled before it ended")

        reason = update.message or f"the entry order was {update.status}"
        await self._cancel_protective_orders(trade)
        cancelled = trade.cancelled(
            TradeExitReason.ENTRY_FAILED, self._now(update), failure_reason=reason
        )
        self._book.replace_trade(cancelled)

        await self._alerts.critical(
            EntityType.ORDER,
            self._book.label,
            "entry",
            f"{trade.instrument} for {trade.strategy} never entered: {reason}",
            key=f"entry-rejected:{trade.id}",
        )
        await self._orphan_the_hedge(cancelled, reason)
        return TrackResult(TrackOutcome.ENTRY_FAILED, cancelled, reason)

    # -- the way out --------------------------------------------------------

    async def _exit_moved(self, trade: Trade, update: OrderUpdate, role: OrderRole) -> TrackResult:
        """A protective order moved. A fill on one closes the position."""
        if update.filled_quantity <= 0:
            if update.status is OrderStatus.REJECTED and role is OrderRole.STOP:
                # The position is uncovered and nothing has said so. This is
                # the state a stop exists to prevent.
                await self._alerts.critical(
                    EntityType.RISK,
                    self._book.label,
                    "stop-loss",
                    f"{trade.instrument}: the stop was rejected "
                    f"({update.message or 'no reason given'}). The position is UNPROTECTED.",
                    key=f"stop-rejected:{trade.id}",
                )
            return TrackResult(TrackOutcome.UNCHANGED, trade)

        price = update.average_price
        if price is None:
            return TrackResult(
                TrackOutcome.UNCHANGED, trade, "exited, but the broker sent no price"
            )

        reason = self._exit_reason_for(trade, role)
        exited = trade.closed(price, reason, self._now(update))
        self._book.replace_trade(exited)

        await self._cancel_other_protective_orders(exited, role)
        logger.info("%s: %s exited at %s on %s", self._book.label, trade.instrument, price, reason)
        return TrackResult(TrackOutcome.EXITED, exited)

    @staticmethod
    def _exit_reason_for(trade: Trade, role: OrderRole) -> TradeExitReason:
        """Why the position closed, given which order closed it.

        A square-off already under way keeps its own reason -- an operator who
        asked for a manual exit should see that, not "target", merely because
        the exit was routed through the target order.
        """
        if trade.exiting_for is not None:
            return trade.exiting_for
        if role is OrderRole.TARGET:
            return TradeExitReason.TARGET
        if trade.protection.is_trailing and trade.protection.initial_stop_loss is not None:
            return TradeExitReason.TRAILING_STOP_LOSS
        return TradeExitReason.STOP_LOSS

    async def _cancel_other_protective_orders(self, trade: Trade, filled: OrderRole) -> None:
        """One way out having worked, the others must be withdrawn.

        A stop left live after the target filled is a naked position in the
        opposite direction the moment it triggers.
        """
        for role, order_id in self._book.orders_of(trade.id).items():
            if role is filled or role is OrderRole.ENTRY:
                continue
            await self._try_cancel(trade, order_id, role)
        for order_id in self._book.superseded_orders(trade.id):
            await self._try_cancel(trade, order_id, OrderRole.SUPERSEDED)

    async def _cancel_protective_orders(self, trade: Trade) -> None:
        for role, order_id in self._book.orders_of(trade.id).items():
            if role is not OrderRole.ENTRY:
                await self._try_cancel(trade, order_id, role)

    async def _try_cancel(self, trade: Trade, order_id: BrokerOrderId, role: OrderRole) -> None:
        try:
            await self._cancel(order_id)
        except Exception as error:
            # Reported rather than raised: an order that would not cancel is
            # something to tell an operator about, and stopping here would
            # leave the rest of the cleanup undone.
            await self._alerts.warning(
                EntityType.ORDER,
                self._book.label,
                "cancel",
                f"{trade.instrument}: the {role.lower()} order could not be cancelled "
                f"({error}). It may still be live at the broker.",
                key=f"cancel-failed:{trade.id}:{role}",
            )

    async def _orphan_the_hedge(self, trade: Trade, reason: str) -> None:
        hedge = await self._book.hedge_for(trade)
        if hedge is None or not hedge.is_live:
            return
        self._book.replace_trade(
            replace(
                hedge,
                relationships=replace(hedge.relationships, main_entry_failed=True),
            )
        )
        await self._alerts.warning(
            EntityType.TRADE,
            self._book.label,
            "hedge",
            f"{hedge.instrument} now protects nothing: the leg it hedges never entered "
            f"({reason}). It will be squared off.",
            key=f"hedge-orphaned:{hedge.id}",
        )

    # -- unfilled entries ---------------------------------------------------

    async def cancel_stale_entries(self, now: datetime) -> Sequence[TrackResult]:
        """Withdraw entry orders that were never meant to rest this long.

        A signal may say when an unfilled entry stops being wanted. Past that
        the order is cancelled and the trade closed as a failed entry, because
        a limit resting all day is an entry at a price the strategy no longer
        believes in.
        """
        results: list[TrackResult] = []
        for trade in self._book.live_trades():
            if trade.filled_quantity > 0:
                continue
            signal = self._book.signal(trade.signal_id) if trade.signal_id else None
            cutoff = signal.entry.cancel_unfilled_order_at if signal is not None else None
            if cutoff is None or now < cutoff:
                continue

            entry = self._book.order_for(trade.id, OrderRole.ENTRY)
            if entry is not None:
                await self._try_cancel(trade, entry, OrderRole.ENTRY)
            await self._cancel_protective_orders(trade)

            reason = "the entry order was not filled before its cut-off and was cancelled"
            cancelled = trade.cancelled(TradeExitReason.ENTRY_FAILED, now, failure_reason=reason)
            self._book.replace_trade(cancelled)
            await self._orphan_the_hedge(cancelled, reason)
            results.append(TrackResult(TrackOutcome.ENTRY_FAILED, cancelled, reason))
        return results

    def _now(self, update: OrderUpdate) -> datetime:
        return update.at or self._clock.now()


def update_from_broker_order(order: BrokerOrder) -> OrderUpdate:
    """Turn a polled order-book row into the update the stream would send.

    This is what makes the poll a backstop rather than a parallel
    implementation: both arrive at the trade through one set of rules.
    """
    return OrderUpdate(
        broker_order_id=order.broker_order_id,
        broker_client_id="",
        client_order_id=order.client_order_id,
        instrument=order.instrument,
        side=order.side,
        quantity=order.quantity,
        filled_quantity=order.filled_quantity,
        status=order.status,
        product=order.product,
        average_price=order.average_price,
    )
