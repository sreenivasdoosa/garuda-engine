"""Keeping the book on disk.

Trade management works in memory, at tick speed. A restart must not lose the
positions it was holding, so the book is written out behind it.

Two rules shape this:

* **Write what changed, not everything.** A cycle runs every second; saving
  forty untouched trades each time would be forty writes a second to say
  nothing. Each trade is encoded and compared with what was last stored.
* **Never let a save stop trading.** ``TradeStore`` already refuses to raise;
  this keeps the same promise for the sweep around it.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import timedelta

from garuda.domain.trade import Trade
from garuda.domain.trade_serde import encode_signal, encode_trade
from garuda.domain.trade_signal import TradeSignal
from garuda.persistence.trade_store import TradeStore
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager

logger = logging.getLogger(__name__)

#: How often the book is swept for changes. Fast enough that a crash loses at
#: most a second of state, slow enough that it is not a write per tick.
DEFAULT_FLUSH_INTERVAL = timedelta(seconds=1)

#: How long a finished trade stays in the live table before being archived.
ARCHIVE_AFTER = timedelta(days=1)


@dataclass
class TradePersistence:
    """One account's book, mirrored into the database."""

    book: TradingClientManager
    store: TradeStore
    clock: Clock
    interval: timedelta = DEFAULT_FLUSH_INTERVAL

    _saved_trades: dict[str, str] = field(default_factory=dict)
    _saved_signals: dict[str, str] = field(default_factory=dict)
    _stopping: bool = False

    async def restore(self) -> tuple[int, int]:
        """Read the account's book back in.

        Called at day-init, before anything places an order: entering a trade
        the engine already holds is the failure this exists to prevent.
        """
        trades, signals = await self.store.load(self.book.trading_client)
        today = self.clock.now().date()
        restored = self.book.restore(trades, signals, today)
        self._remember(trades, signals)
        return restored

    async def flush(self) -> int:
        """Write out whatever has changed since the last sweep."""
        now = self.clock.now()
        written = 0
        for trade in self.book.trades():
            payload = _fingerprint_trade(trade)
            if self._saved_trades.get(trade.id.value) == payload:
                continue
            await self.store.save_trade(trade, now)
            self._saved_trades[trade.id.value] = payload
            written += 1
        for signal in self.book.signals():
            payload = _fingerprint_signal(signal)
            if self._saved_signals.get(signal.id) == payload:
                continue
            await self.store.save_signal(signal, now)
            self._saved_signals[signal.id] = payload
            written += 1
        return written

    async def run_forever(self) -> None:
        """Sweep until stopped. Never raises: a failed sweep is retried."""
        self._stopping = False
        while not self._stopping:
            try:
                await self.flush()
            except Exception:
                # TradeStore reports its own failures; this catches anything
                # the sweep itself got wrong. Trading continues either way.
                logger.exception("%s: the persistence sweep failed", self.book.label)
            await self.clock.sleep(self.interval)

    def stop(self) -> None:
        self._stopping = True

    async def archive(self) -> int:
        """Move finished trades out of the live table. Run after the close."""
        return await self.store.archive_finished(
            self.book.trading_client, self.clock.now() - ARCHIVE_AFTER
        )

    def _remember(self, trades: Sequence[Trade], signals: Sequence[TradeSignal]) -> None:
        """Record what was just read as already saved.

        Without this the first sweep after a restart rewrites the entire book
        to say exactly what it already says.
        """
        self._saved_trades = {t.id.value: _fingerprint_trade(t) for t in trades}
        self._saved_signals = {s.id: _fingerprint_signal(s) for s in signals}


def _fingerprint_trade(trade: Trade) -> str:
    return repr(encode_trade(trade))


def _fingerprint_signal(signal: TradeSignal) -> str:
    return repr(encode_signal(signal))
