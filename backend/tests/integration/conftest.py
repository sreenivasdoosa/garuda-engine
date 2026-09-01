"""Integration fixtures: a real PostgreSQL, in a schema of their own.

These tests truncate every table between cases, which is the only way to make
them independent — and for a while they did it to whatever database `.env`
pointed at. That is a developer's own data, and running the suite destroyed
it: exchanges, holidays, the admin password, all of it, with `garuda seed` and
an API restart as the remedy.

They now work in their own schema on the same server. Two things keep them
there, and it is worth having both because the failure mode is silent data
loss:

* every connection's `search_path` is that schema **alone**, so an unqualified
  table name cannot resolve to the real one in `public`;
* the TRUNCATE names the schema explicitly, so it would still hit the test
  tables even if the `search_path` were wrong.

A schema rather than a separate database because it needs no privilege a
developer does not already have — creating a database needs `CREATEDB`, which
the application's role deliberately lacks. CI needs no change either: it runs
`postgres:18-alpine` as a service, and the suite makes its schema inside that
throwaway container.

The schema is built by **the migrations**, once per session, not by
`Base.metadata.create_all`. The two are not the same thing: `event_journal` is
partitioned and its DEFAULT partition is created by hand in the initial
migration, so `create_all` produces a parent table that accepts no rows. Any
such divergence would make these tests pass against a schema production never
has.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from garuda.config import Settings
from garuda.persistence import Base, create_engine, create_session_factory

pytestmark = pytest.mark.integration

#: Where the test tables live when nobody says otherwise.
DEFAULT_SCHEMA = "garuda_test"

#: The schema the application's own tables are in. Never the tests'.
PRODUCTION_SCHEMA = "public"


def test_schema() -> str:
    return os.environ.get("GARUDA_TEST_SCHEMA") or DEFAULT_SCHEMA


@pytest.fixture
def database_settings() -> Settings:
    """The configured settings, pointed at the test schema.

    Host, port, database, user and password are the real ones. Only the schema
    differs, which is the whole isolation.
    """
    schema = test_schema()
    if schema == PRODUCTION_SCHEMA or not schema.strip():
        pytest.fail(
            f"the integration tests would run in the {schema!r} schema, where the "
            "application's own tables are. They truncate every table, so that is data "
            "loss. Set GARUDA_TEST_SCHEMA to something else, or leave it unset."
        )
    settings = Settings()
    return settings.model_copy(
        update={"database": settings.database.model_copy(update={"schema_name": schema})}
    )


@pytest.fixture(scope="session")
def migrated() -> str:
    """The test schema, migrated to head. Once per session.

    Alembic is run as a subprocess rather than through its Python API because
    `alembic/env.py` calls `asyncio.run` at import, which cannot happen inside
    a thread that pytest-asyncio already has a loop on. A subprocess also
    means the tests exercise exactly the command a developer runs.
    """
    schema = test_schema()
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=Path(__file__).resolve().parents[2],
        env={**os.environ, "GARUDA_DB_SCHEMA": schema},
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        pytest.skip(
            f"could not migrate the {schema!r} schema, so no PostgreSQL to test against:\n"
            f"{result.stderr[-2000:]}"
        )
    return schema


# Function-scoped on purpose. pytest-asyncio gives each test its own event
# loop, and an engine built in one loop cannot be used from another -- a
# session-scoped engine fails with "Event loop is closed" on the second test.
@pytest.fixture
async def engine(database_settings: Settings, migrated: str) -> AsyncIterator[AsyncEngine]:
    del migrated  # ordering only: the schema has to exist before we connect
    engine = create_engine(database_settings.database)
    yield engine
    await engine.dispose()


@pytest.fixture
def session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return create_session_factory(engine)


@pytest.fixture(autouse=True)
async def clean_tables(engine: AsyncEngine, database_settings: Settings) -> None:
    """Each test starts from an empty schema.

    Every table, derived from the metadata rather than listed: a hand-written
    list goes stale the moment a table is added, and the symptom is rows
    leaking between tests, which reads as a bug in whatever ran second.

    Schema-qualified on purpose. The `search_path` already points here, so the
    qualification is redundant -- until the day it is not, and this statement
    is the one that must never be able to reach `public`.

    Truncating rather than wrapping the test in a transaction that rolls back:
    the unit of work owns its own transaction, and the atomicity tests need it
    to genuinely commit.
    """
    schema = database_settings.database.schema_name
    tables = ", ".join(f'"{schema}"."{name}"' for name in sorted(Base.metadata.tables))
    async with engine.begin() as connection:
        await connection.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
