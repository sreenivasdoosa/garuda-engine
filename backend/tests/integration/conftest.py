"""Integration fixtures: a real PostgreSQL.

These are skipped rather than failed when no database is reachable, so the
unit suite still runs on a machine (or a CI job) without one.
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from garuda.config import Settings
from garuda.persistence import create_engine, create_session_factory

pytestmark = pytest.mark.integration


@pytest.fixture
def database_settings() -> Settings:
    return Settings()


# Function-scoped on purpose. pytest-asyncio gives each test its own event
# loop, and an engine built in one loop cannot be used from another -- a
# session-scoped engine fails with "Event loop is closed" on the second test.
@pytest.fixture
async def engine(database_settings: Settings) -> AsyncIterator[AsyncEngine]:
    engine = create_engine(database_settings.database)
    try:
        async with engine.connect() as connection:
            await connection.execute(text("SELECT 1"))
    except Exception as error:
        await engine.dispose()
        pytest.skip(f"no PostgreSQL available: {error}")
    yield engine
    await engine.dispose()


@pytest.fixture
def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(engine)


@pytest.fixture(autouse=True)
async def clean_tables(engine: AsyncEngine) -> None:
    """Each test starts from an empty journal.

    Truncating rather than wrapping the test in a transaction that rolls back:
    the unit of work owns its own transaction, and the atomicity tests need it
    to genuinely commit.
    """
    async with engine.begin() as connection:
        # CASCADE because trading_client_login_status references trading_clients;
        # PostgreSQL refuses to truncate a table an FK points at without it.
        await connection.execute(
            text(
                "TRUNCATE event_journal, trading_clients, trading_client_login_status, "
                "app_config RESTART IDENTITY CASCADE"
            )
        )
