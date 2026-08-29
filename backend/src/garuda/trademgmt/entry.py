"""Turning a signal into a position.

The riskiest path in the engine, because its failure mode is not a missing
trade but a duplicate one: an entry order that reached the broker while the
engine believed it had not. Everything here is arranged around never letting
that happen.

**A placement error does not mean nothing was placed.** A timeout, a dropped
connection, a gateway error -- the order may well be resting at the exchange.
So a failure never immediately retries with a fresh order. It records what it
tried, and the next attempt first *looks* for the previous one by the tag it
carried. Only when the broker says there is no such order is a new one sent.

**A definitive rejection is different.** An order the broker refused outright,
before it ever reached the exchange, is known not to exist. That is the one
case where the engine can act on the failure immediately.

The reference engine also had a duplicate-fire guard for the case where a
restart lost the flag saying a signal had already fired. Ours keeps it: before
placing, look for a live trade already carrying this signal's id.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime, timedelta
from enum import StrEnum
from uuid import uuid4

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_signal import TradeSignal
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.broker import OrderRejectedError
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.entry_rules import (
    entry_order_shape,
    should_place_trade,
    side_for,
)

logger = logging.getLogger(__name__)

#: How many times one signal may attempt an entry before it is given up on.
#: The reference engine's number. Two is enough to survive a transient
#: failure and few enough that a systematically bad order is not repeated.
MAX_ENTRY_ATTEMPTS = 2

#: How long a placement whose outcome is unknown is left alone. Sending
#: another order inside this window is how one intent becomes two positions.
UNRESOLVED_PLACEMENT_WINDOW = timedelta(seconds=15)

#: How long to wait after a failed attempt before trying again, so a retry
#: does not fire on the very next tick.
RETRY_BACKOFF = timedelta(seconds=30)

#: Places an order and returns the broker's id for it.
type PlaceOrder = Callable[[OrderRequest], Awaitable[BrokerOrderId]]

#: Looks for an order the engine may already have placed, by its tag.
#: Returns the broker id if it exists, None if the broker says it does not,
#: and raises if the answer is not knowable right now.
type FindPlacedOrder = Callable[[ClientOrderId], Awaitable[BrokerOrderId | None]]

type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type SubscriptionCheck = Callable[[TradingClientId, str], bool]


class EntryOutcome(StrEnum):
    PLACED = "PLACED"
    #: The previous attempt's order was found at the broker; no new one sent.
    RECOVERED = "RECOVERED"
    #: Not placed now, and worth trying again.
    DEFERRED = "DEFERRED"
    #: Not placed, and not going to be.
    REFUSED = "REFUSED"
    #: Attempts exhausted. The signal is disabled and the trade is cancelled.
    FAILED = "FAILED"


@dataclass(frozen=True, slots=True)
class EntryResult:
    outcome: EntryOutcome
    signal: TradeSignal
    trade: Trade | None = None
    detail: str | None = None

    @property
    def entered(self) -> bool:
        return self.outcome in (EntryOutcome.PLACED, EntryOutcome.RECOVERED)


@dataclass(frozen=True, slots=True)
class _Attempt:
    """What an in-flight placement looked like, for the recovery path."""

    client_order_id: ClientOrderId
    at: datetime


class EntryService:
    """Places the entry for a signal, once."""

    def __init__(
        self,
        book: TradingClientManager,
        place_order: PlaceOrder,
        find_placed_order: FindPlacedOrder,
        instruments: InstrumentLookup,
        clock: Clock,
        alerts: AlertManager,
        *,
        is_subscribed: SubscriptionCheck | None = None,
        max_attempts: int = MAX_ENTRY_ATTEMPTS,
    ) -> None:
        self._book = book
        self._place = place_order
        self._find = find_placed_order
        self._instruments = instruments
        self._clock = clock
        self._alerts = alerts
        self._is_subscribed = is_subscribed or _always_subscribed
        self._max_attempts = max_attempts
        #: The last placement attempted per signal, so a retry can look for it.
        self._attempts: dict[str, _Attempt] = {}

    # -- driven by a tick ---------------------------------------------------

    async def on_tick(self, tick: Tick) -> Sequence[EntryResult]:
        """Consider every signal watching this instrument.

        Long is considered first and short only if long produced nothing, so a
        pair of opposing signals on one symbol cannot both fire on one tick.
        """
        watching = [
            signal
            for signal in self._book.actionable_signals()
            if signal.watched_instrument == tick.instrument
        ]
        longs = [s for s in watching if s.direction is Direction.LONG]
        shorts = [s for s in watching if s.direction is Direction.SHORT]

        results: list[EntryResult] = []
        for signal in longs:
            results.append(await self.consider(signal, tick))
        if not any(result.entered for result in results):
            for signal in shorts:
                results.append(await self.consider(signal, tick))
        return results

    async def consider(self, signal: TradeSignal, tick: Tick | None = None) -> EntryResult:
        """Place this signal's entry, if everything says to."""
        now = self._clock.now()

        expiry = await self._disable_if_spent(signal, now)
        if expiry is not None:
            return expiry

        gate = should_place_trade(
            signal,
            now,
            is_subscribed=self._is_subscribed(signal.trading_client, signal.strategy),
            entries_so_far=self._entries_so_far(signal),
        )
        if not gate.should_place:
            return EntryResult(
                EntryOutcome.REFUSED, signal, detail=gate.detail or str(gate.refusal)
            )

        waiting = await self._waiting_on_another_leg(signal)
        if waiting is not None:
            return waiting

        already = self._live_trade_for(signal)
        if already is not None:
            # A restart that lost the triggered flag would otherwise place a
            # second position for one decision.
            logger.warning(
                "%s: signal %s already has live trade %s; marking it triggered rather "
                "than placing again",
                self._book.label,
                signal.id,
                already.id,
            )
            self._book.replace_signal(signal.triggered())
            return EntryResult(
                EntryOutcome.RECOVERED, signal, already, "a live trade already exists"
            )

        return await self._place_entry(signal, tick, now)

    # -- placement ----------------------------------------------------------

    async def _place_entry(
        self, signal: TradeSignal, tick: Tick | None, now: datetime
    ) -> EntryResult:
        instrument = self._instruments(signal.instrument)
        if instrument is None:
            return await self._fail(
                signal, f"{signal.instrument} is not in today's instrument master", now
            )

        attempt = self._attempts.get(signal.id)
        if attempt is not None:
            recovered = await self._recover(signal, attempt, now)
            if recovered is not None:
                return recovered

        if signal.execution_attempts >= self._max_attempts:
            return await self._fail(
                signal,
                signal.last_error or f"{signal.execution_attempts} attempts, none succeeded",
                now,
            )

        client_order_id = _new_client_order_id()
        shape = entry_order_shape(signal, instrument, tick)
        request = OrderRequest(
            client_order_id=client_order_id,
            trading_client=signal.trading_client,
            instrument=signal.instrument,
            side=side_for(signal.direction),
            quantity=signal.quantity,
            order_type=shape.order_type,
            product=signal.product,
            price=shape.price,
            trigger_price=shape.trigger_price,
            tag=signal.strategy,
        )

        # Recorded *before* sending. A crash between here and the broker
        # leaves a record the next attempt can look the order up by.
        self._attempts[signal.id] = _Attempt(client_order_id, now)

        try:
            broker_order_id = await self._place(request)
        except OrderRejectedError as error:
            # Definitive: refused before it reached the exchange, so no order
            # exists and the next attempt may safely send a fresh one.
            del self._attempts[signal.id]
            self._book.replace_signal(signal.attempted(str(error)))
            return await self._maybe_give_up(signal, str(error), now)
        except Exception as error:
            # Not definitive. The order may be resting at the exchange, so the
            # attempt record stays and the next pass looks for it.
            self._book.replace_signal(signal.attempted(f"{type(error).__name__}: {error}"))
            await self._alerts.critical(
                EntityType.ORDER,
                self._book.label,
                "entry",
                f"{signal.instrument} entry failed and may still have reached the broker: "
                f"{error}. Check positions before acting.",
                key=f"entry-uncertain:{signal.id}",
            )
            return EntryResult(
                EntryOutcome.DEFERRED, signal, detail=f"placement outcome unknown: {error}"
            )

        trade = _trade_from(signal, now)
        self._book.add_trade(trade)
        self._book.link_order(broker_order_id, trade.id)
        self._book.replace_signal(signal.triggered())
        del self._attempts[signal.id]

        logger.info(
            "%s: entered %s %s x%d for %s as order %s",
            self._book.label,
            signal.direction,
            signal.instrument,
            signal.quantity,
            signal.strategy,
            broker_order_id,
        )
        return EntryResult(EntryOutcome.PLACED, signal, trade)

    async def _recover(
        self, signal: TradeSignal, attempt: _Attempt, now: datetime
    ) -> EntryResult | None:
        """Look for an order a previous attempt may have placed.

        Returns a result when the question is settled one way or the other, and
        None when the previous attempt is known not to have landed and a fresh
        order may go.
        """
        try:
            found = await self._find(attempt.client_order_id)
        except Exception as error:
            # The broker cannot tell us right now. Placing anything would be a
            # guess, so wait -- an unknown order is a reason to do nothing.
            logger.info(
                "%s: cannot yet tell whether %s reached the broker: %s",
                self._book.label,
                attempt.client_order_id,
                error,
            )
            return EntryResult(
                EntryOutcome.DEFERRED, signal, detail="the previous order's fate is unknown"
            )

        if found is not None:
            trade = _trade_from(signal, now)
            self._book.add_trade(trade)
            self._book.link_order(found, trade.id)
            self._book.replace_signal(signal.triggered())
            del self._attempts[signal.id]
            await self._alerts.warning(
                EntityType.ORDER,
                self._book.label,
                "entry",
                f"{signal.instrument} was already placed by an earlier attempt and has been "
                f"adopted rather than sent again",
                key=f"entry-recovered:{signal.id}",
            )
            return EntryResult(EntryOutcome.RECOVERED, signal, trade)

        if now - attempt.at < UNRESOLVED_PLACEMENT_WINDOW:
            # The broker says no order, but it said so very soon after we sent
            # one. Give it a moment rather than racing our own request.
            return EntryResult(
                EntryOutcome.DEFERRED, signal, detail="the previous request is still settling"
            )

        del self._attempts[signal.id]
        return None

    # -- giving up ----------------------------------------------------------

    async def _maybe_give_up(self, signal: TradeSignal, reason: str, now: datetime) -> EntryResult:
        """Give up once the attempts are spent; otherwise leave it for later."""
        current = self._book.signal(signal.id) or signal
        if current.execution_attempts >= self._max_attempts:
            return await self._fail(current, reason, now)
        return EntryResult(EntryOutcome.DEFERRED, current, detail=reason)

    async def _fail(self, signal: TradeSignal, reason: str, now: datetime) -> EntryResult:
        """Stop trying, and leave a record of why.

        The signal is disabled, a cancelled trade is recorded so the failure is
        visible where the operator looks for trades rather than only in the
        alert list, and any hedge that was waiting on this leg is marked --
        durably, so the orphan is squared off even after a restart.
        """
        await self._book.disable_signal(signal.id, reason)
        trade = _trade_from(signal, now).cancelled(
            TradeExitReason.ENTRY_FAILED, now, failure_reason=reason
        )
        self._book.add_trade(trade)
        self._attempts.pop(signal.id, None)

        await self._flag_orphaned_hedge(signal, reason)
        await self._alerts.critical(
            EntityType.ORDER,
            self._book.label,
            "entry",
            f"{signal.instrument} for {signal.strategy} could not be entered: {reason}",
            key=f"entry-failed:{signal.id}",
        )
        return EntryResult(EntryOutcome.FAILED, signal, trade, reason)

    async def _flag_orphaned_hedge(self, signal: TradeSignal, reason: str) -> None:
        """A hedge whose main leg never arrived protects nothing.

        Marked on the hedge itself rather than inferred later, because the
        failed main leg may be gone by the time anyone asks -- and a bought
        option left alone simply decays.
        """
        hedge = await self._book.hedge_for(signal)
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
            f"{hedge.instrument} is now an orphaned hedge: its main leg failed to enter "
            f"({reason}). It will be squared off.",
            key=f"hedge-orphaned:{hedge.id}",
        )

    # -- the reasons to stand down ------------------------------------------

    async def _disable_if_spent(self, signal: TradeSignal, now: datetime) -> EntryResult | None:
        """Retire a signal whose moment has passed.

        Disabled rather than merely skipped, so it stops being considered on
        every tick for the rest of the day.
        """
        if signal.has_expired(now) and not signal.disabled:
            await self._book.disable_signal(signal.id, "the signal's validity expired")
            return EntryResult(EntryOutcome.REFUSED, signal, detail="validity expired")
        return None

    async def _waiting_on_another_leg(self, signal: TradeSignal) -> EntryResult | None:
        """Hold a leg whose predecessor has not filled.

        And if that predecessor has been abandoned, abandon this one too: a
        sold leg whose protective buy is never coming must never be placed.
        """
        if not self._book.waits_for_another_leg(signal):
            return None

        earlier_signal = self._book.leg_ahead_of(signal)
        if earlier_signal is not None and earlier_signal.disabled:
            await self._book.disable_signal(
                signal.id, "the leg it follows was abandoned, so this one is too"
            )
            return EntryResult(
                EntryOutcome.REFUSED, signal, detail="the leg ahead of it was abandoned"
            )

        earlier_trade = self._book.trade_ahead_of(signal)
        if earlier_trade is not None and earlier_trade.filled_quantity >= earlier_trade.quantity:
            return None
        return EntryResult(
            EntryOutcome.DEFERRED, signal, detail="waiting for the leg ahead of it to fill"
        )

    def _entries_so_far(self, signal: TradeSignal) -> int:
        """How often this strategy has entered this instrument, both ways.

        Counted across directions because the cap is on re-entering a name;
        reversing after a stop is still another entry.
        """
        return sum(
            1
            for trade in self._book.trades_in(signal.instrument)
            if trade.strategy == signal.strategy and trade.group == signal.group
        )

    def _live_trade_for(self, signal: TradeSignal) -> Trade | None:
        for trade in self._book.trades_for_signal(signal.id):
            if trade.is_live:
                return trade
        return None


def _trade_from(signal: TradeSignal, now: datetime) -> Trade:
    """A trade in the image of the signal that asked for it."""
    return Trade(
        id=TradeId(uuid4().hex),
        trading_client=signal.trading_client,
        instrument=signal.instrument,
        strategy=signal.strategy,
        direction=signal.direction,
        product=signal.product,
        quantity=signal.quantity,
        quantity_per_lot=signal.quantity_per_lot,
        contract_multiplier=signal.contract_multiplier,
        started_at=now,
        protection=signal.protection,
        relationships=signal.relationships,
        signal_id=signal.id,
        group=signal.group,
        tranche=signal.tranche,
        slice=signal.slice,
        re_entry_count=signal.re_entry.entries_so_far,
        is_paper=signal.is_paper,
        no_square_off=signal.no_square_off,
        square_off_at=signal.square_off_at,
    )


def _always_subscribed(_client: TradingClientId, _strategy: str) -> bool:
    """The default when nothing supplies subscriptions -- used by tests and by
    the window before the subscription store is wired."""
    return True


def _new_client_order_id() -> ClientOrderId:
    """Short enough for every broker's tag field, unique enough to match on.

    Kite's tag is twenty characters and truncates silently, so the id has to
    fit rather than be trimmed to fit -- a shortened tag matches nothing on the
    way back.
    """
    return ClientOrderId(f"g{uuid4().hex[:15]}")
