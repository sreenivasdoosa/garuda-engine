"""The unit of work.

One transaction, one exit. Everything written inside it commits together or
not at all -- the journal append and the state change it describes above all.

Usage::

    async with UnitOfWork(session_factory) as uow:
        await uow.journal.append(events)
        await uow.repositories.trading_clients.upsert(row)

Leaving the block commits. Raising inside it rolls back, and the journal row
goes with the change it described.
"""

from __future__ import annotations

from types import TracebackType

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.errors import DomainError
from garuda.persistence.journal_store import PostgresJournalStore
from garuda.persistence.repositories import Repositories


class UnitOfWorkError(DomainError):
    """The unit of work was used outside its own block."""


class UnitOfWork:
    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._session_factory = session_factory
        self._session: AsyncSession | None = None
        self._journal: PostgresJournalStore | None = None
        self._repositories: Repositories | None = None

    @property
    def session(self) -> AsyncSession:
        if self._session is None:
            raise UnitOfWorkError("the unit of work is not open")
        return self._session

    @property
    def journal(self) -> PostgresJournalStore:
        if self._journal is None:
            raise UnitOfWorkError("the unit of work is not open")
        return self._journal

    @property
    def repositories(self) -> Repositories:
        """Every table, bound to this transaction."""
        if self._repositories is None:
            raise UnitOfWorkError("the unit of work is not open")
        return self._repositories

    async def __aenter__(self) -> UnitOfWork:
        self._session = self._session_factory()
        self._journal = PostgresJournalStore(self._session)
        self._repositories = Repositories(self._session)
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        session = self.session
        try:
            if exc_type is None:
                await session.commit()
            else:
                await session.rollback()
        finally:
            await session.close()
            self._session = None
            self._journal = None
            self._repositories = None
