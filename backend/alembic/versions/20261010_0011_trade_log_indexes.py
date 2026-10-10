"""The trade log's indexes, for the queries the Console makes

The table was created with the reference engine's columns and one index, on
the account. Now that the engine writes it and the Console reads it, the
reference's other indexes are needed for the same reasons it had them: one
trade's timeline is read by trade id in time order; the log page reads the
freshest events first, filtered by account, strategy or category; and a
hedged pair is found by its correlation id.

Revision ID: 0011_trade_log_indexes
Revises: 0010_symbol_display_order
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0011_trade_log_indexes"
down_revision: str | Sequence[str] | None = "0010_symbol_display_order"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEXES = (
    ("ix_trade_log_trade_time", ["trade_id", "event_timestamp"]),
    ("ix_trade_log_client_time", ["trading_client_id", "event_timestamp"]),
    ("ix_trade_log_strategy_time", ["strategy", "event_timestamp"]),
    ("ix_trade_log_category_time", ["event_category", "event_timestamp"]),
    ("ix_trade_log_event_time", ["event_timestamp"]),
    ("ix_trade_log_hedge", ["hedge_correlation_id"]),
)


def upgrade() -> None:
    for name, columns in _INDEXES:
        op.create_index(name, "trade_log", columns, unique=False)


def downgrade() -> None:
    for name, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name="trade_log")
