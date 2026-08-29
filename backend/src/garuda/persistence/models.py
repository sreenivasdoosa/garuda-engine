"""Tables.

Every table the engine has, in one place. Shapes follow the reference engine's
current schema dump — its core database and its market-data database, which
Garuda runs in one process and therefore one schema.

Three conversions apply throughout, and none of them are cosmetic:

* **``double`` becomes ``NUMERIC``.** The reference engine stores every price,
  charge and P&L as a double. A float cannot hold a paisa, and the application
  ban on floats would be pointless if the database rounded on the way in.
* **``(USER_NAME, BROKER_NAME)`` becomes ``trading_client_id``.** The reference
  engine keys most tables on a user and a broker; Garuda has one operator and
  many broker accounts, so that pair collapses into the account itself.
* **Dropped features take their columns with them.** Auto-login credentials,
  licence keys, agent routing and external capital are gone; the features are
  listed in docs/SCOPE_DECISIONS.md.

Where the two dumps disagree — EXCHANGES, HOLIDAYS, SYMBOL_INFO exist in both —
the core version wins. Market data syncs those to core, which then adds columns
of its own, so core is the superset.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    Time,
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


class AppConfigRow(Base):
    """APP_CONFIG in the reference engine."""

    __tablename__ = "app_config"

    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[str | None] = mapped_column(String(500), nullable=True)


class ExchangesRow(Base):
    """EXCHANGES in the reference engine."""

    __tablename__ = "exchanges"

    exchange_code: Mapped[str] = mapped_column(String(10), primary_key=True)
    exchange_name: Mapped[str] = mapped_column(String(100))
    timezone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pre_market_start: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    pre_market_end: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    market_open: Mapped[dt.time] = mapped_column(Time)
    market_close: Mapped[dt.time] = mapped_column(Time)
    intraday_squareoff_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    intraday_squareoff_block_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    post_market_window_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    positional_squareoff_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    report_minutes_after_close: Mapped[int | None] = mapped_column(Integer, nullable=True)
    history_cache_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    weekend_days: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    #: How long before the open the day is prepared — caches, instrument
    #: master, corporate actions. Every phase of a venue's day is an offset
    #: from its own open or close, so a venue in another timezone needs a row
    #: rather than a code change.
    day_init_minutes_before_market_open: Mapped[int | None] = mapped_column(Integer, nullable=True)
    login_minutes_before_market_open: Mapped[int | None] = mapped_column(Integer, nullable=True)
    algo_start_minutes_before_market_open: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )


class HolidaysRow(Base):
    """HOLIDAYS in the reference engine."""

    __tablename__ = "holidays"

    date: Mapped[str] = mapped_column(String(10), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)


class EventDaysRow(Base):
    """EVENT_DAYS in the reference engine."""

    __tablename__ = "event_days"

    event_date: Mapped[str] = mapped_column(String(10), primary_key=True)
    exchange_code: Mapped[str] = mapped_column(String(10), primary_key=True)
    event_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    bo_co_blocked: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    capital_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class ProductsRow(Base):
    """PRODUCTS in the reference engine."""

    __tablename__ = "products"

    product: Mapped[str] = mapped_column(String(50), primary_key=True)
    description: Mapped[str | None] = mapped_column(String(250), nullable=True)


class SymbolsRow(Base):
    """SYMBOL_INFO in the reference engine."""

    __tablename__ = "symbols"

    symbol: Mapped[str] = mapped_column(String(100), primary_key=True)
    exchange: Mapped[str | None] = mapped_column(String(15), nullable=True)
    index_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_index: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    strike_gap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    freeze_limit_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_option_chain_levels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    has_options_weekly_expiry: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_options_monthly_expiry: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_futures_weekly_expiry: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    has_futures_monthly_expiry: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    straddle_max_premium_diff: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    contract_multiplier: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedge_strike_rounding_multiple: Mapped[int | None] = mapped_column(Integer, nullable=True)


class SymbolBrokerInfoRow(Base):
    """SYMBOL_BROKER_INFO in the reference engine."""

    __tablename__ = "symbol_broker_info"

    symbol: Mapped[str] = mapped_column(String(100), primary_key=True)
    broker_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    freeze_limit_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)


class BrokersRow(Base):
    """BROKERS in the reference engine."""

    __tablename__ = "brokers"

    broker_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    stopped: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    description: Mapped[str | None] = mapped_column(String(250), nullable=True)
    provider: Mapped[str | None] = mapped_column(String(30), nullable=True)
    use_dealer_apis: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    server_url: Mapped[str | None] = mapped_column(String(100), nullable=True)
    data_server_url: Mapped[str | None] = mapped_column(String(100), nullable=True)
    bo_co_blocked: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    market_data_app_key: Mapped[str | None] = mapped_column(String(50), nullable=True)
    market_data_app_secret: Mapped[str | None] = mapped_column(String(50), nullable=True)
    web_socket_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    api_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    server_start_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    server_stop_time: Mapped[str | None] = mapped_column(String(5), nullable=True)
    naic_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    algo_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    oauth_url: Mapped[str | None] = mapped_column(String(250), nullable=True)
    host_lookup_version: Mapped[str | None] = mapped_column(String(50), nullable=True)
    order_update_interval_secs: Mapped[int] = mapped_column(Integer)
    position_update_interval_secs: Mapped[int] = mapped_column(Integer)
    host_lookup_path: Mapped[str | None] = mapped_column(String(100), nullable=True)
    iosocket_version: Mapped[str | None] = mapped_column(String(10), nullable=True)
    mtf_interest_rate_per_annum: Mapped[Decimal] = mapped_column(Numeric(20, 6))


class BrokerExchangeConfigRow(Base):
    """BROKER_EXCHANGE_CONFIG in the reference engine."""

    __tablename__ = "broker_exchange_config"

    broker_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    exchange_code: Mapped[str] = mapped_column(String(10), primary_key=True)
    login_minutes_before_market_open: Mapped[int | None] = mapped_column(Integer, nullable=True)
    intraday_squareoff_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    intraday_squareoff_block_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    positional_squareoff_minutes_before_close: Mapped[int | None] = mapped_column(
        Integer, nullable=True
    )
    market_orders_allowed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    naic_code: Mapped[str | None] = mapped_column(String(8), nullable=True)
    algo_id: Mapped[str | None] = mapped_column(String(32), nullable=True)
    limit_order_buffer_equity: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    limit_order_buffer_futures: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    limit_order_buffer_options: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    sl_trigger_to_limit_gap_equity: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    sl_trigger_to_limit_gap_futures: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    sl_trigger_to_limit_gap_options: Mapped[Decimal] = mapped_column(Numeric(20, 6))


class BrokerApiStatsRow(Base):
    """BROKER_API_STATS in the reference engine."""

    __tablename__ = "broker_api_stats"

    #: The reference table has no primary key. Legal in MySQL and a
    #: liability here: without one there is no way to address a single row.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    broker_name: Mapped[str] = mapped_column(String(30))
    operation: Mapped[str | None] = mapped_column(String(50), nullable=True)
    order_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    start_time: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    end_time: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    time_taken: Mapped[int | None] = mapped_column(Integer, nullable=True)


class ClientCapitalRow(Base):
    """USER_CAPITAL_MAP in the reference engine."""

    __tablename__ = "client_capital"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    capital: Mapped[int | None] = mapped_column(Integer, nullable=True)


class CapitalChangeHistoryRow(Base):
    """CAPITAL_CHANGE_HISTORY in the reference engine."""

    __tablename__ = "capital_change_history"

    #: The reference table has no primary key. Legal in MySQL and a
    #: liability here: without one there is no way to address a single row.
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    strategy_name: Mapped[str] = mapped_column(String(30))
    old_capital: Mapped[int | None] = mapped_column(Integer, nullable=True)
    new_capital: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timestamp: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(100), nullable=True)


class ClientMarginsRow(Base):
    """USER_MARGINS in the reference engine."""

    __tablename__ = "client_margins"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    exchange_code: Mapped[str | None] = mapped_column(String(10), nullable=True)
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    peak_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class StrategyTemplatesRow(Base):
    """STRATEGY_TEMPLATES in the reference engine."""

    __tablename__ = "strategy_templates"

    template_name: Mapped[str] = mapped_column(String(100), primary_key=True)
    display_name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    evaluator_class: Mapped[str] = mapped_column(String(500))
    supports_tick_trigger: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    supports_scheduled_trigger: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    supports_signal_trigger: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    supports_periodic_trigger: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    supports_hedge_management: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_fno: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    support_tranches: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    default_config: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    asset_class: Mapped[str] = mapped_column(String(10))
    is_user_selectable: Mapped[bool] = mapped_column(Boolean)
    supported_trade_modes: Mapped[str | None] = mapped_column(String(100), nullable=True)
    supported_direction_providers: Mapped[str | None] = mapped_column(String(255), nullable=True)
    supports_indicator_entry: Mapped[bool] = mapped_column(Boolean)
    supports_indicator_exit: Mapped[bool] = mapped_column(Boolean)
    supports_reentry: Mapped[bool] = mapped_column(Boolean)
    resolution_priority: Mapped[int] = mapped_column(Integer)
    supports_combos: Mapped[bool] = mapped_column(Boolean)


class StrategyDefinitionsRow(Base):
    """STRATEGY_DEFINITIONS in the reference engine."""

    __tablename__ = "strategy_definitions"

    strategy_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    display_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    display_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    template_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    underlying_symbol: Mapped[str] = mapped_column(String(50))
    exchange: Mapped[str] = mapped_column(String(20))
    product: Mapped[str | None] = mapped_column(String(16), nullable=True)
    trade_mode: Mapped[str] = mapped_column(String(20))
    tick_trigger_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    scheduled_trigger_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    signal_trigger_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    periodic_trigger_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    start_time: Mapped[str | None] = mapped_column(String(10), nullable=True)
    stop_time: Mapped[str | None] = mapped_column(String(10), nullable=True)
    tradable_days: Mapped[str | None] = mapped_column(String(200), nullable=True)
    excluded_days: Mapped[str | None] = mapped_column(String(100), nullable=True)
    capital_per_lot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    capital_per_lot_hedged: Mapped[int | None] = mapped_column(Integer, nullable=True)
    capital_per_lot_naked: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_overlap_capital: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    expiry_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    exclude_monthly_expiry: Mapped[bool] = mapped_column(Boolean)
    use_premium_balancing: Mapped[bool] = mapped_column(Boolean)
    underlying_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    hedge_distance_percentage_intraday: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    hedge_distance_percentage_positional: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    is_directional: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    direction_provider_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    direction_provider_params: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20))
    catch_up_missed_tranches: Mapped[bool] = mapped_column(Boolean)
    adaptive_tranches_enabled: Mapped[bool] = mapped_column(Boolean)
    username: Mapped[str] = mapped_column(String(100))
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_public: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_mock: Mapped[bool] = mapped_column(Boolean)
    scope: Mapped[str | None] = mapped_column(String(10), nullable=True)
    periodic_interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    periodic_offset_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedge_replace_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    hedge_morning_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedge_morning_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedge_evening_start_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedge_evening_end_offset: Mapped[int | None] = mapped_column(Integer, nullable=True)
    risk_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    absolute_max_risk: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    min_risk_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_risk_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    leverage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    min_leverage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_leverage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    universe_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    equity_sizing_model: Mapped[str | None] = mapped_column(String(30), nullable=True)
    fixed_amount_per_stock: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_active_positions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_risk_pct_per_trade: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    on_index_removal: Mapped[str | None] = mapped_column(String(20), nullable=True)
    combo_spec_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    entry_leg_order: Mapped[str | None] = mapped_column(String(32), nullable=True)
    exit_leg_order: Mapped[str | None] = mapped_column(String(32), nullable=True)


class StrategyConfigRow(Base):
    """STRATEGY_CONFIG_TREE in the reference engine."""

    __tablename__ = "strategy_config"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    tranch_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    day_condition: Mapped[str | None] = mapped_column(String(20), nullable=True)
    strike_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    strike_value: Mapped[str | None] = mapped_column(String(20), nullable=True)
    option_premium: Mapped[int | None] = mapped_column(Integer, nullable=True)
    option_premium_upper: Mapped[int | None] = mapped_column(Integer, nullable=True)
    use_atm_if_itm: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    volume_filter: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    oi_filter: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    apply_volume_filter_to_hedge: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    apply_oi_filter_to_hedge: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    lots_per_tranch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hedging_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sl_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    target_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    combined_sl_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    combined_target_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    risk_calculation_mode: Mapped[str | None] = mapped_column(String(30), nullable=True)
    trail_sl: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    trail_sl_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    trail_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    sl_buffer_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    trail_sl_to_cost: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    combined_trail_sl: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    sl_trigger_to_limit_gap_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    tranch_timing: Mapped[str | None] = mapped_column(String(10), nullable=True)
    tranch_cutoff_time: Mapped[str | None] = mapped_column(String(10), nullable=True)
    min_tranch_gap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    tranch_gap: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_mode: Mapped[str | None] = mapped_column(String(50), nullable=True)
    exit_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_time: Mapped[str | None] = mapped_column(String(20), nullable=True)
    order_fill_escalation_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    order_fill_escalation_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    order_fill_escalation_steps: Mapped[str | None] = mapped_column(Text, nullable=True)
    max_tranches: Mapped[int | None] = mapped_column(Integer, nullable=True)
    lot_allocation_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    global_allocation_tranches: Mapped[int | None] = mapped_column(Integer, nullable=True)
    allocation_start_tranch: Mapped[int | None] = mapped_column(Integer, nullable=True)
    re_entry: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    max_reentries: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_reentry_loss_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(5, 2), nullable=True
    )
    directional: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    breakout_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    breakout_watch_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    breakout_direction: Mapped[str | None] = mapped_column(String(10), nullable=True)
    breakout_trigger_mode: Mapped[str | None] = mapped_column(String(15), nullable=True)
    breakout_trigger_value: Mapped[Decimal | None] = mapped_column(Numeric(10, 4), nullable=True)
    breakout_select_fresh_strikes: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    hedge_strike_rounding_min_distance: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    oi_rank: Mapped[int | None] = mapped_column(Integer, nullable=True)
    ignore_itm_strikes: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    lookback_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    otm_levels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    no_stop_loss: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class StrategySymbolSubscriptionsRow(Base):
    """STRATEGY_SYMBOL_SUBSCRIPTIONS in the reference engine."""

    __tablename__ = "strategy_symbol_subscriptions"

    subscription_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    symbol: Mapped[str] = mapped_column(String(50))
    exchange: Mapped[str] = mapped_column(String(20))
    subscription_type: Mapped[str] = mapped_column(String(16))
    strikes_above: Mapped[int | None] = mapped_column(Integer, nullable=True)
    strikes_below: Mapped[int | None] = mapped_column(Integer, nullable=True)
    expiry_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StrategyBreakoutWatchesRow(Base):
    """STRATEGY_BREAKOUT_WATCHES in the reference engine."""

    __tablename__ = "strategy_breakout_watches"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    watch_type: Mapped[str] = mapped_column(String(20))
    watch_symbol: Mapped[str] = mapped_column(String(100))
    exchange: Mapped[str] = mapped_column(String(10))
    reference_price: Mapped[Decimal] = mapped_column(Numeric(15, 4))
    trigger_price_above: Mapped[Decimal | None] = mapped_column(Numeric(15, 4), nullable=True)
    trigger_price_below: Mapped[Decimal | None] = mapped_column(Numeric(15, 4), nullable=True)
    direction: Mapped[str] = mapped_column(String(10))
    trigger_mode: Mapped[str] = mapped_column(String(15))
    trigger_value: Mapped[Decimal] = mapped_column(Numeric(10, 4))
    strategy_name: Mapped[str] = mapped_column(String(100))
    username: Mapped[str] = mapped_column(String(100))
    broker_name: Mapped[str] = mapped_column(String(50))
    tranch_number: Mapped[int] = mapped_column(Integer)
    group_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    valid_till: Mapped[dt.time | None] = mapped_column(Time, nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    is_triggered: Mapped[bool] = mapped_column(Boolean)
    triggered_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    triggered_price: Mapped[Decimal | None] = mapped_column(Numeric(15, 4), nullable=True)
    is_expired: Mapped[bool] = mapped_column(Boolean)
    expired_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(100), nullable=True)
    option_type: Mapped[str | None] = mapped_column(String(5), nullable=True)
    strike: Mapped[int | None] = mapped_column(Integer, nullable=True)
    trade_direction: Mapped[str | None] = mapped_column(String(10), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    quantity_per_lot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    entry_premium: Mapped[Decimal | None] = mapped_column(Numeric(15, 4), nullable=True)
    fno_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    strike_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    strike_value: Mapped[str | None] = mapped_column(String(20), nullable=True)
    option_premium: Mapped[int | None] = mapped_column(Integer, nullable=True)
    option_premium_upper: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_directional: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    metadata_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    risk_used_estimate: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)


class StrategyIndicatorRulesRow(Base):
    """STRATEGY_INDICATOR_RULES in the reference engine."""

    __tablename__ = "strategy_indicator_rules"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    entry_rules_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    direction_rules_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    exit_rules_json: Mapped[str | None] = mapped_column(Text, nullable=True)
    use_indicator_exit: Mapped[bool] = mapped_column(Boolean)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StrategyEvaluationLogRow(Base):
    """STRATEGY_EVALUATION_LOG in the reference engine."""

    __tablename__ = "strategy_evaluation_log"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    log_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    event_type: Mapped[str] = mapped_column(String(16))
    event_data: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    signals_generated: Mapped[int | None] = mapped_column(Integer, nullable=True)
    execution_time_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)
    result_summary: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    evaluated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class HedgeSchedulesRow(Base):
    """HEDGE_SCHEDULES in the reference engine."""

    __tablename__ = "hedge_schedules"

    schedule_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    window_type: Mapped[str] = mapped_column(String(16))
    window_start: Mapped[dt.time] = mapped_column(Time)
    window_end: Mapped[dt.time] = mapped_column(Time)
    hedge_rules: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StockUniversesRow(Base):
    """STOCK_UNIVERSES in the reference engine."""

    __tablename__ = "stock_universes"

    universe_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    universe_type: Mapped[str] = mapped_column(String(20))
    index_key: Mapped[str | None] = mapped_column(String(40), nullable=True)
    exchange: Mapped[str] = mapped_column(String(10))
    is_active: Mapped[bool] = mapped_column(Boolean)
    source: Mapped[str] = mapped_column(String(20))
    last_refreshed_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StockUniverseMembersRow(Base):
    """STOCK_UNIVERSE_MEMBERS in the reference engine."""

    __tablename__ = "stock_universe_members"

    universe_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    symbol: Mapped[str] = mapped_column(String(50), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10))


class SubscriptionsRow(Base):
    """USER_STRATEGY_SUBSCRIPTIONS in the reference engine."""

    __tablename__ = "subscriptions"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    subscription_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    activated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deactivated_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    capital: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    risk_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    absolute_max_risk: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    leverage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    max_active_positions: Mapped[int | None] = mapped_column(Integer, nullable=True)


class SubscriptionStateRow(Base):
    """USER_STRATEGY_STATE in the reference engine."""

    __tablename__ = "subscription_state"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    state_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(100))
    trading_date: Mapped[dt.date] = mapped_column(Date)
    cycle_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    state_data: Mapped[dict[str, object]] = mapped_column(JSONB)
    last_evaluation_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_signal_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    evaluation_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    signal_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class SlTargetPolicyRow(Base):
    """SL_TARGET_POLICY in the reference engine."""

    __tablename__ = "sl_target_policy"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    policy_name: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    sl_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    target_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    combined_sl_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    combined_target_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    sl_trigger_to_limit_gap_percentage: Mapped[Decimal | None] = mapped_column(
        Numeric(20, 6), nullable=True
    )
    sl_buffer_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    risk_calculation_mode: Mapped[str | None] = mapped_column(String(30), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TrailingSlPolicyRow(Base):
    """TRAILING_SL_POLICY in the reference engine."""

    __tablename__ = "trailing_sl_policy"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    policy_name: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    trail_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    trail_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    trail_config: Mapped[str | None] = mapped_column(Text, nullable=True)
    trail_to_cost: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    combined_trail_enabled: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ExitPolicyRow(Base):
    """EXIT_POLICY in the reference engine."""

    __tablename__ = "exit_policy"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    policy_name: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    exit_mode: Mapped[str | None] = mapped_column(String(20), nullable=True)
    exit_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
    exit_time: Mapped[str | None] = mapped_column(String(10), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StrikeSelectionPolicyRow(Base):
    """STRIKE_SELECTION_POLICY in the reference engine."""

    __tablename__ = "strike_selection_policy"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    policy_name: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    strike_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    strike_value: Mapped[str | None] = mapped_column(String(20), nullable=True)
    premium_lower: Mapped[int | None] = mapped_column(Integer, nullable=True)
    premium_upper: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class OrderFillEscalationPolicyRow(Base):
    """ORDER_FILL_ESCALATION_POLICY in the reference engine."""

    __tablename__ = "order_fill_escalation_policy"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    policy_name: Mapped[str] = mapped_column(String(50))
    description: Mapped[str | None] = mapped_column(String(255), nullable=True)
    escalation_mode: Mapped[str] = mapped_column(String(20))
    escalation_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    escalation_steps: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AllocationModelsRow(Base):
    """ALLOCATION_MODELS in the reference engine."""

    __tablename__ = "allocation_models"

    model_name: Mapped[str] = mapped_column(String(50), primary_key=True)
    capital: Mapped[int] = mapped_column(Integer)
    intraday_capital: Mapped[int | None] = mapped_column(Integer, nullable=True)
    positional_capital: Mapped[int | None] = mapped_column(Integer, nullable=True)


class AllocationModelStrategiesRow(Base):
    """ALLOCATION_MODEL_STRATEGIES_MAP in the reference engine."""

    __tablename__ = "allocation_model_strategies"

    model_name: Mapped[str] = mapped_column(String(50), primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    num_of_lots: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_overlap_capital: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class TradesRow(Base):
    """TRADES in the reference engine."""

    __tablename__ = "trades"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    trade_date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    trade_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    product: Mapped[str] = mapped_column(String(16))
    combo_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    leg_role: Mapped[str | None] = mapped_column(String(32), nullable=True)
    brokerage_plan: Mapped[str | None] = mapped_column(String(30), nullable=True)
    client_id: Mapped[str | None] = mapped_column(String(30), nullable=True)
    strategy_name: Mapped[str] = mapped_column(String(30))
    tranch_name: Mapped[str | None] = mapped_column(String(30), nullable=True)
    group_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    exchange: Mapped[str | None] = mapped_column(String(15), nullable=True)
    segment: Mapped[str | None] = mapped_column(String(15), nullable=True)
    trading_symbol: Mapped[str] = mapped_column(String(50))
    direction: Mapped[str] = mapped_column(String(10))
    product_type: Mapped[str | None] = mapped_column(String(10), nullable=True)
    start_timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    end_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    req_entry: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    req_exit: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    req_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    entry_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    exit_price: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    cmp: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    contract_multiplier: Mapped[int | None] = mapped_column(Integer, nullable=True)
    qty_per_lot: Mapped[int] = mapped_column(Integer)
    filled_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    initial_stoploss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stoploss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    target: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    profit_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    turnover_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    brokerage_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    sebi_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stt_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stamp_duty_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    gst_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    depository_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    net_profit_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pl_percentage: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    exit_reason: Mapped[str | None] = mapped_column(String(30), nullable=True)
    failure_reason: Mapped[str | None] = mapped_column(String(1000), nullable=True)
    is_futures: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    is_options: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    remarks: Mapped[str | None] = mapped_column(String(500), nullable=True)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    state: Mapped[str] = mapped_column(String(16))
    mtf_interest: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    ca_factor: Mapped[Decimal] = mapped_column(Numeric(16, 8))
    entry_sequence: Mapped[int] = mapped_column(Integer)


class TradeLogRow(Base):
    """TRADE_LOG in the reference engine."""

    __tablename__ = "trade_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    trade_id: Mapped[str] = mapped_column(String(64))
    username: Mapped[str] = mapped_column(String(64))
    broker: Mapped[str] = mapped_column(String(32))
    strategy: Mapped[str | None] = mapped_column(String(128), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(64), nullable=True)
    hedge_correlation_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    event_category: Mapped[str] = mapped_column(String(24))
    event_type: Mapped[str] = mapped_column(String(48))
    event_timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    order_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    order_status: Mapped[str | None] = mapped_column(String(32), nullable=True)
    order_type: Mapped[str | None] = mapped_column(String(16), nullable=True)
    price: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    filled_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sl_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    target_price: Mapped[Decimal | None] = mapped_column(Numeric(14, 4), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    details: Mapped[dict[str, object] | None] = mapped_column(JSONB, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class LiveTradesRow(Base):
    """LIVE_TRADES in the reference engine."""

    __tablename__ = "live_trades"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    trade_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    product: Mapped[str] = mapped_column(String(15))
    strategy_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    signal_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_mock: Mapped[bool] = mapped_column(Boolean)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    start_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    end_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    state: Mapped[str] = mapped_column(String(16))
    hedge_correlation_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pair_correlation_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    trade_group: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tranch: Mapped[int] = mapped_column(Integer)
    slice: Mapped[int] = mapped_column(Integer)
    evicted: Mapped[bool] = mapped_column(Boolean)


class LiveTradesArchiveRow(Base):
    """LIVE_TRADES_ARCHIVE in the reference engine."""

    __tablename__ = "live_trades_archive"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    trade_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    product: Mapped[str] = mapped_column(String(15))
    strategy_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    signal_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_mock: Mapped[bool] = mapped_column(Boolean)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    start_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    end_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    state: Mapped[str] = mapped_column(String(16))
    hedge_correlation_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pair_correlation_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    trade_group: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tranch: Mapped[int] = mapped_column(Integer)
    slice: Mapped[int] = mapped_column(Integer)
    evicted: Mapped[bool] = mapped_column(Boolean)


class LiveTradeSignalsRow(Base):
    """LIVE_TRADE_SIGNALS in the reference engine."""

    __tablename__ = "live_trade_signals"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    signal_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    product: Mapped[str] = mapped_column(String(15))
    strategy_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    direction: Mapped[str | None] = mapped_column(String(10), nullable=True)
    is_triggered: Mapped[bool] = mapped_column(Boolean)
    is_disabled: Mapped[bool] = mapped_column(Boolean)
    is_mock: Mapped[bool] = mapped_column(Boolean)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    signal_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trade_group: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tranch: Mapped[int] = mapped_column(Integer)
    slice: Mapped[int] = mapped_column(Integer)
    evicted: Mapped[bool] = mapped_column(Boolean)


class LiveTradeSignalsArchiveRow(Base):
    """LIVE_TRADE_SIGNALS_ARCHIVE in the reference engine."""

    __tablename__ = "live_trade_signals_archive"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    signal_id: Mapped[str] = mapped_column(String(50), primary_key=True)
    product: Mapped[str] = mapped_column(String(15))
    strategy_name: Mapped[str | None] = mapped_column(String(64), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    direction: Mapped[str | None] = mapped_column(String(10), nullable=True)
    is_triggered: Mapped[bool] = mapped_column(Boolean)
    is_disabled: Mapped[bool] = mapped_column(Boolean)
    is_mock: Mapped[bool] = mapped_column(Boolean)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean)
    signal_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    trade_group: Mapped[str | None] = mapped_column(String(64), nullable=True)
    tranch: Mapped[int] = mapped_column(Integer)
    slice: Mapped[int] = mapped_column(Integer)
    evicted: Mapped[bool] = mapped_column(Boolean)


class CorporateActionsRow(Base):
    """CORPORATE_ACTIONS in the reference engine."""

    __tablename__ = "corporate_actions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    exchange: Mapped[str] = mapped_column(String(16))
    trading_symbol: Mapped[str] = mapped_column(String(64))
    action_type: Mapped[str] = mapped_column(String(16))
    ratio_from: Mapped[Decimal] = mapped_column(Numeric(12, 4))
    ratio_to: Mapped[Decimal] = mapped_column(Numeric(12, 4))
    qty_factor: Mapped[Decimal] = mapped_column(Numeric(16, 8))
    ex_date: Mapped[dt.date] = mapped_column(Date)
    record_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    status: Mapped[str] = mapped_column(String(16))
    source: Mapped[str] = mapped_column(String(16))
    notes: Mapped[str | None] = mapped_column(String(512), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    approved_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applied_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class TradeCorporateActionsRow(Base):
    """TRADE_CORPORATE_ACTIONS in the reference engine."""

    __tablename__ = "trade_corporate_actions"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    corporate_action_id: Mapped[int] = mapped_column(BigInteger)
    trade_id: Mapped[str] = mapped_column(String(64))
    product: Mapped[str] = mapped_column(String(16))
    qty_factor: Mapped[Decimal] = mapped_column(Numeric(16, 8))
    pre_snapshot: Mapped[str] = mapped_column(Text)
    post_snapshot: Mapped[str] = mapped_column(Text)
    qty_residue: Mapped[Decimal] = mapped_column(Numeric(12, 6))
    credit_status: Mapped[str | None] = mapped_column(String(16), nullable=True)
    applied_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RmsConfigRow(Base):
    """RMS_CONFIG in the reference engine."""

    __tablename__ = "rms_config"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    config_level: Mapped[str] = mapped_column(String(20))
    exchange: Mapped[str | None] = mapped_column(String(10), nullable=True)
    username: Mapped[str | None] = mapped_column(String(50), nullable=True)
    broker: Mapped[str | None] = mapped_column(String(50), nullable=True)
    symbol: Mapped[str | None] = mapped_column(String(50), nullable=True)
    segment_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    min_volume_today: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_volume_early_market: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_bid_ask_spread_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    max_bid_ask_spread_absolute: Mapped[Decimal | None] = mapped_column(
        Numeric(10, 2), nullable=True
    )
    bid_ask_absolute_threshold_price: Mapped[Decimal | None] = mapped_column(
        Numeric(10, 2), nullable=True
    )
    min_depth_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_depth_levels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enable_freak_price_check: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    freak_check_min_price: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    max_order_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_order_qty_lots: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_order_value: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    max_price_deviation_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    max_price_deviation_abs: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
    max_orders_per_second: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_order_operations_per_second: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_orders_per_minute: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_orders_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    enable_freeze_qty_check: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    skip_price_validation_for_exit: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    max_orders_per_symbol_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_total_positions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_buy_qty_per_symbol_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_sell_qty_per_symbol_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_buy_orders_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_sell_orders_per_day: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_position_qty_per_symbol: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_daily_loss_amount: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    max_daily_loss_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    auto_square_off_on_breach: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    enable_auto_kill_on_loss: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    max_rejection_rate_pct: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    max_vix_level: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    volatility_pause_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_active: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stale_price_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    early_market_grace_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_volume_early_period_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    min_open_interest: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_total_combos: Mapped[int | None] = mapped_column(Integer, nullable=True)


class RmsBreachLogRow(Base):
    """RMS_BREACH_LOG in the reference engine."""

    __tablename__ = "rms_breach_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    breach_time: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    username: Mapped[str | None] = mapped_column(String(50), nullable=True)
    broker: Mapped[str | None] = mapped_column(String(50), nullable=True)
    strategy_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    trading_symbol: Mapped[str | None] = mapped_column(String(100), nullable=True)
    exchange: Mapped[str | None] = mapped_column(String(10), nullable=True)
    breach_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    breach_category: Mapped[str | None] = mapped_column(String(20), nullable=True)
    breach_details: Mapped[str | None] = mapped_column(Text, nullable=True)
    action_taken: Mapped[str | None] = mapped_column(String(50), nullable=True)
    current_value: Mapped[str | None] = mapped_column(String(50), nullable=True)
    limit_value: Mapped[str | None] = mapped_column(String(50), nullable=True)
    severity: Mapped[int | None] = mapped_column(Integer, nullable=True)


class RmsClientStateRow(Base):
    """RMS_USER_STATE in the reference engine."""

    __tablename__ = "rms_client_state"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(String(50))
    broker: Mapped[str] = mapped_column(String(50))
    trading_date: Mapped[dt.date] = mapped_column(Date)
    deployed_capital: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    used_margin: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    available_margin: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    peak_margin_used: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    realized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    unrealized_pnl: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    total_pnl: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    peak_pnl: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    drawdown: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    total_positions: Mapped[int | None] = mapped_column(Integer, nullable=True)
    gross_exposure: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    net_exposure: Mapped[Decimal | None] = mapped_column(Numeric(15, 2), nullable=True)
    orders_today: Mapped[int | None] = mapped_column(Integer, nullable=True)
    rejections_today: Mapped[int | None] = mapped_column(Integer, nullable=True)
    consecutive_losses: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_killed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    kill_reason: Mapped[str | None] = mapped_column(String(200), nullable=True)
    kill_time: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RmsDailyStatsRow(Base):
    """USER_RMS_DAILY_STATS in the reference engine."""

    __tablename__ = "rms_daily_stats"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    trading_symbol: Mapped[str] = mapped_column(String(100), primary_key=True)
    stat_date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    order_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    buy_order_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sell_order_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    buy_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sell_qty: Mapped[int | None] = mapped_column(Integer, nullable=True)


class KillSwitchesRow(Base):
    """KILL_SWITCHES in the reference engine."""

    __tablename__ = "kill_switches"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=False,
        index=True,
    )
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_date: Mapped[dt.date] = mapped_column(Date)
    key_name: Mapped[str] = mapped_column(String(255))
    level: Mapped[str] = mapped_column(String(20))
    exchange: Mapped[str | None] = mapped_column(String(50), nullable=True)
    symbol: Mapped[str | None] = mapped_column(String(100), nullable=True)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    active: Mapped[bool] = mapped_column(Boolean)
    source: Mapped[str] = mapped_column(String(50))
    clear_time_abs_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    removed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class KillSwitchTypesRow(Base):
    """KILL_SWITCH_TYPES in the reference engine."""

    __tablename__ = "kill_switch_types"

    source: Mapped[str] = mapped_column(String(50), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean)
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_by: Mapped[str | None] = mapped_column(String(255), nullable=True)


class BrokeragePlansRow(Base):
    """BROKERAGE_PLANS in the reference engine."""

    __tablename__ = "brokerage_plans"

    plan_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    unit_type: Mapped[str | None] = mapped_column(String(10), nullable=True)
    brokerage_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    description: Mapped[str | None] = mapped_column(String(250), nullable=True)
    broker_name: Mapped[str | None] = mapped_column(String(30), nullable=True)
    plan_type: Mapped[str | None] = mapped_column(String(20), nullable=True)
    fixed_fee: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    billing_period: Mapped[str | None] = mapped_column(String(20), nullable=True)


class BrokeragePlanRatesRow(Base):
    """BROKERAGE_PLAN_RATES in the reference engine."""

    __tablename__ = "brokerage_plan_rates"

    plan_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    segment: Mapped[str] = mapped_column(String(20), primary_key=True)
    product: Mapped[str] = mapped_column(String(20), primary_key=True)
    unit_type: Mapped[str | None] = mapped_column(String(10), nullable=True)
    rate_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    brokerage_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class StatutoryChargesRow(Base):
    """STATUTORY_CHARGES in the reference engine."""

    __tablename__ = "statutory_charges"

    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    segment: Mapped[str] = mapped_column(String(20), primary_key=True)
    product: Mapped[str] = mapped_column(String(20), primary_key=True)
    stt_buy_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stt_sell_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    exchange_txn_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    sebi_charges_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stamp_duty_buy_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stamp_duty_sell_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    gst_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    depository_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class StatutoryChargesBrokerOverridesRow(Base):
    """STATUTORY_CHARGES_BROKER_OVERRIDES in the reference engine."""

    __tablename__ = "statutory_charges_broker_overrides"

    broker_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    segment: Mapped[str] = mapped_column(String(20), primary_key=True)
    product: Mapped[str] = mapped_column(String(20), primary_key=True)
    stt_buy_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stt_sell_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    exchange_txn_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    sebi_charges_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stamp_duty_buy_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    stamp_duty_sell_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    gst_pct: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    depository_charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class EodPnlReportsRow(Base):
    """EOD_PNL_REPORTS in the reference engine."""

    __tablename__ = "eod_pnl_reports"

    trading_client_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("trading_clients.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    strategy_name: Mapped[str] = mapped_column(String(30), primary_key=True)
    product: Mapped[str] = mapped_column(String(50), primary_key=True)
    capital: Mapped[int | None] = mapped_column(Integer, nullable=True)
    profit_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    charges: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    net_profit_loss: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    is_paper_trading: Mapped[bool] = mapped_column(Boolean, primary_key=True)
    mtf_interest: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class AggregatedPnlSnapshotsRow(Base):
    """AGGREGATED_PNL_SNAPSHOTS in the reference engine."""

    __tablename__ = "aggregated_pnl_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    snapshot_date: Mapped[dt.date] = mapped_column(Date)
    snapshot_timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    total_algo_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_broker_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_capital: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_external_capital: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_utilized_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_paper_trading: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class ClientPnlSnapshotsRow(Base):
    """USER_PNL_SNAPSHOT in the reference engine."""

    __tablename__ = "client_pnl_snapshots"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    username: Mapped[str] = mapped_column(String(100))
    broker: Mapped[str] = mapped_column(String(50))
    snapshot_date: Mapped[dt.date] = mapped_column(Date)
    snapshot_timestamp: Mapped[int] = mapped_column(BigInteger)
    algo_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    broker_pnl: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    capital: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    total_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    utilized_margin: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    created_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_paper_trading: Mapped[bool | None] = mapped_column(Boolean, nullable=True)


class DailySymbolClosePricesRow(Base):
    """DAILY_SYMBOL_CLOSE_PRICES in the reference engine."""

    __tablename__ = "daily_symbol_close_prices"

    exchange: Mapped[str] = mapped_column(String(15), primary_key=True)
    trading_symbol: Mapped[str] = mapped_column(String(50), primary_key=True)
    close_date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    close_price: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    expiry_date: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    source: Mapped[str] = mapped_column(String(20))
    created_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AuditLogRow(Base):
    """AUDIT_LOG in the reference engine."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(50))
    entity_id: Mapped[str] = mapped_column(String(255))
    entity_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    action: Mapped[str] = mapped_column(String(20))
    old_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    new_data: Mapped[str | None] = mapped_column(Text, nullable=True)
    changed_by: Mapped[str] = mapped_column(String(100))
    changed_timestamp: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class AlertsRow(Base):
    """ALERTS in the reference engine."""

    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    timestamp: Mapped[str] = mapped_column(String(30))
    alert_level: Mapped[str | None] = mapped_column(String(10), nullable=True)
    entity_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    entity_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    operation: Mapped[str | None] = mapped_column(String(50), nullable=True)
    alert_message: Mapped[str | None] = mapped_column(Text, nullable=True)


class DataProviderSessionsRow(Base):
    """DATA_PROVIDER_SESSIONS in the reference engine."""

    __tablename__ = "data_provider_sessions"

    provider: Mapped[str] = mapped_column(String(20), primary_key=True)
    client_id: Mapped[str | None] = mapped_column(String(50), nullable=True)
    access_token: Mapped[str | None] = mapped_column(Text, nullable=True)
    last_updated: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RulesRow(Base):
    """RULES in the reference engine."""

    __tablename__ = "rules"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    exchange: Mapped[str | None] = mapped_column(String(10), nullable=True)
    name: Mapped[str | None] = mapped_column(String(30), nullable=True)
    symbol: Mapped[str | None] = mapped_column(String(20), nullable=True)
    breakout_level: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    breakout_level_dt0: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    breakout_level_dt1: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    breakout_level_dt2: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    breakout_direction: Mapped[str | None] = mapped_column(String(10), nullable=True)
    is_breakout_level_in_percentage: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    breakout_valid_range: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    from_timestamp: Mapped[str | None] = mapped_column(String(12), nullable=True)
    from_last_n_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)
    from_level: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class StrategyRulesMapRow(Base):
    """STRATEGY_RULES_MAP in the reference engine."""

    __tablename__ = "strategy_rules_map"

    strategy_name: Mapped[str] = mapped_column(String(50), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    cond: Mapped[str] = mapped_column(String(20), primary_key=True)
    rules_expr: Mapped[str | None] = mapped_column(String(100), nullable=True)
    depends_on_cond: Mapped[str | None] = mapped_column(String(20), nullable=True)
    tranches: Mapped[str] = mapped_column(String(100), primary_key=True)


class StrategyRulesOutputRow(Base):
    """STRATEGY_RULES_OUTPUT in the reference engine."""

    __tablename__ = "strategy_rules_output"

    strategy_name: Mapped[str] = mapped_column(String(50), primary_key=True)
    exchange: Mapped[str] = mapped_column(String(10), primary_key=True)
    tranches: Mapped[str] = mapped_column(String(100), primary_key=True)
    cond: Mapped[str] = mapped_column(String(20), primary_key=True)
    symbol_list: Mapped[str | None] = mapped_column(String(200), nullable=True)
    price_list: Mapped[str | None] = mapped_column(String(200), nullable=True)
    last_updated_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class IvCandlesRow(Base):
    """IV_DATA_1MIN in the reference engine."""

    __tablename__ = "iv_candles"

    symbol: Mapped[str] = mapped_column(String(25), primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    ce_iv_open: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    ce_iv_high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    ce_iv_low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    ce_iv_close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pe_iv_open: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pe_iv_high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pe_iv_low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pe_iv_close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    ce_strike: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pe_strike: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    spot_close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class PcrCandlesRow(Base):
    """PCR_DATA_1MIN in the reference engine."""

    __tablename__ = "pcr_candles"

    symbol: Mapped[str] = mapped_column(String(25), primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    pcr_open: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pcr_high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pcr_low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    pcr_close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    put_oi: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    call_oi: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class StraddleCandlesRow(Base):
    """STRADDLE_DATA_1MIN in the reference engine."""

    __tablename__ = "straddle_candles"

    symbol: Mapped[str] = mapped_column(String(25), primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)


class SyntheticCandlesRow(Base):
    """SYNTHETIC_DATA_1MIN in the reference engine."""

    __tablename__ = "synthetic_candles"

    symbol: Mapped[str] = mapped_column(String(25), primary_key=True)
    timestamp: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    open: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    high: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    low: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
    close: Mapped[Decimal | None] = mapped_column(Numeric(20, 6), nullable=True)
