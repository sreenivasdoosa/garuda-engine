"""Reading the Brokers page's switches out of the database.

Two of the row's columns reach the engine: whether a broker is enabled, and
whether the operator has stopped it. Both are read when the engine builds its
accounts, so a broker switched off on the page has no account built at it,
by name. Everything else on the row -- the vendor's endpoints, the intervals
-- is served for the record and read by nothing yet.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class BrokerState:
    """The two switches on a broker row that decide whether its accounts trade."""

    name: str
    enabled: bool = True
    stopped: bool = False


async def load_brokers(sessions: async_sessionmaker[AsyncSession]) -> dict[str, BrokerState]:
    """Every broker row, keyed by its lower-case name."""
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.brokers.all(order_by="broker_name")
    loaded = {
        row.broker_name.lower(): BrokerState(
            name=row.broker_name.lower(),
            enabled=bool(row.enabled),
            stopped=bool(row.stopped),
        )
        for row in rows
    }
    switched_off = sorted(n for n, b in loaded.items() if not b.enabled or b.stopped)
    if switched_off:
        logger.warning("brokers switched off on the Brokers page: %s", ", ".join(switched_off))
    return loaded
