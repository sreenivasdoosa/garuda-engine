"""Making sure only one engine is trading a database.

Once the API and the engine share a process, starting the server twice starts
the engine twice -- and two engines on one database are two engines reading
the same subscriptions, seeing the same signals and placing the same orders on
the same accounts. Nothing downstream would notice: each is behaving
correctly, and the broker sees two clients with valid sessions.

So the second one refuses to start. A Postgres advisory lock is the whole
mechanism: it is held by a connection rather than written anywhere, so it is
released the instant the process dies, however it dies. A row or a lock file
would have to be cleaned up after a crash, and the cleanup is exactly what
gets skipped at three in the morning.

This is the fail-closed rule applied to startup. Refusing to trade because
another engine might be trading costs a restart; guessing costs double
positions.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from sqlalchemy import text

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine

logger = logging.getLogger(__name__)

#: An arbitrary but fixed key. Advisory locks share one namespace per
#: database, so this only has to avoid colliding with anything else garuda
#: takes -- and garuda takes exactly one.
ENGINE_LOCK_KEY = 8_314_552_071_001


class EngineAlreadyRunningError(RuntimeError):
    """Another engine holds this database. Two would place the same orders."""


class SingleEngineLock:
    """One engine per database, enforced for as long as the process lives."""

    def __init__(self, engine: AsyncEngine, *, key: int = ENGINE_LOCK_KEY) -> None:
        self._engine = engine
        self._key = key
        self._held: AsyncConnection | None = None

    @property
    def is_held(self) -> bool:
        return self._held is not None

    async def acquire(self) -> None:
        """Take the lock, or say who already has it and stop.

        The connection is kept. Returning it to the pool would end the session
        the lock belongs to and quietly release it, which is worse than never
        having taken one: the guard would appear to be working.
        """
        if self._held is not None:
            return
        connection = await self._engine.connect()
        try:
            taken = await connection.scalar(
                text("SELECT pg_try_advisory_lock(:key)"), {"key": self._key}
            )
        except Exception:
            await connection.close()
            raise
        if not taken:
            await connection.close()
            raise EngineAlreadyRunningError(
                "another garuda engine is already running against this database. "
                "Two would read the same subscriptions and place the same orders. "
                "Stop the other one, or point this at a different database."
            )
        self._held = connection
        logger.info("engine lock taken; this process is the one trading this database")

    async def release(self) -> None:
        """Give it up. Safe to call when it was never taken."""
        connection, self._held = self._held, None
        if connection is None:
            return
        try:
            await connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": self._key})
        except Exception:
            # The connection is going anyway, and the lock dies with it.
            logger.debug("could not unlock cleanly; the connection is closing regardless")
        finally:
            await connection.close()
            logger.info("engine lock released")
