"""strategy_event_days: one strategy's override of an event day's size

An event day scales every strategy's size on a venue for a date. A row here
scales one named strategy differently, and the rest keep the day's figure.

Revision ID: 0006_strategy_event_days
Revises: 0005_special_trading_days
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_strategy_event_days"
down_revision: str | Sequence[str] | None = "0005_special_trading_days"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "strategy_event_days",
        sa.Column("strategy_name", sa.String(length=100), nullable=False),
        sa.Column("event_date", sa.String(length=10), nullable=False),
        sa.Column("exchange_code", sa.String(length=10), nullable=False),
        # NOT NULL: the row exists to state a figure. A null one would be a
        # row that overrides nothing, which is a deleted row spelled oddly.
        sa.Column("capital_percentage", sa.Numeric(20, 6), nullable=False),
        sa.PrimaryKeyConstraint("strategy_name", "event_date", "exchange_code"),
    )


def downgrade() -> None:
    op.drop_table("strategy_event_days")
