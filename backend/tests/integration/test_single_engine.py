"""One engine per database, against a real PostgreSQL.

The failure this prevents is quiet and expensive: two engines read the same
subscriptions, see the same signals and place the same orders on the same
accounts, and each is behaving correctly while doing it. So the second one
must refuse, and the lock must be gone the moment a process dies.
"""

from __future__ import annotations

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine

from garuda.persistence.single_engine import (
    EngineAlreadyRunningError,
    SingleEngineLock,
)

pytestmark = pytest.mark.integration

#: Kept away from the real key so a failing test can never wedge a dev engine.
TEST_KEY = 8_314_552_071_777


def lock_for(engine: AsyncEngine) -> SingleEngineLock:
    return SingleEngineLock(engine, key=TEST_KEY)


async def held_count(engine: AsyncEngine) -> int:
    async with engine.connect() as connection:
        found = await connection.scalar(
            text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = :key"),
            {"key": TEST_KEY % 2**32},
        )
    return int(found or 0)


class TestTakingTheLock:
    async def test_the_first_engine_takes_it(self, engine: AsyncEngine) -> None:
        lock = lock_for(engine)
        try:
            await lock.acquire()

            assert lock.is_held is True
        finally:
            await lock.release()

    async def test_a_second_engine_is_refused_and_told_why(self, engine: AsyncEngine) -> None:
        first = lock_for(engine)
        second = lock_for(engine)
        await first.acquire()
        try:
            with pytest.raises(EngineAlreadyRunningError, match="already running"):
                await second.acquire()

            assert second.is_held is False
        finally:
            await first.release()

    async def test_acquiring_twice_in_one_process_is_harmless(self, engine: AsyncEngine) -> None:
        """It is the same engine asking; it already has it."""
        lock = lock_for(engine)
        try:
            await lock.acquire()
            await lock.acquire()

            assert lock.is_held is True
        finally:
            await lock.release()


class TestGivingItBack:
    async def test_releasing_lets_the_next_engine_start(self, engine: AsyncEngine) -> None:
        """A restart must not need a cleanup step."""
        first = lock_for(engine)
        await first.acquire()
        await first.release()

        second = lock_for(engine)
        try:
            await second.acquire()

            assert second.is_held is True
        finally:
            await second.release()

    async def test_releasing_without_holding_is_safe(self, engine: AsyncEngine) -> None:
        """The finally block runs whether or not the acquire got that far."""
        await lock_for(engine).release()

    async def test_nothing_is_left_held_afterwards(self, engine: AsyncEngine) -> None:
        """The connection is closed, not returned to the pool with the lock
        still on it -- a leaked lock would refuse every later start."""
        lock = lock_for(engine)
        await lock.acquire()
        await lock.release()

        assert await held_count(engine) == 0

    async def test_a_refused_engine_leaves_no_connection_holding_anything(
        self, engine: AsyncEngine
    ) -> None:
        first = lock_for(engine)
        await first.acquire()
        try:
            with pytest.raises(EngineAlreadyRunningError):
                await lock_for(engine).acquire()

            # Exactly the one the first engine holds.
            assert await held_count(engine) == 1
        finally:
            await first.release()
