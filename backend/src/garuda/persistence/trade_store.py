"""Making a trade survive a restart.

Everything trade management knows lives in memory while the engine runs. If
that is all, a restart is a position the engine no longer knows it holds -- no
stop, no target, no square-off, and nobody watching it. So a trade is written
whenever it changes, and read back at the start of the day.

**Written on change, not on a timer.** The reference engine batched writes and
swept every thirty seconds; that is machinery for thousands of accounts, and
for a handful the write is cheap enough to do when the change happens. What is
in the database is then never more than one statement behind what is in memory.

**A payload beside indexed columns.** The columns are what a query filters on;
the payload is the trade. Adding a field to a trade needs no migration, and
reading a payload written by a newer version does not need one either.

**Storage failing must not stop trading.** A position that cannot be persisted
is still a position, and refusing to place its stop because a write failed
turns a database problem into a money problem. Failures are alerted and the
engine carries on -- the operator is told the durability guarantee is gone,
which is the honest report.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import datetime

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.trade import Trade
from garuda.domain.trade_serde import decode_signal, decode_trade
from garuda.domain.trade_signal import TradeSignal
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


class TradeStore:
    """Reads and writes one account's live trades and signals."""

    def __init__(
        self,
        session_factory: object,
        alerts: AlertManager,
        *,
        label: str = "",
    ) -> None:
        self._sessions = session_factory
        self._alerts = alerts
        self._label = label

    # -- writing -------------------------------------------------------------

    async def save_trade(self, trade: Trade, now: datetime) -> bool:
        """Persist a trade. Returns whether it landed.

        Never raises. The caller has a live position either way, and the
        decision to keep trading with an unreliable store is not one to take
        by throwing out of an order path.
        """
        return await self._write(
            "trade",
            trade.id.value,
            lambda uow: uow.repositories.live_trades.upsert_trade(trade, now),
        )

    async def save_signal(self, signal: TradeSignal, now: datetime) -> bool:
        return await self._write(
            "signal",
            signal.id,
            lambda uow: uow.repositories.live_trade_signals.upsert_signal(signal, now),
        )

    async def _write(self, kind: str, identity: str, work: object) -> bool:
        try:
            async with UnitOfWork(self._sessions) as uow:  # type: ignore[arg-type]
                await work(uow)  # type: ignore[operator]
            return True
        except Exception as error:
            logger.exception("%s: could not persist %s %s", self._label, kind, identity)
            await self._alerts.critical(
                EntityType.SYSTEM,
                self._label or "engine",
                "storage",
                f"a {kind} could not be saved ({error}). Trading continues, but a restart "
                f"will not recover what has not been written.",
                key=f"trade-store-write:{kind}",
            )
            return False

    # -- reading -------------------------------------------------------------

    async def load(
        self, trading_client: TradingClientId
    ) -> tuple[Sequence[Trade], Sequence[TradeSignal]]:
        """Everything still live for an account.

        A row that cannot be decoded is skipped and reported rather than
        failing the load: one unreadable trade must not cost the engine sight
        of every other position it holds.
        """
        async with UnitOfWork(self._sessions) as uow:  # type: ignore[arg-type]
            trade_rows = await uow.repositories.live_trades.for_client(trading_client.value)
            signal_rows = await uow.repositories.live_trade_signals.for_client(trading_client.value)

        trades: list[Trade] = []
        for row in trade_rows:
            decoded_trade = await self._decode(row.payload, decode_trade, "trade")
            if decoded_trade is not None:
                trades.append(decoded_trade)

        signals: list[TradeSignal] = []
        for signal_row in signal_rows:
            decoded_signal = await self._decode(signal_row.payload, decode_signal, "signal")
            if decoded_signal is not None:
                signals.append(decoded_signal)
        logger.info("%s: loaded %d trades and %d signals", self._label, len(trades), len(signals))
        return trades, signals

    async def _decode[T](self, payload: str, decode: Callable[[str], T], kind: str) -> T | None:
        try:
            return decode(payload)
        except Exception as error:
            await self._alerts.critical(
                EntityType.SYSTEM,
                self._label or "engine",
                "storage",
                f"a stored {kind} could not be read back ({error}) and has been skipped. "
                f"If it is a live position, nothing is managing it.",
                key=f"trade-store-unreadable:{kind}",
            )
            return None

    # -- the day boundary ----------------------------------------------------

    async def archive_finished(self, trading_client: TradingClientId, before: datetime) -> int:
        """Move what is done out of the live tables.

        The live tables are read whole at every start, so leaving finished
        trades in them makes each start slower than the last. What is archived
        is still queryable; it is simply no longer in the way.
        """
        async with UnitOfWork(self._sessions) as uow:  # type: ignore[arg-type]
            moved = await uow.repositories.live_trades.archive_finished(
                trading_client.value, before
            )
        logger.info("%s: archived %d finished trades", self._label, moved)
        return moved
