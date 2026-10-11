"""The daily order stats' indexes, now that the engine writes the table

The reference reads the table by account and day, and the Console page by
day; neither had an index here because nothing wrote the rows.

Revision ID: 0014_rms_daily_stats_indexes
Revises: 0013_exchange_segment_timings
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0014_rms_daily_stats_indexes"
down_revision: str | Sequence[str] | None = "0013_exchange_segment_timings"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEXES = (
    ("ix_rms_daily_stats_client_date", ["trading_client_id", "stat_date"]),
    ("ix_rms_daily_stats_date", ["stat_date"]),
)


def upgrade() -> None:
    for name, columns in _INDEXES:
        op.create_index(name, "rms_daily_stats", columns)


def downgrade() -> None:
    for name, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name="rms_daily_stats")
