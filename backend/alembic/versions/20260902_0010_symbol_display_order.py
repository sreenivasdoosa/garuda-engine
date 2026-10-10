"""An operator-chosen order for the symbols shown on a page

The Live Feed shows a card per index, and alphabetical is the wrong order for
every operator: it opens on BANKNIFTY and buries NIFTY in the middle. Which
one comes first is a preference, not a fact, so it is a column rather than a
list in code.

Nullable on purpose. Null means "no preference", sorts last, and then falls
back to the symbol -- so an equity nobody ordered behaves exactly as it did,
and only the handful of indices worth arranging need a number. Ties are broken
by symbol too, so the order is total and a page never reshuffles between loads.

Seeded for the indices that exist today, in the order they are usually watched:
the two headline indices, then the bank and sector indices, then commodities.

Revision ID: 0010_symbol_display_order
Revises: 0009_derived_series
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010_symbol_display_order"
down_revision: str | Sequence[str] | None = "0009_derived_series"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Only these are seeded, and only where the row already exists. An install
#: with different symbols curated is left entirely alone rather than having an
#: opinion imposed on it.
_DEFAULT_ORDER = (
    ("NIFTY", 1),
    ("SENSEX", 2),
    ("BANKNIFTY", 3),
    ("FINNIFTY", 4),
    ("MIDCPNIFTY", 5),
    ("BANKEX", 6),
    ("CRUDEOIL", 7),
    ("GOLD", 8),
    ("GOLDM", 9),
    ("SILVER", 10),
    ("SILVERM", 11),
    ("NATURALGAS", 12),
)


def upgrade() -> None:
    op.add_column("symbols", sa.Column("display_order", sa.Integer(), nullable=True))
    symbols = sa.table(
        "symbols", sa.column("symbol", sa.String), sa.column("display_order", sa.Integer)
    )
    for symbol, position in _DEFAULT_ORDER:
        op.execute(
            symbols.update().where(symbols.c.symbol == symbol).values(display_order=position)
        )


def downgrade() -> None:
    op.drop_column("symbols", "display_order")
