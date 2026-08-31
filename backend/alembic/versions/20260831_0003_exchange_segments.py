"""what a venue trades

The venue is data, and until now `exchanges` said when one opens and closes but
not what it lists. Which segments a venue trades lived in a hardcoded table of
three in the loader, so a fourth venue would silently have been given every
segment — telling a strategy that a commodity exchange lists equities.

Revision ID: 0003_exchange_segments
Revises: 0002_exchange_currency
Create Date: 2026-08-31

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_exchange_segments"
down_revision: str | Sequence[str] | None = "0002_exchange_currency"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: What the venues shipped in the seed trade. Applied here so an existing
#: database matches the seed without being reseeded; nothing else is guessed at.
KNOWN = {
    "NSE": "EQUITY,FNO,CURRENCY",
    "BSE": "EQUITY,FNO",
    "MCX": "COMMODITY",
}


def upgrade() -> None:
    op.add_column("exchanges", sa.Column("segments", sa.String(length=100), nullable=True))
    for code, segments in KNOWN.items():
        op.execute(
            sa.text(
                "UPDATE exchanges SET segments = :segments "
                "WHERE exchange_code = :code AND segments IS NULL"
            ).bindparams(segments=segments, code=code)
        )


def downgrade() -> None:
    op.drop_column("exchanges", "segments")
