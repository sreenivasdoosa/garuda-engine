"""Drop the bracket/cover-order flags

Garuda places neither. Both carry a broker-side stop the engine cannot see or
move, which puts the exit outside the trailing and square-off logic that owns
every other position -- so there is nothing for a flag to block.

Revision ID: 0007_drop_bo_co
Revises: 0006_strategy_event_days
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_drop_bo_co"
down_revision: str | Sequence[str] | None = "0006_strategy_event_days"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("event_days", "bo_co_blocked")
    op.drop_column("brokers", "bo_co_blocked")


def downgrade() -> None:
    op.add_column("brokers", sa.Column("bo_co_blocked", sa.Boolean(), nullable=True))
    op.add_column("event_days", sa.Column("bo_co_blocked", sa.Boolean(), nullable=True))
