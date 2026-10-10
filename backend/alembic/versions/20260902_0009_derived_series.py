"""Per-symbol derived series, and somewhere to keep them

Five series the engine prices itself -- the rolling straddle, the put-call
ratio, the synthetic future and call/put implied volatility -- already exist as
synthetics and are published as ticks. Ticks vanish. A chart needs a past, so
each series is also folded into one-minute bars and kept.

**Which symbols get them is per symbol, not global.** Computing a chain-wide
straddle for every listed underlying every second is most of a core spent on
series nobody reads; the reference service ran them for a handful of indices.
So each is a flag on the symbol, and NIFTY and SENSEX turn on what they need.

Ported from the reference market-data service's `*_DATA_1MIN` tables, which
type every column `DOUBLE`. Here every one is `NUMERIC(20, 6)`: six decimal
places, so a straddle at 123.45 is kept as 123.45 rather than rounded to a
whole number, and exactly, because a float in a price path is a defect here.

Six places rather than two: an implied volatility and a put-call ratio are
ratios rather than rupees, and both need more than paise to be worth charting.

Its `SYMBOL_INFO` carries no enable flags at all -- it decided in code --
which is the thing this makes configurable.

`pcr_strikes_each_side` is ported as it stands: the reference added it in a
later migration because a PCR over the whole chain is dominated by far strikes
nobody trades.

Revision ID: 0009_derived_series
Revises: 0008_data_providers
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_derived_series"
down_revision: str | Sequence[str] | None = "0008_data_providers"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Every derived table is one row per symbol per minute.
_KEY = ("symbol", "bar_start")

#: Off by default. A flag turned on by an operator who wants the series is a
#: cheap engine; one on by default is every underlying computing a chain
#: straddle on the first run after an upgrade.
_FLAGS = (
    ("derives_straddle", "the at-the-money rolling straddle"),
    ("derives_pcr", "the put-call ratio"),
    ("derives_iv", "call and put implied volatility"),
    ("derives_synthetic", "the synthetic future"),
)


def _bars(*names: str) -> list[sa.Column]:
    """One series' columns. Exact, and to six decimal places."""
    return [sa.Column(name, sa.Numeric(20, 6), nullable=True) for name in names]


def upgrade() -> None:
    for column, _ in _FLAGS:
        op.add_column(
            "symbols",
            sa.Column(column, sa.Boolean(), nullable=False, server_default=sa.text("false")),
        )
    # Strikes either side of at-the-money the ratio is taken over. Null means
    # the whole chain, which is the reference's behaviour before it added this.
    op.add_column("symbols", sa.Column("pcr_strikes_each_side", sa.Integer(), nullable=True))

    op.create_table(
        "straddle_bars_1min",
        sa.Column("symbol", sa.String(length=100), nullable=False),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        *_bars("open", "high", "low", "close"),
        # Which strike the series was on when the bar closed. A rolling
        # straddle steps, and a chart that cannot say where it stepped shows a
        # gap that looks like bad data.
        sa.Column("strike", sa.Numeric(20, 6), nullable=True),
        sa.PrimaryKeyConstraint(*_KEY),
    )

    op.create_table(
        "synthetic_bars_1min",
        sa.Column("symbol", sa.String(length=100), nullable=False),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        *_bars("open", "high", "low", "close"),
        sa.PrimaryKeyConstraint(*_KEY),
    )

    op.create_table(
        "pcr_bars_1min",
        sa.Column("symbol", sa.String(length=100), nullable=False),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        *_bars("open", "high", "low", "close"),
        sa.PrimaryKeyConstraint(*_KEY),
    )

    op.create_table(
        "iv_bars_1min",
        sa.Column("symbol", sa.String(length=100), nullable=False),
        sa.Column("bar_start", sa.DateTime(timezone=True), nullable=False),
        # Two series in one row rather than two tables: they are read together
        # on every chart, and the strikes they were measured at belong beside
        # them -- an IV without its strike cannot be compared across a roll.
        *_bars(
            "call_open",
            "call_high",
            "call_low",
            "call_close",
            "put_open",
            "put_high",
            "put_low",
            "put_close",
        ),
        *_bars("call_strike", "put_strike", "spot_close"),
        sa.PrimaryKeyConstraint(*_KEY),
    )


def downgrade() -> None:
    for table in ("iv_bars_1min", "pcr_bars_1min", "synthetic_bars_1min", "straddle_bars_1min"):
        op.drop_table(table)
    op.drop_column("symbols", "pcr_strikes_each_side")
    for column, _ in reversed(_FLAGS):
        op.drop_column("symbols", column)
