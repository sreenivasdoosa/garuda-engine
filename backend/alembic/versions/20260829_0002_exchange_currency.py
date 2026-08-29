"""the currency a venue settles in

Deliberately absent from the reference engine, which is single-market and had
no reason for it. Here the venue is data: a US or Gulf exchange is meant to be
a row, and a row that does not say what it settles in makes every P&L figure
on it a number without a unit.

Added nullable, backfilled, then made NOT NULL -- so a new venue has to state
its currency rather than silently inheriting one.

Revision ID: 0002_exchange_currency
Revises: 0001_initial
Create Date: 2026-08-29

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0002_exchange_currency"
down_revision: str | Sequence[str] | None = "0001_initial"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Every venue in the seed trades in rupees. Named here rather than as a
#: column default: the next venue added should have to say.
BACKFILL = "INR"


def upgrade() -> None:
    op.add_column("exchanges", sa.Column("currency", sa.String(length=3), nullable=True))
    op.execute(
        sa.text("UPDATE exchanges SET currency = :currency WHERE currency IS NULL").bindparams(
            currency=BACKFILL
        )
    )
    op.alter_column("exchanges", "currency", nullable=False)


def downgrade() -> None:
    op.drop_column("exchanges", "currency")
