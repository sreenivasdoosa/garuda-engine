"""Recording what the risk gate refused.

Every refusal is already logged and alerted. Neither survives the day: a log
line scrolls away and an alert is deduplicated by key, so an operator asking
"how often did volume stop us this week, and how short was it" has nothing to
read. The table answers that, which is what it was ported for.

**A failed write never changes the outcome.** The order was already refused
and nothing left the engine; the record is an account of it, not part of it.
So this never raises, and a store that is down costs the audit trail rather
than the refusal.

**One row per breach, not per refusal.** A gate reports everything that
failed, and "the spread was wide *and* the volume was thin" is two facts. One
row holding both could not be counted by type, which is the question the table
exists to answer.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from garuda.persistence.models import RmsBreachLogRow
from garuda.persistence.uow import UnitOfWork

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.domain.client import TradingClientId
    from garuda.domain.instrument import Instrument
    from garuda.rms.gate import Breach

logger = logging.getLogger(__name__)

#: What the engine did about it. One value today, because the gate has one
#: answer: nothing goes to the broker. The column is wider than that because
#: the reference also squares off on some breaches, which garuda does not.
ORDER_REJECTED = "ORDER_REJECTED"


class BreachStore:
    """Writes refusals to the breach log, and never gets in their way."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession], *, label: str = "") -> None:
        self._sessions = sessions
        self._label = label

    async def record(
        self,
        breaches: Sequence[Breach],
        *,
        trading_client: TradingClientId,
        instrument: Instrument,
        strategy: str | None,
        at: datetime,
    ) -> int:
        """Write one row per breach. Returns how many landed."""
        if not breaches:
            return 0
        rows = [
            RmsBreachLogRow(
                trading_client_id=trading_client.value,
                breach_time=at,
                strategy_name=strategy,
                trading_symbol=instrument.trading_symbol,
                exchange=instrument.exchange.code,
                breach_type=breach.type.value,
                breach_category=breach.type.family.value,
                breach_details=breach.detail,
                action_taken=ORDER_REJECTED,
                current_value=breach.current,
                limit_value=breach.limit,
                severity=breach.type.severity,
            )
            for breach in breaches
        ]
        try:
            async with UnitOfWork(self._sessions) as uow:
                for row in rows:
                    uow.session.add(row)
            return len(rows)
        except Exception:
            logger.exception(
                "%s: could not record %d risk breach(es) on %s",
                self._label,
                len(rows),
                instrument.trading_symbol,
            )
            return 0
