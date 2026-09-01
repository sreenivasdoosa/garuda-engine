"""special_trading_days: days the venue opens when its schedule would close it

Budget day on a Saturday is the ordinary case -- normal hours on a day the
weekend rule would shut -- and Diwali muhurat is the other, a short evening
session on a day that is otherwise a holiday. The two hour columns are
nullable because the first case has no hours of its own.

Revision ID: 0005_special_trading_days
Revises: 0004_system_config
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_special_trading_days"
down_revision: str | Sequence[str] | None = "0004_system_config"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "special_trading_days",
        sa.Column("exchange", sa.String(length=10), nullable=False),
        # Text, like `holidays.date`: the shape the Console sends, and a
        # calendar key never needs date arithmetic done to it in SQL.
        sa.Column("trading_date", sa.String(length=10), nullable=False),
        sa.Column("trading_day_name", sa.String(length=100), nullable=True),
        sa.Column("market_open", sa.Time(), nullable=True),
        sa.Column("market_close", sa.Time(), nullable=True),
        sa.PrimaryKeyConstraint("exchange", "trading_date"),
    )


def downgrade() -> None:
    op.drop_table("special_trading_days")
