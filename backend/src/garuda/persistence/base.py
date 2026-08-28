"""Declarative base and column conventions.

Constraint names follow a convention so Alembic can always refer to one by
name. Without it, dropping a constraint on PostgreSQL needs a name the
migration has to guess, and autogenerate produces migrations that fail on a
database it did not create.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from sqlalchemy import MetaData, Numeric, String
from sqlalchemy.orm import DeclarativeBase, mapped_column

#: PostgreSQL truncates an identifier at 63 characters and SQLAlchemy refuses
#: to generate one longer, so the foreign-key convention omits the referred
#: table: "fk_<table>_<columns>" is already unique within a table, and
#: including the target pushed a realistic name past the limit.
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_N_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s",
    "pk": "pk_%(table_name)s",
}

#: Money and prices are NUMERIC, never double precision. The float ban in the
#: application would be pointless if the database rounded on the way in.
MoneyAmount = Annotated[Decimal, mapped_column(Numeric(20, 4))]
PriceAmount = Annotated[Decimal, mapped_column(Numeric(20, 6))]
Factor = Annotated[Decimal, mapped_column(Numeric(16, 8))]

ShortText = Annotated[str, mapped_column(String(64))]
MediumText = Annotated[str, mapped_column(String(255))]


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
