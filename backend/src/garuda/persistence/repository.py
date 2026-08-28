"""The generic repository.

One class covering what every table needs — fetch, filter, page, count,
insert, upsert, update, delete — so a table-specific repository only has to
add the queries that are actually specific to it.

Everything takes the session from a :class:`UnitOfWork` and nothing commits.
The unit of work owns the transaction, which is what keeps a write atomic with
the journal entry describing it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, ClassVar

from sqlalchemy import CursorResult, func, select
from sqlalchemy import delete as sql_delete
from sqlalchemy import update as sql_update
from sqlalchemy.dialects.postgresql import insert as postgres_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from garuda.domain.errors import DomainError
from garuda.persistence.base import Base


def _rows_affected(result: object) -> int:
    """How many rows a write touched.

    UPDATE and DELETE return a cursor result; the general Result type does not
    declare rowcount, so it is read here in one place rather than ignored with
    a type comment at every call site.
    """
    if isinstance(result, CursorResult):
        return int(result.rowcount)
    return 0


class RowNotFoundError(DomainError):
    """A row the caller said must exist does not.

    Separate from returning None so a caller can choose: ``get`` for "it may
    not be there", ``require`` for "its absence is a bug".
    """


class UnknownColumnError(DomainError):
    """A filter named a column the table does not have.

    Raised rather than ignored. A silently dropped filter returns every row,
    and at a money boundary that is the difference between one account's
    positions and everyone's.
    """


@dataclass(frozen=True, slots=True)
class Page[RowT]:
    """One page of rows, with the total behind it."""

    rows: Sequence[RowT]
    total: int
    limit: int
    offset: int

    @property
    def has_more(self) -> bool:
        return self.offset + len(self.rows) < self.total


class Repository[RowT: Base]:
    """CRUD for one table."""

    #: Set by each subclass. The table this repository reads and writes.
    model: ClassVar[type[Any]]

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @property
    def session(self) -> AsyncSession:
        return self._session

    # -- reading ------------------------------------------------------------

    async def get(self, *primary_key: Any) -> RowT | None:
        """Fetch by primary key. None when it is not there."""
        key = primary_key[0] if len(primary_key) == 1 else primary_key
        row: RowT | None = await self._session.get(self.model, key)
        return row

    async def require(self, *primary_key: Any) -> RowT:
        """Fetch by primary key, raising when absent."""
        row = await self.get(*primary_key)
        if row is None:
            raise RowNotFoundError(f"{self.model.__tablename__} has no row {primary_key}")
        return row

    async def find(
        self,
        *,
        order_by: str | None = None,
        descending: bool = False,
        limit: int | None = None,
        offset: int = 0,
        **filters: Any,
    ) -> Sequence[RowT]:
        """Every row matching equality filters."""
        statement = self._filtered(select(self.model), filters)
        if order_by is not None:
            column = self._column(order_by)
            statement = statement.order_by(column.desc() if descending else column.asc())
        if limit is not None:
            statement = statement.limit(limit)
        if offset:
            statement = statement.offset(offset)
        result = await self._session.execute(statement)
        return list(result.scalars())

    async def find_one(self, **filters: Any) -> RowT | None:
        rows = await self.find(limit=2, **filters)
        if len(rows) > 1:
            raise DomainError(f"{self.model.__tablename__}: {filters} matched more than one row")
        return rows[0] if rows else None

    async def all(self, *, order_by: str | None = None) -> Sequence[RowT]:
        return await self.find(order_by=order_by)

    async def exists(self, **filters: Any) -> bool:
        return await self.count(**filters) > 0

    async def count(self, **filters: Any) -> int:
        statement = self._filtered(select(func.count()).select_from(self.model), filters)
        return int((await self._session.execute(statement)).scalar_one())

    async def page(
        self,
        *,
        limit: int,
        offset: int = 0,
        order_by: str | None = None,
        descending: bool = False,
        **filters: Any,
    ) -> Page[RowT]:
        """A page of rows and the total matching the same filters.

        The count uses the same filters as the rows, so a page never reports a
        total from a different question than the one it answered.
        """
        rows = await self.find(
            order_by=order_by, descending=descending, limit=limit, offset=offset, **filters
        )
        return Page(rows=rows, total=await self.count(**filters), limit=limit, offset=offset)

    # -- writing ------------------------------------------------------------

    def add(self, row: RowT) -> RowT:
        """Stage an insert. Committed by the unit of work."""
        self._session.add(row)
        return row

    def add_all(self, rows: Sequence[RowT]) -> Sequence[RowT]:
        self._session.add_all(list(rows))
        return rows

    async def upsert(
        self, values: Mapping[str, Any], *, conflict_on: Sequence[str] | None = None
    ) -> None:
        """Insert, or update the row already there.

        The reference engine calls this insertOrUpdate and uses it everywhere
        a broker restates something the engine already recorded — a position,
        a margin, a login status.
        """
        await self.upsert_all([values], conflict_on=conflict_on)

    async def upsert_all(
        self, rows: Sequence[Mapping[str, Any]], *, conflict_on: Sequence[str] | None = None
    ) -> None:
        if not rows:
            return

        columns = set(rows[0])
        for row in rows:
            if set(row) != columns:
                # Filling the gaps with NULL would quietly wipe values the row
                # already has, which is the opposite of what an upsert is for.
                raise DomainError(
                    f"{self.model.__tablename__}: every row in one upsert must set the "
                    f"same columns; got {sorted(columns)} and {sorted(row)}"
                )
            for column in row:
                self._column(column)

        keys = list(conflict_on) if conflict_on else self._primary_key_names()
        statement = postgres_insert(self.model).values(list(rows))
        updatable = {name: statement.excluded[name] for name in rows[0] if name not in keys}
        if updatable:
            statement = statement.on_conflict_do_update(index_elements=keys, set_=updatable)
        else:
            statement = statement.on_conflict_do_nothing(index_elements=keys)
        await self._session.execute(statement)

    async def update(self, *primary_key: Any, **values: Any) -> int:
        """Change one row by primary key. Returns rows affected."""
        if not values:
            return 0
        for column in values:
            self._column(column)
        statement = (
            sql_update(self.model).where(*self._primary_key_clause(primary_key)).values(**values)
        )
        result = await self._session.execute(statement)
        return _rows_affected(result)

    async def update_where(self, *, filters: Mapping[str, Any], **values: Any) -> int:
        if not values:
            return 0
        for column in values:
            self._column(column)
        statement = self._filtered(sql_update(self.model), filters).values(**values)
        result = await self._session.execute(statement)
        return _rows_affected(result)

    async def delete(self, *primary_key: Any) -> int:
        statement = sql_delete(self.model).where(*self._primary_key_clause(primary_key))
        result = await self._session.execute(statement)
        return _rows_affected(result)

    async def delete_where(self, **filters: Any) -> int:
        if not filters:
            raise DomainError(
                f"{self.model.__tablename__}: refusing to delete every row; "
                "pass a filter or use truncate deliberately"
            )
        statement = self._filtered(sql_delete(self.model), filters)
        result = await self._session.execute(statement)
        return _rows_affected(result)

    # -- internals ----------------------------------------------------------

    def _column(self, name: str) -> InstrumentedAttribute[Any]:
        column = getattr(self.model, name, None)
        if not isinstance(column, InstrumentedAttribute):
            raise UnknownColumnError(
                f"{self.model.__tablename__} has no column {name!r}; "
                "a silently dropped filter returns every row"
            )
        return column

    def _filtered(self, statement: Any, filters: Mapping[str, Any]) -> Any:
        for name, value in filters.items():
            column = self._column(name)
            statement = statement.where(
                column.in_(value) if isinstance(value, (list, tuple, set)) else column == value
            )
        return statement

    def _primary_key_names(self) -> list[str]:
        return [column.name for column in self.model.__table__.primary_key.columns]

    def _primary_key_clause(self, values: Sequence[Any]) -> list[Any]:
        names = self._primary_key_names()
        if len(values) != len(names):
            raise DomainError(
                f"{self.model.__tablename__} has a {len(names)}-column primary key "
                f"{names}, given {len(values)} value(s)"
            )
        return [self._column(name) == value for name, value in zip(names, values, strict=True)]
