"""The strategy engine's schema: no templates, the columns the port missed

`STRATEGY_ENGINE.md` §2. The template table goes, and `template_name` with
it; what a template switched on is a definition column now, and custom logic
is a registered `strategy_class`. The config tree gains the breakout-range
columns the first port missed, the FixedDelta pair, and the 0DTE stop rules;
it loses the GLOBAL_SHARED trio, decided out. Day allocation arrives keyed by
strategy alone.

Per column against the reference dump: ported -- BREAKOUT_RANGE_TYPE,
_START, _END, _LOOKBACK, _ON_HIGH_BREAK, _ON_LOW_BREAK, _REVERSAL_MODE, and
STRATEGY_DAYS_ALLOCATION_CONFIG's weekday, EXPIRY_DAY, DT1_DAY, DT2_DAY.
Added from the reference's code, newer than the dump -- TARGET_DELTA and
MAX_DELTA_DEVIATION. New here -- STOP_AFTER_LOSS_TRANCHES and
STOP_AFTER_PROFIT_TRANCHES (the 0DTE template's constants), USE_INDICATOR_ENTRY
(the indicator template's existence), STRATEGY_CLASS. Dropped --
STRATEGY_TEMPLATES whole, TEMPLATE_NAME, TEMPLATE_PARAMS, LOT_ALLOCATION_MODE,
GLOBAL_ALLOCATION_TRANCHES, ALLOCATION_START_TRANCH, and the day allocation's
ALLOCATION_MODEL key.

Revision ID: 0016_strategy_engine_schema
Revises: 0015_drop_allocation_models
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op

revision: str = "0016_strategy_engine_schema"
down_revision: str | Sequence[str] | None = "0015_drop_allocation_models"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_table("strategy_templates")

    with op.batch_alter_table("strategy_definitions") as definitions:
        definitions.drop_column("template_name")
        definitions.add_column(sa.Column("strategy_class", sa.String(100), nullable=True))
        definitions.add_column(
            sa.Column(
                "use_indicator_entry",
                sa.Boolean(),
                nullable=False,
                server_default=sa.false(),
            )
        )

    with op.batch_alter_table("strategy_config") as config:
        config.drop_column("lot_allocation_mode")
        config.drop_column("global_allocation_tranches")
        config.drop_column("allocation_start_tranch")
        config.add_column(sa.Column("stop_after_loss_tranches", sa.Integer(), nullable=True))
        config.add_column(sa.Column("stop_after_profit_tranches", sa.Integer(), nullable=True))
        config.add_column(sa.Column("breakout_range_type", sa.String(20), nullable=True))
        config.add_column(sa.Column("breakout_range_start", sa.String(8), nullable=True))
        config.add_column(sa.Column("breakout_range_end", sa.String(8), nullable=True))
        config.add_column(sa.Column("breakout_range_lookback", sa.Integer(), nullable=True))
        config.add_column(sa.Column("breakout_on_high_break", sa.String(10), nullable=True))
        config.add_column(sa.Column("breakout_on_low_break", sa.String(10), nullable=True))
        config.add_column(sa.Column("breakout_reversal_mode", sa.String(16), nullable=True))
        config.add_column(sa.Column("target_delta", sa.Numeric(6, 4), nullable=True))
        config.add_column(sa.Column("max_delta_deviation", sa.Numeric(6, 4), nullable=True))

    op.create_table(
        "strategy_days_allocation",
        sa.Column("strategy_name", sa.String(100), primary_key=True),
        sa.Column("monday", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("tuesday", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("wednesday", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("thursday", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("friday", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("expiry_day", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("dt1_day", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("dt2_day", sa.Integer(), nullable=False, server_default="100"),
    )


def downgrade() -> None:
    op.drop_table("strategy_days_allocation")

    with op.batch_alter_table("strategy_config") as config:
        for name in (
            "max_delta_deviation",
            "target_delta",
            "breakout_reversal_mode",
            "breakout_on_low_break",
            "breakout_on_high_break",
            "breakout_range_lookback",
            "breakout_range_end",
            "breakout_range_start",
            "breakout_range_type",
            "stop_after_profit_tranches",
            "stop_after_loss_tranches",
        ):
            config.drop_column(name)
        config.add_column(sa.Column("allocation_start_tranch", sa.Integer(), nullable=True))
        config.add_column(sa.Column("global_allocation_tranches", sa.Integer(), nullable=True))
        config.add_column(sa.Column("lot_allocation_mode", sa.String(20), nullable=True))

    with op.batch_alter_table("strategy_definitions") as definitions:
        definitions.drop_column("use_indicator_entry")
        definitions.drop_column("strategy_class")
        definitions.add_column(sa.Column("template_name", sa.String(100), nullable=True))

    op.create_table(
        "strategy_templates",
        sa.Column("template_name", sa.String(100), primary_key=True),
        sa.Column("display_name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("evaluator_class", sa.String(500), nullable=False),
        sa.Column("supports_tick_trigger", sa.Boolean(), nullable=True),
        sa.Column("supports_scheduled_trigger", sa.Boolean(), nullable=True),
        sa.Column("supports_signal_trigger", sa.Boolean(), nullable=True),
        sa.Column("supports_periodic_trigger", sa.Boolean(), nullable=True),
        sa.Column("supports_hedge_management", sa.Boolean(), nullable=True),
        sa.Column("is_fno", sa.Boolean(), nullable=True),
        sa.Column("support_tranches", sa.Boolean(), nullable=True),
        sa.Column("default_config", postgresql.JSONB(), nullable=True),
        sa.Column("version", sa.Integer(), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("asset_class", sa.String(10), nullable=False),
        sa.Column("is_user_selectable", sa.Boolean(), nullable=False),
        sa.Column("supported_trade_modes", sa.String(100), nullable=True),
        sa.Column("supported_direction_providers", sa.String(255), nullable=True),
        sa.Column("supports_indicator_entry", sa.Boolean(), nullable=False),
        sa.Column("supports_indicator_exit", sa.Boolean(), nullable=False),
        sa.Column("supports_reentry", sa.Boolean(), nullable=False),
        sa.Column("resolution_priority", sa.Integer(), nullable=False),
        sa.Column("supports_combos", sa.Boolean(), nullable=False),
    )
