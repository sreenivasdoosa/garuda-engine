"""Tables.

Only what the vertical slice needs. The rest arrives with the phase that uses
it, so no table exists here before something reads or writes it.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Index,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from garuda.persistence.base import Base, MediumText, ShortText


class EventJournalRow(Base):
    """The append-only journal.

    Partitioned by ``trading_day`` so a day can be detached and archived
    whole, and so the common query -- everything for one day, in order -- hits
    a single partition.

    The primary key is ``(trading_day, sequence)`` because PostgreSQL requires
    the partition key in every unique constraint.
    """

    __tablename__ = "event_journal"
    __table_args__ = (
        Index("ix_event_journal_aggregate", "aggregate_type", "aggregate_id", "trading_day"),
        Index("ix_event_journal_correlation", "correlation_id"),
        Index("ix_event_journal_type_day", "event_type", "trading_day"),
        {"postgresql_partition_by": "RANGE (trading_day)"},
    )

    trading_day: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_type: Mapped[ShortText]
    aggregate_type: Mapped[ShortText]
    aggregate_id: Mapped[MediumText]
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    actor: Mapped[ShortText]
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)
    correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class TradingClientRow(Base):
    """One broker account."""

    __tablename__ = "trading_clients"
    __table_args__ = (UniqueConstraint("broker", "client_id", name="uq_trading_clients_account"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[MediumText] = mapped_column(unique=True)
    broker: Mapped[ShortText]
    client_id: Mapped[ShortText]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))


class SystemConfigRow(Base):
    """Runtime-changeable settings, edited from the Console.

    Static configuration -- database, ports, secrets -- lives in files and the
    environment, because the engine has to read it before it has a database.
    """

    __tablename__ = "system_config"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    value_type: Mapped[ShortText]
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
