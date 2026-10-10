"""Writing a trade's life down as it happens.

`TradeLogger` in the reference engine. The alerts say what needs a person;
this says what happened, in order, so a trade can be read back afterwards --
placed, filled, protected, trailed, exited, and why. The Console draws it as
the trade's timeline.

**Awaited where the event happens, and never raises.** The reference queued
entries and drained them on a thread, with a bounded queue that dropped the
oldest under load -- machinery for thousands of accounts. For a handful the
write is cheap enough to do when the event happens, as the breach log does.
Either way the record is an account of the trade, not part of it: a store
that is down costs the timeline, never the order.

**The call sites are the reference's own**, ported one by one from its trade
manager: entry placed and failed; entry filled and rejected; the stop placed
and trailed; the target placed, or the exit order when the trade is on its
way out; the exit triggered, once, not on every sweep that finds it already
leaving; and the trade completed. Garuda also writes the refusals the
reference names but never logged -- a stop or a target the broker refused,
an exit the engine gave up on -- because a timeline that stops at "exit
triggered" with the position still open is the one an operator most needs
to read.
"""

from __future__ import annotations

import logging
from dataclasses import replace
from typing import TYPE_CHECKING, Protocol

from garuda.domain.trade_log import TradeLogEntry, TradeLogEventType

if TYPE_CHECKING:
    from decimal import Decimal

    from garuda.domain.money import Money
    from garuda.domain.order import BrokerOrderId, OrderRequest
    from garuda.domain.trade import Trade
    from garuda.domain.trade_state import TradeExitReason
    from garuda.protocols.account import OrderUpdate
    from garuda.protocols.clock import Clock
    from garuda.trademgmt.dedup import InstrumentLookup

logger = logging.getLogger(__name__)


class TradeLogSink(Protocol):
    """Where entries go. The database, in production; a list, in a test."""

    async def write(self, entry: TradeLogEntry) -> None: ...


class TradeLogger:
    """Builds the entry from the trade and hands it to the sink."""

    def __init__(
        self,
        sink: TradeLogSink | None,
        instruments: InstrumentLookup,
        clock: Clock,
        *,
        label: str = "",
    ) -> None:
        self._sink = sink
        self._instruments = instruments
        self._clock = clock
        self._label = label

    # -- the entry --------------------------------------------------------

    async def entry_placed(
        self,
        trade: Trade,
        order_id: BrokerOrderId,
        request: OrderRequest | None = None,
        *,
        adopted: bool = False,
    ) -> None:
        """The entry order is at the broker, sent now or found from before."""
        summary = f" [orderId={order_id}" + (
            f", type={request.order_type}]" if request is not None else "]"
        )
        message = "Entry order placed" + summary
        if adopted:
            message += ", adopted from an earlier attempt"
        await self._write(
            self._from_trade(trade, TradeLogEventType.ENTRY_ORDER_PLACED, message),
            **self._from_request(order_id, request),
        )

    async def entry_filled(self, trade: Trade, update: OrderUpdate) -> None:
        """Logged on every fill; the type says whether it is the last."""
        complete = trade.filled_quantity >= trade.quantity
        event = TradeLogEventType.ENTRY_FILLED if complete else TradeLogEventType.ENTRY_PARTIAL_FILL
        what = "Entry filled" if complete else "Entry partly filled"
        message = f"{what} at {_price(trade.entry)} (qty={trade.filled_quantity}/{trade.quantity})"
        await self._write(self._from_trade(trade, event, message), **self._from_update(update))

    async def entry_rejected(
        self, trade: Trade, reason: str, update: OrderUpdate | None = None
    ) -> None:
        """The entry order is gone without a position behind it."""
        await self._write(
            self._from_trade(trade, TradeLogEventType.ENTRY_REJECTED, f"Entry rejected: {reason}"),
            error_message=reason,
            **(self._from_update(update) if update is not None else {}),
        )

    async def entry_failed(self, trade: Trade, reason: str) -> None:
        """No order could be placed at all."""
        await self._write(
            self._from_trade(trade, TradeLogEventType.ENTRY_FAILED, f"Entry failed: {reason}"),
            error_message=reason,
        )

    # -- the stop ---------------------------------------------------------

    async def stop_placed(
        self, trade: Trade, order_id: BrokerOrderId, request: OrderRequest
    ) -> None:
        await self._write(
            self._from_trade(
                trade,
                TradeLogEventType.SL_ORDER_PLACED,
                f"SL order placed at {_price(trade.protection.stop_loss)}",
            ),
            **self._from_request(order_id, request),
        )

    async def stop_rejected(
        self, trade: Trade, reason: str, order_id: BrokerOrderId | None = None
    ) -> None:
        """The broker would not take the stop, or threw it out later."""
        await self._write(
            self._from_trade(trade, TradeLogEventType.SL_REJECTED, f"SL rejected: {reason}"),
            error_message=reason,
            order_id=str(order_id) if order_id is not None else None,
        )

    async def stop_trailed(
        self, trade: Trade, previous: Money, order_id: BrokerOrderId | None = None
    ) -> None:
        """The stop moved. ``trade`` already carries the new level."""
        await self._write(
            self._from_trade(
                trade,
                TradeLogEventType.SL_TRAIL_UPDATED,
                f"SL trailed from {_price(previous)} to {_price(trade.protection.stop_loss)}",
            ),
            order_id=str(order_id) if order_id is not None else None,
        )

    # -- the way out ------------------------------------------------------

    async def target_placed(
        self, trade: Trade, order_id: BrokerOrderId, request: OrderRequest
    ) -> None:
        await self._write(
            self._from_trade(
                trade,
                TradeLogEventType.TARGET_ORDER_PLACED,
                f"Target order placed at {_price(trade.protection.target)}",
            ),
            **self._from_request(order_id, request),
        )

    async def target_rejected(self, trade: Trade, reason: str) -> None:
        await self._write(
            self._from_trade(
                trade, TradeLogEventType.TARGET_ORDER_REJECTED, f"Target rejected: {reason}"
            ),
            error_message=reason,
        )

    async def exit_triggered(self, trade: Trade, reason: TradeExitReason) -> None:
        """A square-off is queued. Once per exit, as in the reference: every
        sweep finds the trade still leaving, and saying so again says nothing."""
        await self._write(
            self._from_trade(trade, TradeLogEventType.EXIT_TRIGGERED, f"Exit triggered: {reason}")
        )

    async def exit_order_placed(
        self, trade: Trade, order_id: BrokerOrderId, request: OrderRequest
    ) -> None:
        await self._write(
            self._from_trade(
                trade,
                TradeLogEventType.EXIT_ORDER_PLACED,
                f"Exit order placed [orderId={order_id}, type={request.order_type}]",
            ),
            **self._from_request(order_id, request),
        )

    async def exit_failed(self, trade: Trade, reason: str) -> None:
        """An exit order was refused, or the engine stopped trying."""
        await self._write(
            self._from_trade(trade, TradeLogEventType.EXIT_FAILED, f"Exit failed: {reason}"),
            error_message=reason,
        )

    async def trade_completed(self, trade: Trade, update: OrderUpdate | None = None) -> None:
        """The position is out. The line carries what the operator asks first."""
        message = (
            f"Trade completed: {trade.exit_reason}, entry={_price(trade.entry)}, "
            f"exit={_price(trade.exit)}, pnl={_price(trade.realised_pnl)}"
        )
        await self._write(
            self._from_trade(trade, TradeLogEventType.TRADE_COMPLETED, message),
            **(self._from_update(update) if update is not None else {}),
        )

    async def error(self, trade: Trade, operation: str, message: str) -> None:
        await self._write(
            self._from_trade(
                trade, TradeLogEventType.GENERIC_ERROR, f"Error during {operation}: {message}"
            ),
            error_message=message,
        )

    # -- internals --------------------------------------------------------

    def _from_trade(self, trade: Trade, event: TradeLogEventType, message: str) -> TradeLogEntry:
        """The reference's projection of a trade onto a row, field for field."""
        instrument = self._instruments(trade.instrument)
        return TradeLogEntry(
            trade_id=trade.id.value,
            trading_client=trade.trading_client,
            event_type=event,
            at=self._clock.now(),
            message=message,
            strategy=trade.strategy,
            trading_symbol=(
                instrument.trading_symbol if instrument is not None else _symbol_of(trade)
            ),
            hedge_correlation_id=trade.relationships.hedge_correlation_id,
            quantity=trade.quantity if trade.quantity > 0 else None,
            filled_quantity=trade.filled_quantity if trade.filled_quantity > 0 else None,
            price=trade.entry.amount if trade.entry is not None else None,
            sl_price=_amount(trade.protection.stop_loss),
            target_price=_amount(trade.protection.target),
        )

    @staticmethod
    def _from_request(order_id: BrokerOrderId, request: OrderRequest | None) -> dict[str, object]:
        """What the order looked like when it went out."""
        if request is None:
            return {"order_id": str(order_id)}
        price = request.price if request.price is not None else request.trigger_price
        fields: dict[str, object] = {
            "order_id": str(order_id),
            "order_type": str(request.order_type),
            "quantity": request.quantity,
        }
        if price is not None:
            fields["price"] = price.amount
        return fields

    @staticmethod
    def _from_update(update: OrderUpdate) -> dict[str, object]:
        """What the broker said about the order."""
        fields: dict[str, object] = {
            "order_id": str(update.broker_order_id),
            "order_status": str(update.status) if update.status is not None else None,
        }
        if update.average_price is not None:
            fields["price"] = update.average_price.amount
        if update.quantity > 0:
            fields["quantity"] = update.quantity
        if update.filled_quantity > 0:
            fields["filled_quantity"] = update.filled_quantity
        return fields

    async def _write(self, entry: TradeLogEntry, **overrides: object) -> None:
        if self._sink is None:
            return
        if overrides:
            entry = replace(entry, **overrides)  # type: ignore[arg-type]
        try:
            await self._sink.write(entry)
        except Exception:
            # The record is not the trade. Whatever the sink did wrong is
            # logged here and the order path carries on.
            logger.exception(
                "%s: could not record %s for %s", self._label, entry.event_type, entry.trade_id
            )


def _price(value: Money | None) -> str:
    return str(value.amount) if value is not None else "-"


def _amount(value: Money | None) -> Decimal | None:
    return value.amount if value is not None else None


def _symbol_of(trade: Trade) -> str:
    """The instrument's own name when the master has no row for it."""
    _, _, symbol = trade.instrument.value.rpartition(":")
    return symbol or trade.instrument.value
