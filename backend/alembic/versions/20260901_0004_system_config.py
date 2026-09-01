"""settings an operator can change while it runs

The admin password is the first of them, and the reason this exists now: a
password that cannot be changed without editing a file and restarting is a
password nobody changes. `SYSTEM_CONFIG` in the reference engine is the same
shape -- one row per property -- and holds everything the Console edits at run
time rather than at install time.

Revision ID: 0004_system_config
Revises: 0003_exchange_segments
Create Date: 2026-09-01

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_system_config"
down_revision: str | Sequence[str] | None = "0003_exchange_segments"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "system_config",
        # Wide enough for an Argon2 hash, which is the longest thing this
        # holds today at around a hundred characters.
        sa.Column("property", sa.String(250), primary_key=True),
        sa.Column("value", sa.String(500), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("system_config")
