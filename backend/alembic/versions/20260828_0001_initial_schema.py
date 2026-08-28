"""initial schema: journal, trading clients, system config

Revision ID: 0001_initial
Revises:
Create Date: 2026-08-28

The journal is partitioned by trading day, which is why this migration is
written by hand: Alembic's autogenerate cannot express PARTITION BY, and
PostgreSQL requires the partition key to appear in every unique constraint.

A DEFAULT partition catches every day, so nothing ever fails to insert because
a partition was missing. Dated partitions can be added later without touching
this migration; rows move into them on ATTACH.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(sa.text("CREATE SEQUENCE event_journal_sequence_seq AS bigint"))
    op.execute(
        sa.text(
            """
            CREATE TABLE event_journal (
                trading_day    date        NOT NULL,
                sequence       bigint      NOT NULL
                                           DEFAULT nextval('event_journal_sequence_seq'),
                event_type     varchar(64) NOT NULL,
                aggregate_type varchar(64) NOT NULL,
                aggregate_id   varchar(255) NOT NULL,
                occurred_at    timestamptz NOT NULL,
                actor          varchar(64) NOT NULL,
                payload        jsonb       NOT NULL,
                correlation_id varchar(64),
                CONSTRAINT pk_event_journal PRIMARY KEY (trading_day, sequence)
            ) PARTITION BY RANGE (trading_day)
            """
        )
    )
    op.execute(sa.text("ALTER SEQUENCE event_journal_sequence_seq OWNED BY event_journal.sequence"))
    op.execute(sa.text("CREATE TABLE event_journal_default PARTITION OF event_journal DEFAULT"))
    op.execute(
        sa.text(
            "CREATE INDEX ix_event_journal_aggregate ON event_journal "
            "(aggregate_type, aggregate_id, trading_day)"
        )
    )
    op.execute(
        sa.text("CREATE INDEX ix_event_journal_correlation ON event_journal (correlation_id)")
    )
    op.execute(
        sa.text("CREATE INDEX ix_event_journal_type_day ON event_journal (event_type, trading_day)")
    )

    op.create_table(
        "trading_clients",
        sa.Column("id", sa.String(64), nullable=False),
        sa.Column("display_name", sa.String(255), nullable=False),
        sa.Column("broker", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("enabled", sa.Boolean(), server_default="true", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_trading_clients"),
        sa.UniqueConstraint("broker", "client_id", name="uq_trading_clients_account"),
        sa.UniqueConstraint("display_name", name="uq_trading_clients_display_name"),
    )

    op.create_table(
        "system_config",
        sa.Column("key", sa.String(128), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("value_type", sa.String(64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key", name="pk_system_config"),
    )


def downgrade() -> None:
    op.drop_table("system_config")
    op.drop_table("trading_clients")
    op.execute(sa.text("DROP TABLE IF EXISTS event_journal"))
    op.execute(sa.text("DROP SEQUENCE IF EXISTS event_journal_sequence_seq"))
