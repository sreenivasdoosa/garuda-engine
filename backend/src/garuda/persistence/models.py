"""Tables.

Only what the vertical slice needs. The rest arrives with the phase that uses
it, so no table exists here before something reads or writes it.

Shapes follow the reference engine's equivalents, including columns its later
migrations added — those exist because something broke without them.
"""

from __future__ import annotations

import datetime as dt

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from garuda.persistence.base import Base, MediumText, ShortText


class EventJournalRow(Base):
    """The append-only journal.

    Partitioned by ``trading_day`` so a day can be detached and archived
    whole, and so the common query -- everything for one day, in order -- hits
    a single partition.

    The primary key is ``(trading_day, sequence)`` because PostgreSQL requires
    the partition key in every unique constraint.
    """

    __tablename__ = "event_journal"
    __table_args__ = (
        Index("ix_event_journal_aggregate", "aggregate_type", "aggregate_id", "trading_day"),
        Index("ix_event_journal_correlation", "correlation_id"),
        Index("ix_event_journal_type_day", "event_type", "trading_day"),
        {"postgresql_partition_by": "RANGE (trading_day)"},
    )

    trading_day: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    sequence: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_type: Mapped[ShortText]
    aggregate_type: Mapped[ShortText]
    aggregate_id: Mapped[MediumText]
    occurred_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    actor: Mapped[ShortText]
    payload: Mapped[dict[str, object]] = mapped_column(JSONB)
    correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class TradingClientRow(Base):
    """One broker account, with what is needed to reach it."""

    __tablename__ = "trading_clients"
    __table_args__ = (UniqueConstraint("broker", "client_id", name="uq_trading_clients_account"),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    display_name: Mapped[MediumText] = mapped_column(unique=True)
    broker: Mapped[ShortText]
    client_id: Mapped[ShortText]
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    #: OAuth application credentials, issued per account by the broker. Without
    #: them no broker login is possible at all. The secret is encrypted at
    #: rest; see garuda.persistence.secrets.
    api_key: Mapped[str | None] = mapped_column(String(255), nullable=True)
    api_secret_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Where the broker sends the OAuth callback for this account. Registered
    #: with the broker, and may be localhost for a laptop install or a public
    #: address for a cloud one — login is not IP-restricted.
    redirect_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    #: The source address the broker has whitelisted for this account's
    #: **trading** APIs — orders, positions, funds. Not login: the OAuth flow
    #: works from anywhere, so an operator can log in from a laptop and still
    #: have order APIs refused because the engine is not running on the
    #: whitelisted address. Recording it is what turns that into a
    #: recognisable misconfiguration instead of an opaque rejection.
    static_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)

    #: A "pro" account, which some venues price and rate-limit differently.
    #: Recorded now because retrofitting a flag that changes brokerage means
    #: recomputing history.
    is_pro: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    #: Dealer-terminal APIs, which some brokers expose instead of the retail
    #: ones and which take a different order shape. NULL means inherit the
    #: broker's own setting rather than assert an answer for this account.
    use_dealer_apis: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

    #: Whether to take order and position updates over the broker's socket.
    #: Off means polling, which some accounts need.
    websocket_enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))


class TradingClientLoginStatusRow(Base):
    """Broker login state and session tokens for one account.

    Shaped after the reference engine's USER_BROKER_LOGIN_STATUS, including the
    session columns a later migration there added. That is where the tokens
    live, and why a restart does not force a manual re-login: the operator
    authorised the session, and restarting the process is not a new
    authorisation.

    Separate from the account itself because the two have opposite lifetimes.
    Credentials are entered once and change almost never; login state changes
    every day and on every failure.

    ``access_token`` and ``public_token`` are encrypted at rest. They authorise
    real orders, so a plaintext column would put them in every backup.
    """

    __tablename__ = "trading_client_login_status"

    trading_client_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("trading_clients.id", ondelete="CASCADE"), primary_key=True
    )
    #: Denormalised from the account so login problems can be read without a
    #: join, exactly as the reference engine keeps it.
    client_id: Mapped[ShortText]

    is_login_success: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    #: Brokers warn before a password expires. Surfacing it is what stops a
    #: login failing on a morning nobody expected.
    password_expiry_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: Kept verbatim. A broker's own wording is what makes a failure searchable
    #: in their documentation.
    login_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    access_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: Zerodha issues one alongside the access token; XTS-style brokers do not.
    public_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    #: The intermediate token an OAuth redirect returns, exchanged for the
    #: access token. Recorded because a failed exchange is otherwise
    #: undiagnosable.
    request_token: Mapped[str | None] = mapped_column(String(500), nullable=True)
    #: Per-session endpoint, for brokers that hand one back at login rather
    #: than publishing a fixed one.
    server_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    #: When the broker session began. Most Indian broker sessions expire at a
    #: fixed hour rather than after a duration, so this is what the engine
    #: reasons about.
    session_created_on: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    updated_on: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))


class SystemConfigRow(Base):
    """Runtime-changeable settings, edited from the Console.

    Static configuration -- database, ports, secrets -- lives in files and the
    environment, because the engine has to read it before it has a database.
    """

    __tablename__ = "system_config"

    key: Mapped[str] = mapped_column(String(128), primary_key=True)
    value: Mapped[str] = mapped_column(Text)
    value_type: Mapped[ShortText]
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
