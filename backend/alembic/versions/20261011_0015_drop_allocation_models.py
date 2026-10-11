"""Allocation models go: an account subscribes to a strategy with its own capital

The reference let one capital pool be divided across strategies by a
named model. The owner decided against it on 2026-10-11: a trading
client subscribes to strategies directly, each subscription carrying its
own capital, and the reports follow the same shape. Nothing read these
two tables here, and no Console page remains for them.

Revision ID: 0015_drop_allocation_models
Revises: 0014_rms_daily_stats_indexes
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015_drop_allocation_models"
down_revision: str | Sequence[str] | None = "0014_rms_daily_stats_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("allocation_model_strategies")
    op.drop_table("allocation_models")


def downgrade() -> None:
    op.create_table(
        "allocation_models",
        sa.Column("model_name", sa.String(50), primary_key=True),
        sa.Column("capital", sa.Integer(), nullable=False),
        sa.Column("intraday_capital", sa.Integer(), nullable=True),
        sa.Column("positional_capital", sa.Integer(), nullable=True),
    )
    op.create_table(
        "allocation_model_strategies",
        sa.Column("model_name", sa.String(50), primary_key=True),
        sa.Column("strategy_name", sa.String(30), primary_key=True),
        sa.Column("num_of_lots", sa.Integer(), nullable=True),
        sa.Column("is_overlap_capital", sa.Boolean(), nullable=True),
    )
