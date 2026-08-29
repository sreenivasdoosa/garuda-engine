"""Placing the orders that get a position out.

Two orders with opposite dispositions, and the difference is the whole design:

**A stop never gives up.** If placement fails, the engine tries again on the
next pass, and the next, for as long as the position is open. Counting attempts
does not stop the retrying -- it decides when to escalate from a warning to
paging the operator. The reference engine learned this from a position that sat
unprotected for three hours with nothing above a coalesced warning.

**A target does give up.** After enough failures it stops and says so, because
a target that will not place costs an opportunity while a stop that will not
place costs the account. The exception is an exit that is a square-off: getting
out is not optional, so it keeps trying regardless.

Between the two sits deferral, which is neither success nor failure. A target
outside the day's price band is not rejected, it is early -- the band moves,
and a target unplaceable at ten may be fine at two.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum
from uuid import uuid4

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.enums import OrderType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import PriceBand, Tick
from garuda.domain.money import Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest
from garuda.domain.trade import Trade
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.protective_rules import (
    DeferReason,
    exit_side,
    has_no_stop_configured,
    protectable_quantity,
    stop_already_breached,
    stop_at_market,
    stop_order_shape,
    stop_within_circuit,
    target_defer_reason,
    trigger_to_limit_gap,
)

logger = logging.getLogger(__name__)

#: How long after a placement before another is attempted for the same trade.
#: Without it a failing stop is re-sent on every tick.
REPLACEMENT_INTERVAL = timedelta(seconds=30)

#: Failures after which a stop that still will not place pages the operator.
#: It does not stop the retrying.
STOP_ALERT_THRESHOLD = 3

#: Failures after which a target stops being attempted.
MAX_TARGET_ATTEMPTS = 5

type PlaceOrder = Callable[[OrderRequest], Awaitable[BrokerOrderId]]
type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type BandLookup = Callable[[InstrumentId], PriceBand | None]
type TickLookup = Callable[[InstrumentId], Tick | None]
#: The per-segment trigger-to-limit gap the venue permits, as a percentage.
type SegmentGapLookup = Callable[[Trade], Decimal]


class ProtectionOutcome(StrEnum):
    PLACED = "PLACED"
    #: Already covered, or nothing to cover yet.
    NOT_NEEDED = "NOT_NEEDED"
    #: Cannot be placed at this moment, and will be tried again.
    DEFERRED = "DEFERRED"
    #: Attempted and refused. A stop stays in this state and keeps trying; a
    #: target reaching its limit becomes ABANDONED.
    FAILED = "FAILED"
    ABANDONED = "ABANDONED"


@dataclass(frozen=True, slots=True)
class ProtectionResult:
    outcome: ProtectionOutcome
    trade: Trade
    order_id: BrokerOrderId | None = None
    detail: str | None = None


class ProtectiveOrderService:
    """Keeps a stop, and a target, against an open position."""

    def __init__(
        self,
        book: TradingClientManager,
        place_order: PlaceOrder,
        instruments: InstrumentLookup,
        last_tick: TickLookup,
        price_band: BandLookup,
        segment_gap: SegmentGapLookup,
        clock: Clock,
        alerts: AlertManager,
        *,
        replacement_interval: timedelta = REPLACEMENT_INTERVAL,
        stop_alert_threshold: int = STOP_ALERT_THRESHOLD,
        max_target_attempts: int = MAX_TARGET_ATTEMPTS,
    ) -> None:
        self._book = book
        self._place = place_order
        self._instruments = instruments
        self._last_tick = last_tick
        self._price_band = price_band
        self._segment_gap = segment_gap
        self._clock = clock
        self._alerts = alerts
        self._replacement_interval = replacement_interval
        self._stop_alert_threshold = stop_alert_threshold
        self._max_target_attempts = max_target_attempts
        #: When a protective order was last sent, per trade and kind.
        self._last_attempt: dict[tuple[str, str], datetime] = {}
        #: Why a target was last deferred, so a change of reason is worth
        #: saying and a repeat is not.
        self._deferred_for: dict[str, DeferReason] = {}

    # -- the stop -----------------------------------------------------------

    async def place_stop(self, trade: Trade) -> ProtectionResult:
        """Cover an open position, or explain why it is not covered yet."""
        now = self._clock.now()

        if not trade.is_active:
            return ProtectionResult(ProtectionOutcome.NOT_NEEDED, trade, detail="not filled yet")
        if has_no_stop_configured(trade):
            # A leg governed by a combined stop has no level of its own and
            # never will. Saying so once beats warning about it every tick.
            return ProtectionResult(
                ProtectionOutcome.NOT_NEEDED, trade, detail="no stop is configured for this leg"
            )

        quantity = protectable_quantity(trade)
        if quantity <= 0:
            return ProtectionResult(
                ProtectionOutcome.NOT_NEEDED, trade, detail="nothing has filled to protect"
            )
        if self._too_soon(trade, "stop", now):
            return ProtectionResult(
                ProtectionOutcome.DEFERRED, trade, detail="a stop was attempted moments ago"
            )

        instrument = self._instruments(trade.instrument)
        stop = trade.protection.stop_loss
        if instrument is None or stop is None:
            return ProtectionResult(
                ProtectionOutcome.DEFERRED, trade, detail="the instrument is not yet known"
            )

        stop = self._usable_stop(trade, stop, instrument)
        gap = trigger_to_limit_gap(
            trade.protection.trigger_to_limit_gap_percent, self._segment_gap(trade)
        )
        band = self._price_band(trade.instrument)
        if band is not None:
            stop = stop_within_circuit(stop, band, instrument, trade.direction, gap)

        shape = stop_order_shape(trade.direction, stop, instrument, gap)
        request = OrderRequest(
            client_order_id=_order_id(),
            trading_client=trade.trading_client,
            instrument=trade.instrument,
            side=exit_side(trade.direction),
            quantity=quantity,
            order_type=shape.order_type,
            product=trade.product,
            price=shape.price,
            trigger_price=shape.trigger_price,
            tag=trade.strategy,
        )

        self._last_attempt[(trade.id.value, "stop")] = now
        try:
            order_id = await self._place(request)
        except Exception as error:
            return await self._stop_failed(trade, error)

        covered = replace(
            trade,
            protection=replace(trade.protection, stop_loss=stop),
            attempts=replace(trade.attempts, stop_loss_order_attempts=0),
        )
        self._book.replace_trade(covered)
        self._book.link_order(order_id, trade.id)
        logger.info("%s: %s covered by a stop at %s", self._book.label, trade.instrument, stop)
        return ProtectionResult(ProtectionOutcome.PLACED, covered, order_id)

    async def _stop_failed(self, trade: Trade, error: Exception) -> ProtectionResult:
        """Record a failure and keep the retry alive.

        A position must never be left without a stop, so this never abandons.
        The attempt count only decides when the operator is paged rather than
        told quietly -- a repeatedly failing stop that hides behind coalesced
        warnings is how a position sits uncovered for hours.
        """
        attempts = trade.attempts.stop_loss_order_attempts + 1
        failed = replace(trade, attempts=replace(trade.attempts, stop_loss_order_attempts=attempts))
        self._book.replace_trade(failed)

        message = (
            f"{trade.instrument} has no stop at the broker after {attempts} attempts "
            f"({error}). The position is UNPROTECTED and the engine will keep trying."
        )
        if attempts >= self._stop_alert_threshold:
            await self._alerts.critical(
                EntityType.RISK,
                self._book.label,
                "stop-loss",
                message,
                key=f"stop-unprotected:{trade.id}",
            )
        else:
            await self._alerts.warning(
                EntityType.RISK,
                self._book.label,
                "stop-loss",
                f"{trade.instrument}: stop placement failed ({error}); retrying",
                key=f"stop-retry:{trade.id}",
            )
        logger.warning("%s: %s", self._book.label, message)
        return ProtectionResult(ProtectionOutcome.FAILED, failed, detail=str(error))

    def _usable_stop(self, trade: Trade, stop: Money, instrument: Instrument) -> Money:
        """The level to actually send, given where the market already is.

        A stop the market has already passed cannot trigger. Sending it leaves
        the position with nothing; placing at the market gets out now, which is
        what the stop was for.
        """
        tick = self._last_tick(trade.instrument)
        if tick is None or not stop_already_breached(trade.direction, stop, tick.last_price):
            return stop
        moved = stop_at_market(trade.direction, tick.last_price, instrument)
        logger.warning(
            "%s: %s is already past its stop of %s at %s; placing at the market instead",
            self._book.label,
            trade.instrument,
            stop,
            tick.last_price,
        )
        return moved

    # -- the target ---------------------------------------------------------

    async def place_target(
        self, trade: Trade, *, at_market: bool = False, quantity: int | None = None
    ) -> ProtectionResult:
        """Place the order that takes the position off at a profit, or out."""
        now = self._clock.now()

        if not trade.is_active:
            return ProtectionResult(ProtectionOutcome.NOT_NEEDED, trade, detail="not filled yet")
        if trade.protection.no_target and not at_market:
            return ProtectionResult(
                ProtectionOutcome.NOT_NEEDED, trade, detail="no target is configured"
            )

        size = quantity if quantity is not None else protectable_quantity(trade)
        if size <= 0:
            return ProtectionResult(
                ProtectionOutcome.NOT_NEEDED, trade, detail="nothing has filled to exit"
            )

        is_exiting = trade.is_exiting or at_market
        if not is_exiting and trade.attempts.target_order_attempts >= self._max_target_attempts:
            # A target that will not place costs an opportunity. A square-off
            # that will not place costs the account, which is why only the
            # former is ever abandoned.
            return ProtectionResult(
                ProtectionOutcome.ABANDONED,
                trade,
                detail=f"{trade.attempts.target_order_attempts} attempts, none accepted",
            )
        if self._too_soon(trade, "target", now):
            return ProtectionResult(
                ProtectionOutcome.DEFERRED, trade, detail="a target was attempted moments ago"
            )

        instrument = self._instruments(trade.instrument)
        target = trade.protection.target
        if instrument is None or (target is None and not at_market):
            return ProtectionResult(
                ProtectionOutcome.DEFERRED, trade, detail="no target price to place"
            )

        if target is not None:
            deferral = target_defer_reason(
                target, self._price_band(trade.instrument), is_market=at_market
            )
            if deferral is not None:
                return await self._target_deferred(trade, target, deferral)
        await self._target_resumed(trade)

        request = _target_request(trade, instrument, size, target, at_market=at_market)
        self._last_attempt[(trade.id.value, "target")] = now
        try:
            order_id = await self._place(request)
        except Exception as error:
            return await self._target_failed(trade, error, must_get_out=is_exiting)

        placed = replace(trade, attempts=replace(trade.attempts, target_order_attempts=0))
        self._book.replace_trade(placed)
        self._book.link_order(order_id, trade.id)
        return ProtectionResult(ProtectionOutcome.PLACED, placed, order_id)

    async def _target_failed(
        self, trade: Trade, error: Exception, *, must_get_out: bool
    ) -> ProtectionResult:
        """Count the failure, and abandon only what may be abandoned.

        ``must_get_out`` covers both a square-off already under way and an
        explicit market exit. Neither is ever given up on: the position has to
        close, and stopping leaves it open with nobody trying.
        """
        attempts = trade.attempts.target_order_attempts + 1
        failed = replace(trade, attempts=replace(trade.attempts, target_order_attempts=attempts))
        self._book.replace_trade(failed)

        if attempts >= self._max_target_attempts and not must_get_out:
            await self._alerts.critical(
                EntityType.ORDER,
                self._book.label,
                "target",
                f"{trade.instrument}: the target could not be placed in {attempts} attempts "
                f"({error}). The position is still open with its stop only.",
                key=f"target-abandoned:{trade.id}",
            )
            return ProtectionResult(ProtectionOutcome.ABANDONED, failed, detail=str(error))

        await self._alerts.warning(
            EntityType.ORDER,
            self._book.label,
            "target",
            f"{trade.instrument}: target placement failed ({error}); retrying",
            key=f"target-retry:{trade.id}",
        )
        return ProtectionResult(ProtectionOutcome.FAILED, failed, detail=str(error))

    async def _target_deferred(
        self, trade: Trade, target: Money, reason: DeferReason
    ) -> ProtectionResult:
        """Wait for the band to permit the target, saying so once per reason."""
        if self._deferred_for.get(trade.id.value) is not reason:
            self._deferred_for[trade.id.value] = reason
            await self._alerts.info(
                EntityType.ORDER,
                self._book.label,
                "target",
                f"{trade.instrument}: a target of {target} is outside the day's price band "
                f"({reason}). It will be placed when the band permits it.",
                key=f"target-deferred:{trade.id}",
            )
        return ProtectionResult(ProtectionOutcome.DEFERRED, trade, detail=str(reason))

    async def _target_resumed(self, trade: Trade) -> None:
        previous = self._deferred_for.pop(trade.id.value, None)
        if previous is not None:
            await self._alerts.info(
                EntityType.ORDER,
                self._book.label,
                "target",
                f"{trade.instrument}: the price band now permits its target "
                f"(it was deferred for {previous})",
                key=f"target-resumed:{trade.id}",
            )

    # -- shared -------------------------------------------------------------

    def _too_soon(self, trade: Trade, kind: str, now: datetime) -> bool:
        last = self._last_attempt.get((trade.id.value, kind))
        return last is not None and now - last < self._replacement_interval


def _target_request(
    trade: Trade,
    instrument: Instrument,
    quantity: int,
    target: Money | None,
    *,
    at_market: bool,
) -> OrderRequest:
    return OrderRequest(
        client_order_id=_order_id(),
        trading_client=trade.trading_client,
        instrument=trade.instrument,
        side=exit_side(trade.direction),
        quantity=quantity,
        order_type=OrderType.MARKET if at_market or target is None else OrderType.LIMIT,
        product=trade.product,
        price=None if at_market or target is None else instrument.quantize_price(target),
        tag=trade.strategy,
    )


def _order_id() -> ClientOrderId:
    return ClientOrderId(f"g{uuid4().hex[:15]}")


__all__ = [
    "MAX_TARGET_ATTEMPTS",
    "REPLACEMENT_INTERVAL",
    "STOP_ALERT_THRESHOLD",
    "ProtectionOutcome",
    "ProtectionResult",
    "ProtectiveOrderService",
]
