"""The audit log's indexes, for the reads its page makes

The table was created with the reference engine's columns and no index. Now
that every operator mutation writes it and the Console reads it, the
reference's five indexes are needed for the same reasons it had them: the
page filters by entity type, by action and by who, reads one entity's
history by its id, and always orders by when.

Revision ID: 0012_audit_log_indexes
Revises: 0011_trade_log_indexes
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0012_audit_log_indexes"
down_revision: str | Sequence[str] | None = "0011_trade_log_indexes"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEXES = (
    ("ix_audit_log_entity_type", ["entity_type"]),
    ("ix_audit_log_entity_id", ["entity_id"]),
    ("ix_audit_log_changed_by", ["changed_by"]),
    ("ix_audit_log_changed_timestamp", ["changed_timestamp"]),
    ("ix_audit_log_action", ["action"]),
)


def upgrade() -> None:
    for name, columns in _INDEXES:
        op.create_index(name, "audit_log", columns)


def downgrade() -> None:
    for name, _columns in reversed(_INDEXES):
        op.drop_index(name, table_name="audit_log")
