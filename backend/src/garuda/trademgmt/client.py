"""One trading client's trades and signals.

The book for a single account: what has been signalled, what has been placed,
and every index needed to answer a question about it without scanning. In the
reference engine this is `UserBrokerTradeManager`; the identity change from a
user-and-broker pair to one trading client is what renames it.

**Trades are values, not objects that mutate.** A trade is replaced rather than
edited, which means every index has to be maintained on replacement -- the cost
of the immutability, and worth it: a trade cannot be changed by one caller
while another is reading it, and the state machine cannot be bypassed by
setting a field.

Nothing here schedules anything. It answers questions and holds state; the
loop above it decides when to ask.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.order import BrokerOrderId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_orders import OrderRole
from garuda.domain.trade_signal import TradeSignal
from garuda.trademgmt.dedup import (
    Duplicate,
    DuplicateRule,
    InstrumentLookup,
    find_duplicate,
)
from garuda.trademgmt.legs import (
    HedgeLookup,
    earlier_leg_signal,
    earlier_leg_trade,
    find_combo_legs,
    find_hedge,
    find_pair,
    goes_after_another_leg,
)
from garuda.trademgmt.retention import retain

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class SignalRejected:
    """A signal the account already has. Not an error -- the usual answer."""

    duplicate: Duplicate


class TradingClientManager:
    """Everything one account has signalled, placed, and finished."""

    def __init__(
        self,
        trading_client: TradingClientId,
        label: str,
        instruments: InstrumentLookup,
        alerts: AlertManager,
    ) -> None:
        self._trading_client = trading_client
        #: How this account reads to a person. Every alert uses it.
        self._label = label
        self._instruments = instruments
        self._alerts = alerts

        self._trades: dict[TradeId, Trade] = {}
        self._signals: dict[str, TradeSignal] = {}

        # Indexes. Each answers a question the trade loop asks every cycle, and
        # each is maintained on every mutation rather than rebuilt.
        self._by_strategy: dict[str, set[TradeId]] = {}
        self._by_strategy_group: dict[tuple[str, str], set[TradeId]] = {}
        self._by_instrument: dict[InstrumentId, set[TradeId]] = {}
        self._by_signal: dict[str, set[TradeId]] = {}
        self._by_broker_order: dict[BrokerOrderId, TradeId] = {}
        self._orders_by_trade: dict[TradeId, dict[OrderRole, BrokerOrderId]] = {}
        self._superseded: dict[TradeId, list[BrokerOrderId]] = {}
        self._signals_by_strategy: dict[str, set[str]] = {}
        #: Trades that never became positions, kept separately: the live
        #: listings are what the loop walks, and a failed entry is not live.
        self._failed: set[TradeId] = set()

    @property
    def trading_client(self) -> TradingClientId:
        return self._trading_client

    @property
    def label(self) -> str:
        return self._label

    def __str__(self) -> str:
        return self._label

    # -- loading ------------------------------------------------------------

    def restore(
        self, trades: Iterable[Trade], signals: Iterable[TradeSignal], today: date
    ) -> tuple[int, int]:
        """Load a persisted set, keeping only what belongs in today's book.

        Returns how many of each were kept. What is dropped is history the
        database owns; keeping it makes duplicate detection reject fresh
        signals and makes the tranche gate believe slots are taken.
        """
        if self._trades or self._signals:
            raise RuntimeError(f"{self._label}: the book is not empty; restore runs once")

        kept_trades, kept_signals = retain(trades, signals, today)
        for signal in kept_signals:
            self._signals[signal.id] = signal
            self._index_signal(signal)
        for trade in kept_trades:
            self._trades[trade.id] = trade
            self._index_trade(trade)

        logger.info(
            "%s: restored %d trades and %d signals for %s",
            self._label,
            len(kept_trades),
            len(kept_signals),
            today,
        )
        return len(kept_trades), len(kept_signals)

    # -- signals ------------------------------------------------------------

    async def add_signal(self, signal: TradeSignal) -> SignalRejected | None:
        """Take a signal, unless the account already has it.

        Returns the rejection rather than raising: a duplicate is the ordinary
        answer to a strategy that re-emits, not a fault.
        """
        if signal.trading_client != self._trading_client:
            raise ValueError(
                f"{self._label}: signal {signal.id} belongs to {signal.trading_client}"
            )
        if signal.id in self._signals:
            return SignalRejected(
                Duplicate(
                    rule=DuplicateRule.IDENTICAL_SIGNAL,
                    existing_signal_id=signal.id,
                    detail="a signal with this id was already accepted",
                )
            )

        duplicate = find_duplicate(
            signal, list(self._signals.values()), list(self._trades.values()), self._instruments
        )
        if duplicate is not None:
            logger.info(
                "%s: refused signal %s for %s — %s",
                self._label,
                signal.id,
                signal.instrument,
                duplicate.detail,
            )
            return SignalRejected(duplicate)

        self._signals[signal.id] = signal
        self._index_signal(signal)
        return None

    def signal(self, signal_id: str) -> TradeSignal | None:
        return self._signals.get(signal_id)

    def signals(self, strategy: str | None = None) -> Sequence[TradeSignal]:
        if strategy is None:
            return list(self._signals.values())
        return [self._signals[i] for i in self._signals_by_strategy.get(strategy, set())]

    def actionable_signals(self) -> Sequence[TradeSignal]:
        """Signals still waiting for a price. The loop's working set."""
        return [
            signal
            for signal in self._signals.values()
            if not signal.is_triggered and not signal.disabled
        ]

    def replace_signal(self, signal: TradeSignal) -> None:
        """Put back a signal that has been advanced -- triggered, disabled."""
        if signal.id not in self._signals:
            raise KeyError(f"{self._label}: no signal {signal.id}")
        self._unindex_signal(self._signals[signal.id])
        self._signals[signal.id] = signal
        self._index_signal(signal)

    async def disable_signal(self, signal_id: str, reason: str) -> TradeSignal | None:
        """Stop a signal from ever placing, and say why."""
        signal = self._signals.get(signal_id)
        if signal is None or signal.disabled:
            return signal
        disabled = signal.disable(reason)
        self.replace_signal(disabled)
        logger.info("%s: signal %s disabled — %s", self._label, signal_id, reason)
        return disabled

    # -- trades -------------------------------------------------------------

    def add_trade(self, trade: Trade) -> None:
        if trade.id in self._trades:
            raise ValueError(f"{self._label}: trade {trade.id} is already in the book")
        self._trades[trade.id] = trade
        self._index_trade(trade)

    def replace_trade(self, trade: Trade) -> None:
        """Put back a trade that has advanced, keeping every index true."""
        existing = self._trades.get(trade.id)
        if existing is None:
            raise KeyError(f"{self._label}: no trade {trade.id}")
        self._unindex_trade(existing)
        self._trades[trade.id] = trade
        self._index_trade(trade)

    def link_order(
        self,
        broker_order_id: BrokerOrderId,
        trade_id: TradeId,
        role: OrderRole = OrderRole.ENTRY,
    ) -> None:
        """Remember which trade an order belongs to, and what it is for.

        The push stream and the poll both arrive knowing only a broker order
        id, and both need the trade behind it. The role is what lets the
        tracker tell "the entry filled" from "the stop fired" -- the same
        status on different orders means opposite things.

        A new order in a role replaces the old one in that role: a trailing
        stop is a fresh order each time it moves, and only the current one is
        the position's protection.
        """
        self._by_broker_order[broker_order_id] = trade_id
        orders = self._orders_by_trade.setdefault(trade_id, {})
        previous = orders.get(role)
        if previous is not None and previous != broker_order_id:
            self._superseded.setdefault(trade_id, []).append(previous)
        orders[role] = broker_order_id

    def role_of(self, broker_order_id: BrokerOrderId) -> OrderRole | None:
        trade_id = self._by_broker_order.get(broker_order_id)
        if trade_id is None:
            return None
        for role, order_id in self._orders_by_trade.get(trade_id, {}).items():
            if order_id == broker_order_id:
                return role
        # Known to belong to a trade but no longer current in any role: a
        # superseded stop, whose fill still matters.
        return OrderRole.SUPERSEDED

    def order_for(self, trade_id: TradeId, role: OrderRole) -> BrokerOrderId | None:
        return self._orders_by_trade.get(trade_id, {}).get(role)

    def orders_of(self, trade_id: TradeId) -> Mapping[OrderRole, BrokerOrderId]:
        return dict(self._orders_by_trade.get(trade_id, {}))

    def superseded_orders(self, trade_id: TradeId) -> Sequence[BrokerOrderId]:
        """Orders replaced in their role -- previous stops, mostly.

        Kept because they may still be live at the broker until the cancel
        confirms, and a fill on one is a real exit.
        """
        return list(self._superseded.get(trade_id, ()))

    def trade_for_order(self, broker_order_id: BrokerOrderId) -> Trade | None:
        trade_id = self._by_broker_order.get(broker_order_id)
        return self._trades.get(trade_id) if trade_id is not None else None

    def trade(self, trade_id: TradeId) -> Trade | None:
        return self._trades.get(trade_id)

    def trades(self) -> Sequence[Trade]:
        return list(self._trades.values())

    def live_trades(self) -> Sequence[Trade]:
        """Placed and not finished. What the loop advances every cycle."""
        return [trade for trade in self._trades.values() if trade.is_live]

    def active_trades(self) -> Sequence[Trade]:
        """Filled and holding a position. Where money is actually at risk."""
        return [trade for trade in self._trades.values() if trade.is_active]

    def trades_for(self, strategy: str, group: str | None = None) -> Sequence[Trade]:
        ids = (
            self._by_strategy.get(strategy, set())
            if group is None
            else self._by_strategy_group.get((strategy, group), set())
        )
        return [self._trades[i] for i in ids]

    def trades_for_signal(self, signal_id: str) -> Sequence[Trade]:
        return [self._trades[i] for i in self._by_signal.get(signal_id, set())]

    def trades_in(self, instrument: InstrumentId) -> Sequence[Trade]:
        return [self._trades[i] for i in self._by_instrument.get(instrument, set())]

    def failed_trades(self) -> Sequence[Trade]:
        return [self._trades[i] for i in self._failed]

    def instruments_traded(self, strategy: str) -> Sequence[InstrumentId]:
        """What a strategy has positions in. Used to cap breadth."""
        return sorted(
            {trade.instrument for trade in self.trades_for(strategy)},
            key=lambda instrument: instrument.value,
        )

    def open_quantity(self, instrument: InstrumentId) -> int:
        """Units the account holds in an instrument, netted across directions."""
        return sum(
            trade.open_quantity * trade.direction.sign
            for trade in self.trades_in(instrument)
            if trade.is_live
        )

    # -- relationships ------------------------------------------------------

    async def hedge_for(self, leg: Trade | TradeSignal) -> Trade | None:
        """The hedge protecting a leg, or the leg a hedge protects.

        Ambiguity and degradation are alerted rather than swallowed: more than
        one live hedge is expected for seconds during a roll and a problem if
        it lasts, and no live hedge at all means the answer is a handle to
        something finished.
        """
        lookup: HedgeLookup = find_hedge(leg, self._trades.values())
        correlation = leg.relationships.hedge_correlation_id
        if lookup.ambiguous:
            await self._alerts.warning(
                EntityType.TRADE,
                self._label,
                "hedge-lookup",
                f"{len(lookup.ambiguous)} live hedges share one correlation; using the most "
                f"recent. Expected briefly while a hedge is rolled.",
                key=f"hedge-ambiguous:{self._trading_client}:{correlation}",
            )
        elif lookup.degraded:
            await self._alerts.warning(
                EntityType.TRADE,
                self._label,
                "hedge-lookup",
                "no live hedge for this leg; every match is finished or being replaced",
                key=f"hedge-not-live:{self._trading_client}:{correlation}",
            )
        return lookup.trade

    def pair_for(self, trade: Trade) -> Trade | None:
        return find_pair(trade, self._trades.values())

    def combo_legs_for(self, trade: Trade) -> Sequence[Trade]:
        return find_combo_legs(trade, self._trades.values())

    def waits_for_another_leg(self, signal: TradeSignal) -> bool:
        return goes_after_another_leg(signal, list(self._signals.values()))

    def leg_ahead_of(self, signal: TradeSignal) -> TradeSignal | None:
        return earlier_leg_signal(signal, list(self._signals.values()))

    def trade_ahead_of(self, signal: TradeSignal) -> Trade | None:
        return earlier_leg_trade(signal, list(self._signals.values()), self._trades.values())

    # -- indexes ------------------------------------------------------------

    def _index_trade(self, trade: Trade) -> None:
        self._by_strategy.setdefault(trade.strategy, set()).add(trade.id)
        self._by_strategy_group.setdefault((trade.strategy, trade.group), set()).add(trade.id)
        self._by_instrument.setdefault(trade.instrument, set()).add(trade.id)
        if trade.signal_id is not None:
            self._by_signal.setdefault(trade.signal_id, set()).add(trade.id)
        if trade.failure_reason is not None or (trade.is_terminal and trade.filled_quantity == 0):
            self._failed.add(trade.id)

    def _unindex_trade(self, trade: Trade) -> None:
        _discard(self._by_strategy, trade.strategy, trade.id)
        _discard(self._by_strategy_group, (trade.strategy, trade.group), trade.id)
        _discard(self._by_instrument, trade.instrument, trade.id)
        if trade.signal_id is not None:
            _discard(self._by_signal, trade.signal_id, trade.id)
        self._failed.discard(trade.id)

    def _index_signal(self, signal: TradeSignal) -> None:
        self._signals_by_strategy.setdefault(signal.strategy, set()).add(signal.id)

    def _unindex_signal(self, signal: TradeSignal) -> None:
        _discard(self._signals_by_strategy, signal.strategy, signal.id)


def _discard[K, V](index: dict[K, set[V]], key: K, value: V) -> None:
    """Remove a member, and the key once it is empty.

    Left in place, an emptied key accumulates for every strategy and group an
    account has ever traded, and a process that runs for weeks pays for it.
    """
    members = index.get(key)
    if members is None:
        return
    members.discard(value)
    if not members:
        del index[key]
