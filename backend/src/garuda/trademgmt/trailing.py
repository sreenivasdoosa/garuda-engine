"""Moving a stop as a position earns the right to a tighter one.

Three rules carry the whole thing, and the first is not negotiable.

**A stop only ever tightens.** Every calculation is checked against the
current level and refused if it would loosen it. A stop that can move away
from the price is not a stop, and one calculator reading a momentarily lower
high would hand back everything the position had earned.

**A broker caps how often one order may be modified.** Past that the modify is
refused, so the order is cancelled and a fresh one placed instead. The
replaced order is remembered until its cancel confirms, because until then it
is still live and a fill on it is still a real exit.

**A stop that was never sent as an order still moves.** A strategy can ask for
the level to be tracked without an order resting at the broker; the exit then
goes at market when the level is crossed. Trailing has to keep working in that
mode or the tracked level goes stale.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, replace
from decimal import Decimal
from enum import StrEnum

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Trade
from garuda.domain.trade_orders import OrderRole
from garuda.protocols.broker import OrderChanges
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.protective_rules import stop_order_shape, trigger_to_limit_gap
from garuda.trademgmt.trailing_rules import (
    TrailConfig,
    improves,
    risk_multiple_stop,
    trail_to_cost_stop,
)

logger = logging.getLogger(__name__)

#: How many times one order may be modified before it is replaced instead.
#: Brokers cap this; going past it is a refusal, not a slow modify.
MAX_ORDER_MODIFICATIONS = 20

#: Used when nothing supplies a venue gap. Trailing keeps whatever the strategy
#: configured; the venue cap is enforced where the stop is first placed.
DEFAULT_SEGMENT_GAP = Decimal(18)

type ModifyOrder = Callable[[BrokerOrderId, OrderChanges], Awaitable[None]]
type PlaceStop = Callable[[Trade], Awaitable[BrokerOrderId | None]]
type CancelOrder = Callable[[BrokerOrderId], Awaitable[None]]
type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type ConfigLookup = Callable[[Trade], TrailConfig | None]


class TrailOutcome(StrEnum):
    MOVED = "MOVED"
    #: The order was replaced rather than modified, having hit the cap.
    REPLACED = "REPLACED"
    #: The level moved without an order behind it, as configured.
    TRACKED = "TRACKED"
    #: Nothing has been earned yet, or the move would loosen the stop.
    HELD = "HELD"
    #: Configured to trail a way this engine cannot yet.
    UNSUPPORTED = "UNSUPPORTED"


@dataclass(frozen=True, slots=True)
class TrailResult:
    outcome: TrailOutcome
    trade: Trade
    from_stop: Money | None = None
    to_stop: Money | None = None
    detail: str | None = None


class TrailingService:
    """Keeps a stop as tight as the position has earned."""

    def __init__(
        self,
        book: TradingClientManager,
        modify_order: ModifyOrder,
        cancel_order: CancelOrder,
        place_stop: PlaceStop,
        instruments: InstrumentLookup,
        trail_config: ConfigLookup,
        alerts: AlertManager,
        *,
        max_modifications: int = MAX_ORDER_MODIFICATIONS,
    ) -> None:
        self._book = book
        self._modify = modify_order
        self._cancel = cancel_order
        self._place_stop = place_stop
        self._instruments = instruments
        self._config = trail_config
        self._alerts = alerts
        self._max_modifications = max_modifications
        #: Modifications sent per order. Reset by a restart, which at worst
        #: costs one refused modify before the replace path takes over.
        self._modifications: dict[BrokerOrderId, int] = {}

    async def on_tick(self, trade: Trade, tick: Tick) -> TrailResult:
        """Consider tightening this trade's stop, given a price."""
        if not trade.is_active or trade.is_exiting:
            return TrailResult(TrailOutcome.HELD, trade, detail="not a live position")

        watched = trade.with_price_seen(tick.last_price)
        if watched != trade:
            self._book.replace_trade(watched)
            trade = watched

        config = self._config(trade)
        if config is None or not trade.protection.is_trailing:
            return TrailResult(TrailOutcome.HELD, trade, detail="not trailing")

        instrument = self._instruments(trade.instrument)
        entry = trade.entry
        current = trade.protection.stop_loss
        initial = trade.protection.initial_stop_loss or current
        if instrument is None or entry is None or current is None or initial is None:
            return TrailResult(TrailOutcome.HELD, trade, detail="nothing to trail from")

        if config.mode.needs_candles:
            # Named rather than ignored: a strategy configured for a mode this
            # engine cannot compute must not silently trail some other way.
            await self._alerts.warning(
                EntityType.STRATEGY,
                self._book.label,
                "trailing",
                f"{trade.strategy} asks to trail by {config.mode}, which needs candle "
                f"history this engine does not have yet. {trade.instrument} keeps its "
                f"stop where it is.",
                key=f"trail-unsupported:{trade.strategy}:{config.mode}",
            )
            return TrailResult(TrailOutcome.UNSUPPORTED, trade, detail=str(config.mode))

        proposed = self._proposed_stop(trade, config, instrument, entry, initial, tick)
        if proposed is None or not improves(trade.direction, proposed, current):
            return TrailResult(TrailOutcome.HELD, trade, current, detail="nothing earned yet")

        return await self._move_stop(trade, current, proposed, instrument)

    def _proposed_stop(
        self,
        trade: Trade,
        config: TrailConfig,
        instrument: Instrument,
        entry: Money,
        initial: Money,
        tick: Tick,
    ) -> Money | None:
        """The tightest level either rule allows.

        Trail-to-cost and step trailing are not alternatives: a position may
        earn break-even before it earns its first step, and later earn steps
        beyond break-even. Whichever is tighter wins.
        """
        extreme = (
            trade.high_since_entry if trade.direction.sign > 0 else trade.low_since_entry
        ) or tick.last_price

        candidates = [
            risk_multiple_stop(
                direction=trade.direction,
                entry=entry,
                initial_stop=initial,
                extreme=extreme,
                config=config,
                instrument=instrument,
            ),
            trail_to_cost_stop(
                direction=trade.direction,
                entry=entry,
                initial_stop=initial,
                last=tick.last_price,
                config=config,
                instrument=instrument,
            ),
        ]
        offered = [level for level in candidates if level is not None]
        if not offered:
            return None
        return max(offered) if trade.direction.sign > 0 else min(offered)

    async def _move_stop(
        self, trade: Trade, current: Money, proposed: Money, instrument: Instrument
    ) -> TrailResult:
        moved = replace(trade, protection=trade.protection.moved_to(proposed))
        order_id = self._book.order_for(trade.id, OrderRole.STOP)

        if order_id is None:
            if not trade.protection.dont_place_stop_loss_order:
                # There should be an order and there is not. Moving the level
                # alone would leave the engine believing in protection that
                # does not exist at the broker.
                return TrailResult(
                    TrailOutcome.HELD, trade, current, detail="no stop order to move"
                )
            self._book.replace_trade(moved)
            logger.info(
                "%s: %s tracked stop moved %s -> %s",
                self._book.label,
                trade.instrument,
                current,
                proposed,
            )
            return TrailResult(TrailOutcome.TRACKED, moved, current, proposed)

        sent = self._modifications.get(order_id, 0)
        if sent >= self._max_modifications:
            return await self._replace_stop(trade, moved, order_id, current, proposed)

        gap = trigger_to_limit_gap(
            trade.protection.trigger_to_limit_gap_percent, DEFAULT_SEGMENT_GAP
        )
        shape = stop_order_shape(trade.direction, proposed, instrument, gap)
        try:
            await self._modify(order_id, OrderChanges(price=shape.price, trigger_price=proposed))
        except Exception as error:
            await self._alerts.warning(
                EntityType.RISK,
                self._book.label,
                "trailing",
                f"{trade.instrument}: the stop could not be moved to {proposed} "
                f"({error}). It stays at {current}.",
                key=f"trail-failed:{trade.id}",
            )
            return TrailResult(TrailOutcome.HELD, trade, current, detail=str(error))

        self._modifications[order_id] = sent + 1
        self._book.replace_trade(moved)
        logger.info(
            "%s: %s stop moved %s -> %s", self._book.label, trade.instrument, current, proposed
        )
        return TrailResult(TrailOutcome.MOVED, moved, current, proposed)

    async def _replace_stop(
        self,
        trade: Trade,
        moved: Trade,
        order_id: BrokerOrderId,
        current: Money,
        proposed: Money,
    ) -> TrailResult:
        """Cancel an order that has been modified as often as allowed, and
        place a fresh one.

        The cancel has to succeed first. Placing a second stop while the first
        is still live doubles the protection, and when both fire the position
        reverses.
        """
        try:
            await self._cancel(order_id)
        except Exception as error:
            await self._alerts.warning(
                EntityType.RISK,
                self._book.label,
                "trailing",
                f"{trade.instrument}: its stop has been modified as often as the broker "
                f"allows and could not be cancelled to replace ({error}). It stays at "
                f"{current}.",
                key=f"trail-replace-failed:{trade.id}",
            )
            return TrailResult(TrailOutcome.HELD, trade, current, detail=str(error))

        self._modifications.pop(order_id, None)
        self._book.replace_trade(moved)
        placed = await self._place_stop(moved)
        if placed is None:
            await self._alerts.critical(
                EntityType.RISK,
                self._book.label,
                "trailing",
                f"{trade.instrument}: its stop was cancelled to be replaced and the new "
                f"one did not place. The position is UNPROTECTED.",
                key=f"trail-replace-unprotected:{trade.id}",
            )
            return TrailResult(
                TrailOutcome.HELD, moved, current, proposed, "the replacement did not place"
            )

        logger.info(
            "%s: %s stop replaced at %s after %d modifications",
            self._book.label,
            trade.instrument,
            proposed,
            self._max_modifications,
        )
        return TrailResult(TrailOutcome.REPLACED, moved, current, proposed)
