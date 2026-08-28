"""broker credentials, routing, and login session state

Revision ID: 0002_broker_credentials
Revises: 0001_initial
Create Date: 2026-08-28

The first schema for trading clients recorded who an account was but nothing
about how to reach it. OAuth needs an application key and secret per account,
some brokers bind API access to a fixed source address, and login state has to
survive a restart or every restart forces a manual re-login mid-session.

Credentials that authorise real orders -- the API secret and the access token
-- are stored encrypted. A plaintext column would put them in every backup.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "0002_broker_credentials"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("trading_clients", sa.Column("api_key", sa.String(255), nullable=True))
    op.add_column("trading_clients", sa.Column("api_secret_encrypted", sa.Text(), nullable=True))
    op.add_column("trading_clients", sa.Column("redirect_url", sa.String(500), nullable=True))
    op.add_column("trading_clients", sa.Column("static_ip", sa.String(45), nullable=True))
    op.add_column(
        "trading_clients",
        sa.Column("is_pro", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "trading_clients",
        sa.Column("websocket_enabled", sa.Boolean(), server_default="true", nullable=False),
    )

    op.create_table(
        "trading_client_sessions",
        sa.Column("trading_client_id", sa.String(64), nullable=False),
        sa.Column("logged_in", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("trading_client_id", name="pk_trading_client_sessions"),
        sa.ForeignKeyConstraint(
            ["trading_client_id"],
            ["trading_clients.id"],
            name="fk_trading_client_sessions_trading_client_id_trading_clients",
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    op.drop_table("trading_client_sessions")
    op.drop_column("trading_clients", "websocket_enabled")
    op.drop_column("trading_clients", "is_pro")
    op.drop_column("trading_clients", "static_ip")
    op.drop_column("trading_clients", "redirect_url")
    op.drop_column("trading_clients", "api_secret_encrypted")
    op.drop_column("trading_clients", "api_key")
