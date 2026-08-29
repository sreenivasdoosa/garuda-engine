"""Getting out of a position that has to be got out of.

A square-off is not one action, it is a queue that keeps trying. The order may
be rejected, the broker may be down, the protective order may need cancelling
first, the position may have already gone. So a request is recorded, worked,
and re-worked until the position is flat or trying stops being useful.

The rules that matter are all about when to stop, because the failure modes at
both ends are bad. Stopping too early leaves a position nobody is closing.
Never stopping means an engine placing orders into a closed market for hours,
paging an operator each time.

**One request per trade.** Asking again while one is queued updates the reason
rather than adding a second: the exits fire from several places -- the intraday
cutoff, a hedge leaving, an operator -- and every one of them re-fires on a
timer. The more urgent reason wins, so a daily-loss breach is never downgraded
to a routine end-of-day sweep.

**Nothing is parked waiting for the broker to say something.** Each pass reads
the current state and decides again. The reference engine had a pass that
waited for a status that never came when a cancel rejection left a stop
trigger-pending for ever, and the position sat there.

**An unexpected failure must not wedge the queue.** Anything that escapes is
caught, reported, and the request rescheduled -- because the alternative is a
request marked in-progress that never finishes and a trade nobody is exiting.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta
from enum import StrEnum

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import AlertLevel, EntityType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_state import TradeExitReason, more_urgent
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.protective import ProtectionOutcome, ProtectiveOrderService
from garuda.trademgmt.squareoff_rules import (
    ExitWindow,
    is_retry_window_closed,
    is_worthless_option_at_expiry,
)

logger = logging.getLogger(__name__)

#: How long before a queued request is worked again. Short enough that an exit
#: is not left waiting, long enough that a broker refusing every attempt is not
#: hammered.
RECHECK_INTERVAL = timedelta(seconds=5)

#: How many fresh exit orders one trade may have placed for it before the
#: engine stops trying on its own. Repricing a resting order is not one of
#: these -- that has its own cap.
MAX_EXIT_PLACEMENTS = 5

type CancelOrder = Callable[[BrokerOrderId], Awaitable[None]]
type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type TickLookup = Callable[[InstrumentId], Tick | None]
type WindowLookup = Callable[[Trade], ExitWindow | None]
type ExpiryCheck = Callable[[Trade], bool]


class SquareOffOutcome(StrEnum):
    #: An exit order went out.
    PLACED = "PLACED"
    #: An exit is already working; nothing new was sent.
    IN_FLIGHT = "IN_FLIGHT"
    #: The position is flat.
    DONE = "DONE"
    #: Cannot be attempted now; it will be tried again.
    RETRY = "RETRY"
    #: Trying has stopped. The reason says whether that needs attention.
    GAVE_UP = "GAVE_UP"


@dataclass
class SquareOffRequest:
    """One trade's pending exit."""

    trade_id: TradeId
    reason: TradeExitReason
    requested_at: datetime
    next_eligible_at: datetime
    attempts: int = 0
    in_progress: bool = False

    def is_due(self, now: datetime) -> bool:
        return not self.in_progress and now >= self.next_eligible_at


@dataclass(frozen=True, slots=True)
class SquareOffResult:
    outcome: SquareOffOutcome
    trade: Trade | None = None
    reason: TradeExitReason | None = None
    detail: str | None = None


@dataclass
class _GivenUp:
    """Trades the engine has stopped exiting, and why. Alerted once each."""

    window_closed: set[TradeId] = field(default_factory=set)
    placements_exhausted: set[TradeId] = field(default_factory=set)


class SquareOffService:
    """The queue that gets positions out."""

    def __init__(
        self,
        book: TradingClientManager,
        protection: ProtectiveOrderService,
        cancel_order: CancelOrder,
        instruments: InstrumentLookup,
        last_tick: TickLookup,
        exit_window: WindowLookup,
        is_expiry_day: ExpiryCheck,
        clock: Clock,
        alerts: AlertManager,
        *,
        recheck: timedelta = RECHECK_INTERVAL,
        max_placements: int = MAX_EXIT_PLACEMENTS,
    ) -> None:
        self._book = book
        self._protection = protection
        self._cancel = cancel_order
        self._instruments = instruments
        self._last_tick = last_tick
        self._window = exit_window
        self._is_expiry_day = is_expiry_day
        self._clock = clock
        self._alerts = alerts
        self._recheck = recheck
        self._max_placements = max_placements
        self._queue: dict[TradeId, SquareOffRequest] = {}
        self._given_up = _GivenUp()

    @property
    def pending(self) -> Sequence[SquareOffRequest]:
        return list(self._queue.values())

    # -- asking --------------------------------------------------------------

    async def request(
        self, trade: Trade, reason: TradeExitReason, *, by_operator: bool = False
    ) -> bool:
        """Queue an exit, or fold the reason into one already queued.

        Returns whether the request is now queued. An operator's request is
        different in two ways: it gets past a trade the engine has given up on,
        and it resets the placement budget so a fresh cycle runs -- which is
        the documented recovery when a broker was down and has come back.
        """
        now = self._clock.now()
        if trade.is_terminal:
            logger.info("%s: %s is already finished", self._book.label, trade.instrument)
            return False

        if not by_operator and self._has_given_up(trade):
            # Auto-triggers fire on a timer. Without this they re-queue every
            # few seconds, and the give-up alert fires with them.
            return False

        if by_operator:
            self._given_up.window_closed.discard(trade.id)
            self._given_up.placements_exhausted.discard(trade.id)
            self._book.replace_trade(
                replace(trade, attempts=replace(trade.attempts, exit_placement_attempts=0))
            )
            trade = self._book.trade(trade.id) or trade

        existing = self._queue.get(trade.id)
        if existing is not None:
            chosen = more_urgent(existing.reason, reason)
            if chosen is not existing.reason:
                logger.info(
                    "%s: %s exit reason raised from %s to %s",
                    self._book.label,
                    trade.instrument,
                    existing.reason,
                    chosen,
                )
            existing.reason = chosen
            return True

        self._queue[trade.id] = SquareOffRequest(
            trade_id=trade.id, reason=reason, requested_at=now, next_eligible_at=now
        )
        self._book.replace_trade(trade.exiting(reason))
        logger.info("%s: %s queued to exit on %s", self._book.label, trade.instrument, reason)
        return True

    def _has_given_up(self, trade: Trade) -> bool:
        return (
            trade.id in self._given_up.window_closed
            or trade.id in self._given_up.placements_exhausted
        )

    # -- working -------------------------------------------------------------

    async def run_once(self) -> Sequence[SquareOffResult]:
        """Work every request that is due.

        Nothing is parked: each pass re-reads the trade and decides again, so a
        cancel that failed last time is retried and a position that has since
        gone is simply removed.
        """
        now = self._clock.now()
        results: list[SquareOffResult] = []
        for request in [r for r in self._queue.values() if r.is_due(now)]:
            request.in_progress = True
            try:
                results.append(await self._work(request, now))
            except Exception as error:
                # Never-stuck: anything unexpected must not leave the request
                # marked in progress for ever with nobody exiting the trade.
                logger.exception("%s: square-off failed unexpectedly", self._book.label)
                await self._alerts.critical(
                    EntityType.TRADE,
                    self._book.label,
                    "square-off",
                    f"an exit attempt failed unexpectedly ({type(error).__name__}: {error}). "
                    f"It will be retried.",
                    key=f"squareoff-internal:{request.trade_id}",
                )
                results.append(SquareOffResult(SquareOffOutcome.RETRY, detail=str(error)))
            finally:
                request.in_progress = False
                request.next_eligible_at = now + self._recheck
        return results

    async def _work(self, request: SquareOffRequest, now: datetime) -> SquareOffResult:
        trade = self._book.trade(request.trade_id)
        if trade is None or trade.is_terminal:
            self._queue.pop(request.trade_id, None)
            return SquareOffResult(SquareOffOutcome.DONE, trade, request.reason)

        window = self._window(trade)
        if window is not None and is_retry_window_closed(trade, window, now):
            return await self._give_up_on_time(trade, request)

        if trade.attempts.exit_placement_attempts >= self._max_placements:
            return await self._give_up_on_placements(trade, request)

        if trade.open_quantity <= 0:
            self._queue.pop(request.trade_id, None)
            return SquareOffResult(SquareOffOutcome.DONE, trade, request.reason, "nothing open")

        # The stop has to go before the exit does. Both live, and both filling,
        # turns one position into an opposite one.
        await self._withdraw_the_stop(trade)

        request.attempts += 1
        counted = replace(
            trade,
            attempts=replace(
                trade.attempts,
                square_off_attempts=trade.attempts.square_off_attempts + 1,
                last_attempt_at=now,
            ),
        )
        self._book.replace_trade(counted)

        result = await self._protection.place_target(counted, at_market=True)
        match result.outcome:
            case ProtectionOutcome.PLACED:
                placed = replace(
                    result.trade,
                    attempts=replace(
                        result.trade.attempts,
                        exit_placement_attempts=result.trade.attempts.exit_placement_attempts + 1,
                    ),
                )
                self._book.replace_trade(placed)
                return SquareOffResult(SquareOffOutcome.PLACED, placed, request.reason)
            case ProtectionOutcome.DEFERRED:
                return SquareOffResult(
                    SquareOffOutcome.IN_FLIGHT, result.trade, request.reason, result.detail
                )
            case _:
                return SquareOffResult(
                    SquareOffOutcome.RETRY, result.trade, request.reason, result.detail
                )

    async def _withdraw_the_stop(self, trade: Trade) -> None:
        stop = self._book.order_for(trade.id, OrderRole.STOP)
        if stop is None:
            return
        try:
            await self._cancel(stop)
        except Exception as error:
            # Reported, and the exit still goes. Leaving the position open
            # because its stop would not cancel is the worse of the two.
            await self._alerts.warning(
                EntityType.ORDER,
                self._book.label,
                "square-off",
                f"{trade.instrument}: its stop could not be cancelled before exiting "
                f"({error}). Both orders may be live at the broker.",
                key=f"squareoff-stop-cancel:{trade.id}",
            )

    # -- giving up -----------------------------------------------------------

    async def _give_up_on_time(self, trade: Trade, request: SquareOffRequest) -> SquareOffResult:
        """Past the window nothing can fill, so trying stops."""
        self._queue.pop(request.trade_id, None)
        if trade.id in self._given_up.window_closed:
            return SquareOffResult(SquareOffOutcome.GAVE_UP, trade, request.reason)
        self._given_up.window_closed.add(trade.id)

        benign = self._will_expire_worthless(trade)
        await self._alerts.raise_alert(
            AlertLevel.INFO if benign else AlertLevel.CRITICAL,
            EntityType.TRADE,
            self._book.label,
            "square-off-stopped",
            self._give_up_message(
                trade,
                "the window for squaring it off has closed",
                benign,
                f"after {trade.attempts.square_off_attempts} attempts",
            ),
            key=f"squareoff-window-closed:{trade.id}",
        )
        return SquareOffResult(
            SquareOffOutcome.GAVE_UP, trade, request.reason, "the exit window closed"
        )

    async def _give_up_on_placements(
        self, trade: Trade, request: SquareOffRequest
    ) -> SquareOffResult:
        """Every exit order was refused, and there is none left working."""
        self._queue.pop(request.trade_id, None)
        if trade.id in self._given_up.placements_exhausted:
            return SquareOffResult(SquareOffOutcome.GAVE_UP, trade, request.reason)
        self._given_up.placements_exhausted.add(trade.id)

        benign = self._will_expire_worthless(trade)
        await self._alerts.raise_alert(
            AlertLevel.INFO if benign else AlertLevel.CRITICAL,
            EntityType.TRADE,
            self._book.label,
            "square-off-stopped",
            self._give_up_message(
                trade,
                f"{self._max_placements} exit orders were placed and none was accepted",
                benign,
                "squaring it off from the Console starts a fresh attempt",
            ),
            key=f"squareoff-placements:{trade.id}",
        )
        return SquareOffResult(
            SquareOffOutcome.GAVE_UP, trade, request.reason, "the placement budget is spent"
        )

    def _will_expire_worthless(self, trade: Trade) -> bool:
        instrument = self._instruments(trade.instrument)
        tick = self._last_tick(trade.instrument)
        return is_worthless_option_at_expiry(
            tick.last_price if tick is not None else None,
            is_expiry_day=self._is_expiry_day(trade),
            instrument_kind=instrument.kind if instrument is not None else None,
        )

    @staticmethod
    def _give_up_message(trade: Trade, because: str, benign: bool, otherwise: str) -> str:
        if benign:
            # It cannot be sold because nobody wants it, and in a few hours it
            # is worth nothing either way. Not something to wake anyone for.
            return (
                f"{trade.instrument} was not squared off: {because}. It is a nearly "
                f"worthless option expiring today and will settle on its own; no action "
                f"is needed."
            )
        return (
            f"{trade.instrument} is STILL OPEN and the engine has stopped trying to "
            f"exit it: {because}. Check the position — {otherwise}."
        )
