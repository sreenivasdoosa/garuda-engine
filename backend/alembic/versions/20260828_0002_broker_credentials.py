"""broker credentials, routing, and login session state

Revision ID: 0002_broker_credentials
Revises: 0001_initial
Create Date: 2026-08-28

The first schema for trading clients recorded who an account was but nothing
about how to reach it. OAuth needs an application key and secret per account,
some brokers bind API access to a fixed source address, and login state has to
survive a restart or every restart forces a manual re-login mid-session.

The login status table is shaped after the reference engine's
USER_BROKER_LOGIN_STATUS, including the session columns a later migration there
added: the access and public tokens, the request token an OAuth redirect
returns, the per-session server URL, and when the session began. That is where
the tokens live, which is why a restart does not force a re-login.

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
    # Nullable on purpose: NULL means inherit the broker's setting rather than
    # assert an answer for this account.
    op.add_column("trading_clients", sa.Column("use_dealer_apis", sa.Boolean(), nullable=True))
    op.add_column(
        "trading_clients",
        sa.Column("websocket_enabled", sa.Boolean(), server_default="true", nullable=False),
    )

    op.create_table(
        "trading_client_login_status",
        sa.Column("trading_client_id", sa.String(64), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("is_login_success", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("password_expiry_days", sa.Integer(), nullable=True),
        sa.Column("login_error", sa.Text(), nullable=True),
        sa.Column("access_token_encrypted", sa.Text(), nullable=True),
        sa.Column("public_token_encrypted", sa.Text(), nullable=True),
        sa.Column("request_token", sa.String(500), nullable=True),
        sa.Column("server_url", sa.String(500), nullable=True),
        sa.Column("session_created_on", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_on", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("trading_client_id", name="pk_trading_client_login_status"),
        sa.ForeignKeyConstraint(
            ["trading_client_id"],
            ["trading_clients.id"],
            name="fk_trading_client_login_status_trading_client_id",
            ondelete="CASCADE",
        ),
    )


def downgrade() -> None:
    op.drop_table("trading_client_login_status")
    op.drop_column("trading_clients", "websocket_enabled")
    op.drop_column("trading_clients", "use_dealer_apis")
    op.drop_column("trading_clients", "is_pro")
    op.drop_column("trading_clients", "static_ip")
    op.drop_column("trading_clients", "redirect_url")
    op.drop_column("trading_clients", "api_secret_encrypted")
    op.drop_column("trading_clients", "api_key")
