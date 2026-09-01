"""data_providers, and an encrypted session per provider

A market-data provider is not a trading client: one supplies prices, the other
places orders. Often the same broker account does both, and then the provider
row points at the trading client rather than holding a second copy of its
credentials — so one login serves both, and neither page can be stale about
the other.

`data_provider_sessions` already existed as a straight port of the reference
table, with the access token in plain text and no reader. It is replaced here
by one whose token is encrypted, like every other credential garuda stores,
and which cascades from the provider row.

Revision ID: 0008_data_providers
Revises: 0007_drop_bo_co
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_data_providers"
down_revision: str | Sequence[str] | None = "0007_drop_bo_co"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "data_providers",
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("credential_source", sa.String(length=20), nullable=False),
        sa.Column("trading_client_id", sa.String(length=64), nullable=True),
        sa.Column("api_key", sa.String(length=255), nullable=True),
        sa.Column("api_secret_encrypted", sa.Text(), nullable=True),
        sa.Column("client_id", sa.String(length=64), nullable=True),
        sa.Column("redirect_url", sa.String(length=500), nullable=True),
        sa.Column("websocket_port", sa.Integer(), nullable=True),
        sa.Column("history_port", sa.Integer(), nullable=True),
        sa.Column(
            "quote_min_interval_ms", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column(
            "history_min_interval_ms", sa.Integer(), nullable=False, server_default=sa.text("0")
        ),
        sa.Column("batch_size", sa.Integer(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("provider", name=op.f("pk_data_providers")),
        # RESTRICT: deleting an account that market data depends on must fail
        # loudly rather than silently stopping every strategy's prices.
        sa.ForeignKeyConstraint(
            ["trading_client_id"],
            ["trading_clients.id"],
            name=op.f("fk_data_providers_trading_client"),
            ondelete="RESTRICT",
        ),
    )

    # The ported table had the token in plain text and nothing read it.
    op.drop_table("data_provider_sessions")
    op.create_table(
        "data_provider_sessions",
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("client_id", sa.String(length=64), nullable=True),
        sa.Column("access_token_encrypted", sa.Text(), nullable=False),
        sa.Column("obtained_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("provider", name=op.f("pk_data_provider_sessions")),
        sa.ForeignKeyConstraint(
            ["provider"],
            ["data_providers.provider"],
            name=op.f("fk_data_provider_sessions_provider"),
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    op.drop_table("data_provider_sessions")
    op.create_table(
        "data_provider_sessions",
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("client_id", sa.String(length=50), nullable=True),
        sa.Column("access_token", sa.Text(), nullable=True),
        sa.Column("last_updated", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("provider", name=op.f("pk_data_provider_sessions")),
    )
    op.drop_table("data_providers")
