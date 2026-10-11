"""A segment's own hours, where they differ from its exchange's

Not in the reference engine, which has one open and one close per venue.
NSE's cash segment closes at 15:30 while NFO trades to 15:40, and a square-off
timed off the wrong close is a position the broker closes for you. Either
side left null inherits the exchange's, so a row says only what differs.

Revision ID: 0013_exchange_segment_timings
Revises: 0012_audit_log_indexes
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013_exchange_segment_timings"
down_revision: str | Sequence[str] | None = "0012_audit_log_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "exchange_segment_timings",
        sa.Column(
            "exchange_code",
            sa.String(10),
            sa.ForeignKey("exchanges.exchange_code", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("segment", sa.String(20), primary_key=True),
        sa.Column("market_open", sa.Time(), nullable=True),
        sa.Column("market_close", sa.Time(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("exchange_segment_timings")
