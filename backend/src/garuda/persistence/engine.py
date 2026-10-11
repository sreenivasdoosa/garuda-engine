"""Database engine and session factory."""

from __future__ import annotations

from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from garuda.config.settings import DatabaseSettings
from garuda.persistence import audit


def _server_settings(settings: DatabaseSettings) -> dict[str, str]:
    """Session settings every connection starts with.

    Every timestamp the engine handles is already UTC-aware, so the session
    never needs to guess a zone.

    `search_path` is set only when a schema is configured. It is set to that
    schema *alone*, without `public`: a test connection that could still see
    `public` would find the real tables there the moment a name went
    unqualified, which is the thing the setting exists to prevent.
    """
    server: dict[str, str] = {"timezone": "UTC"}
    if settings.schema_name:
        server["search_path"] = settings.schema_name
    return server


def create_engine(settings: DatabaseSettings) -> AsyncEngine:
    return create_async_engine(
        settings.async_url,
        echo=settings.echo_sql,
        pool_size=settings.pool_size,
        max_overflow=settings.pool_max_overflow,
        pool_pre_ping=True,
        # Every timestamp the engine handles is already UTC-aware, so the
        # session never needs to guess a zone.
        connect_args={"server_settings": _server_settings(settings)},
    )


def create_session_factory(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    # Every session's flushes are watched for the audit log; outside an API
    # request the watcher finds no capture and does nothing.
    audit.listen()
    return async_sessionmaker(
        engine,
        expire_on_commit=False,
        autoflush=False,
    )
