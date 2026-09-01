"""The one password, against a real database."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.credentials import ADMIN_PASSWORD, AdminCredentials
from garuda.core.clock import ReplayClock
from garuda.persistence.uow import UnitOfWork

pytestmark = pytest.mark.integration

START = datetime(2026, 9, 1, 4, 0, tzinfo=UTC)


def credentials(
    sessions: async_sessionmaker[AsyncSession], password: str = "garuda@777"
) -> AdminCredentials:
    return AdminCredentials(sessions, ReplayClock(START), first_run_password=password)


async def stored(sessions: async_sessionmaker[AsyncSession]) -> str | None:
    async with UnitOfWork(sessions) as uow:
        return await uow.repositories.system_config.value_of(ADMIN_PASSWORD)


async def test_the_first_run_puts_a_password_in_place(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = credentials(session_factory)

    await admin.ensure()

    assert await stored(session_factory) is not None
    assert await admin.matches("garuda@777") is True
    assert await admin.matches("something else") is False


async def test_ensure_does_not_overwrite_an_existing_password(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = credentials(session_factory)
    await admin.ensure()
    assert await admin.change("garuda@777", "a-longer-one") is None

    await admin.ensure()

    assert await admin.matches("a-longer-one") is True


async def test_a_missing_row_is_restored_rather_than_refusing_every_password(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """The row can go after startup -- a truncated table, a restore, a
    hand-run DELETE. Refusing every password until someone thinks to restart
    the process is a worse answer than putting a fresh install's password
    back.
    """
    admin = credentials(session_factory)
    await admin.ensure()
    async with UnitOfWork(session_factory) as uow:
        await uow.repositories.system_config.delete(ADMIN_PASSWORD)
    assert await stored(session_factory) is None

    assert await admin.matches("garuda@777") is True
    assert await stored(session_factory) is not None


async def test_a_restored_row_still_refuses_the_wrong_password(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    """Restoring is not the same as letting anyone in."""
    admin = credentials(session_factory)

    assert await admin.matches("not the first-run password") is False


async def test_changing_it_requires_the_current_one(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = credentials(session_factory)
    await admin.ensure()

    assert await admin.change("wrong", "a-longer-one") == "that is not the current password"
    assert await admin.matches("garuda@777") is True


async def test_a_short_replacement_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = credentials(session_factory)
    await admin.ensure()

    refusal = await admin.change("garuda@777", "short")

    assert refusal is not None
    assert await admin.matches("garuda@777") is True


async def test_the_same_password_again_is_refused(
    session_factory: async_sessionmaker[AsyncSession],
) -> None:
    admin = credentials(session_factory)
    await admin.ensure()

    assert await admin.change("garuda@777", "garuda@777") is not None
