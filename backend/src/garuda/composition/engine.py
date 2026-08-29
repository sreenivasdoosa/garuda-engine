"""Assembling a running engine.

One function builds everything and returns the pieces the process needs to
start and stop it. It reads as a list because that is what it is: there is no
cleverness here, and there should not be -- a composition root that decides
things is one nobody can read.

The order is forced by what depends on what. Alerts before anything that might
need to report; venues before a runner that schedules by them; the market data
account before the feed that borrows its session; and each trading client's own
session before the broker, the book and the loop built on it.

**An account that cannot be built does not stop the others.** An operator with
five accounts and one expired session should trade on four. Each refusal is
recorded by name in :attr:`EngineParts.unavailable` and the rest are assembled.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.alerts.manager import AlertManager
from garuda.brokers.routing import trading_client_factory
from garuda.brokers.sessions import (
    Account,
    Credentials,
    SessionResolver,
    SessionUnavailableError,
)
from garuda.brokers.websocket import Connector
from garuda.brokers.zerodha.account import ZerodhaAccountStream
from garuda.brokers.zerodha.broker import ZerodhaBroker
from garuda.brokers.zerodha.feed import ZerodhaFeed
from garuda.brokers.zerodha.rest import KiteClient
from garuda.composition.venues import Venues
from garuda.core.bus import InProcessEventBus
from garuda.core.runner import TaskRegistry
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import PriceBand, Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId
from garuda.domain.trade import Trade
from garuda.marketdata.hub import TickHub
from garuda.marketdata.loader import InstrumentRegistryHolder
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.service import MarketDataService
from garuda.marketdata.supervisor import FeedSupervisor
from garuda.persistence.trade_store import TradeStore
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.account import AccountStream
from garuda.protocols.clock import Clock
from garuda.protocols.feed import MarketDataFeed
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.coordination import LegCoordinator
from garuda.trademgmt.entry import EntryService
from garuda.trademgmt.loop import TradeLoop, TradeLoops
from garuda.trademgmt.protective import ProtectiveOrderService
from garuda.trademgmt.squareoff import SquareOffService
from garuda.trademgmt.squareoff_rules import ExitWindow
from garuda.trademgmt.tracking import TradeTracker
from garuda.trademgmt.trailing import TrailingService
from garuda.trademgmt.trailing_rules import TrailConfig

logger = logging.getLogger(__name__)

#: The widest gap a strategy's stop may sit from the entry, where nothing
#: configures the venue's own. Belongs beside the other per-segment limits;
#: a number here is better than no cap at all, which is what None would mean.
DEFAULT_SEGMENT_GAP = Decimal(18)

type TrailConfigLookup = Callable[[Trade], TrailConfig | None]


@dataclass
class ClientParts:
    """Everything built for one trading client."""

    account: Account
    broker: ZerodhaBroker
    book: TradingClientManager
    tracker: TradeTracker
    entry: EntryService
    protection: ProtectiveOrderService
    trailing: TrailingService
    square_off: SquareOffService
    coordinator: LegCoordinator
    loop: TradeLoop
    store: TradeStore


@dataclass
class EngineParts:
    """What a running engine is made of, once assembled."""

    alerts: AlertManager
    bus: InProcessEventBus
    venues: Venues
    instruments: InstrumentRegistryHolder
    #: Where every price the engine has seen lives. Shared, because a price is
    #: a fact about the market and not about an account.
    hub: TickHub
    registry: TaskRegistry
    clock: Clock
    market_data: MarketDataService | None = None
    clients: dict[TradingClientId, ClientParts] = field(default_factory=dict)
    loops: TradeLoops | None = None
    #: Every configured account, trading or not, so that one which cannot
    #: trade can still be reported by name rather than by id.
    accounts: dict[TradingClientId, Account] = field(default_factory=dict)
    #: Accounts that could not be built, and why. Not an error: an operator
    #: with five accounts and one expired session trades on four, and at six in
    #: the morning nobody has logged in yet.
    unavailable: dict[TradingClientId, str] = field(default_factory=dict)

    @property
    def exchanges(self) -> Sequence[Exchange]:
        return self.venues.all


class Engine:
    """A built engine: every part constructed, nothing started."""

    def __init__(self, parts: EngineParts) -> None:
        self.parts = parts

    @property
    def loops(self) -> TradeLoops:
        """Every client's trade loop, as one thing to start and stop."""
        assert self.parts.loops is not None
        return self.parts.loops

    def client(self, trading_client: TradingClientId) -> ClientParts | None:
        return self.parts.clients.get(trading_client)

    def describe(self) -> str:
        """One line an operator can read in the log on startup."""
        ready = ", ".join(sorted(c.account.label for c in self.parts.clients.values())) or "none"
        return (
            f"{len(self.parts.venues.exchanges)} venues, "
            f"market data {'on' if self.parts.market_data else 'OFF'}, "
            f"trading: {ready}"
        )


def build_engine(
    *,
    sessions: async_sessionmaker[AsyncSession],
    resolver: SessionResolver,
    venues: Venues,
    clock: Clock,
    now: datetime,
    connector: Connector,
    trail_config: TrailConfigLookup | None = None,
) -> Engine:
    """Build every part the current configuration allows.

    Nothing is started and nothing is scheduled. The caller registers phase
    tasks on :attr:`EngineParts.registry` and hands it to the runner, which
    decides when each thing happens.
    """
    bus = InProcessEventBus()
    alerts = _build_alerts(sessions, bus, clock, venues)
    instruments = InstrumentRegistryHolder()
    hub = TickHub(bus, clock)

    parts = EngineParts(
        alerts=alerts,
        bus=bus,
        venues=venues,
        instruments=instruments,
        hub=hub,
        registry=TaskRegistry(),
        clock=clock,
    )
    parts.market_data = _build_market_data(resolver, instruments, hub, clock, now, connector)

    for account in resolver.accounts:
        parts.accounts[account.id] = account
        refusal = _why_not(account, resolver, now)
        if refusal is not None:
            parts.unavailable[account.id] = refusal
            logger.info("%s cannot trade yet: %s", account.label, refusal)
            continue
        credentials = resolver.credentials_for(account.id, now)
        parts.clients[account.id] = _build_client(
            account, credentials, sessions, instruments, hub, venues, alerts, clock, trail_config
        )

    loops = TradeLoops(clock, alerts)
    for built in parts.clients.values():
        loops.add(built.loop)
    parts.loops = loops

    engine = Engine(parts)
    logger.info("engine built: %s", engine.describe())
    return engine


def _why_not(account: Account, resolver: SessionResolver, now: datetime) -> str | None:
    """Why this account cannot trade today, or None when it can."""
    if not account.enabled:
        return "the account is disabled"
    try:
        resolver.credentials_for(account.id, now)
    except SessionUnavailableError as error:
        return str(error)
    return None


# -- the pieces -------------------------------------------------------------


def _build_alerts(
    sessions: async_sessionmaker[AsyncSession],
    bus: InProcessEventBus,
    clock: Clock,
    venues: Venues,
) -> AlertManager:
    """Alerts first, so that everything built after it can report."""

    async def store(alert: Alert) -> None:
        async with UnitOfWork(sessions) as uow:
            await uow.repositories.alerts.record(alert)

    exchanges = venues.all
    reference = exchanges[0] if exchanges else None

    def trading_day_for(moment: datetime) -> date:
        # Alerts are filed against a trading day so that a night's worth of
        # them coalesce into one row. Which venue's day hardly matters -- what
        # matters is that the answer is the same all night.
        if reference is None:
            return moment.date()
        return reference.trading_day_for(moment)

    return AlertManager(clock=clock, bus=bus, trading_day_for=trading_day_for, sink=store)


def _build_market_data(
    resolver: SessionResolver,
    instruments: InstrumentRegistryHolder,
    hub: TickHub,
    clock: Clock,
    now: datetime,
    connector: Connector,
) -> MarketDataService | None:
    """The feed, on whichever account the operator nominated for it.

    None when no account is nominated or the nominated one has not logged in.
    That is a real state rather than a failure to build: the engine still
    starts, and the operator is told plainly that nothing has prices.
    """
    try:
        credentials = resolver.market_data_credentials(now)
    except SessionUnavailableError as error:
        logger.warning("no market data: %s", error)
        return None

    registry = _registry_for(instruments, credentials.broker)

    async def open_feed() -> MarketDataFeed:
        return ZerodhaFeed(
            credentials.api_key, credentials.access_token, registry, clock, connector
        )

    return MarketDataService(hub, FeedSupervisor(hub, open_feed, clock), clock)


def _build_client(
    account: Account,
    credentials: Credentials,
    sessions: async_sessionmaker[AsyncSession],
    instruments: InstrumentRegistryHolder,
    hub: TickHub,
    venues: Venues,
    alerts: AlertManager,
    clock: Clock,
    trail_config: TrailConfigLookup | None,
) -> ClientParts:
    """One account's broker, its book, and everything that acts on them."""
    http = trading_client_factory(credentials.static_ip)
    kite = KiteClient(credentials.api_key, credentials.access_token, http)
    registry = _registry_for(instruments, account.broker)
    broker = ZerodhaBroker(account.id, kite, registry)

    def instrument(instrument_id: InstrumentId) -> Instrument | None:
        return registry().get(instrument_id)

    def last_tick(instrument_id: InstrumentId) -> Tick | None:
        """The latest price the feed carried. Shared across every account."""
        return hub.latest(instrument_id)

    def price_band(instrument_id: InstrumentId) -> PriceBand | None:  # noqa: ARG001
        """The day's circuit limits, once something supplies them.

        Nothing does yet -- they come from the quotes API, which is not built.
        Until it is, every limit target defers rather than being sent at a
        price the exchange may refuse, which is the safe direction to be
        wrong in.
        """
        return None

    def exit_window(trade: Trade) -> ExitWindow | None:
        return _venue_window(trade, registry(), venues, clock.now())

    def intraday_cutoff(trade: Trade) -> datetime | None:
        return _venue_cutoff(trade, registry(), venues, clock.now())

    def is_expiry_day(trade: Trade) -> bool:
        held = registry().get(trade.instrument)
        if held is None or held.expiry is None:
            return False
        return held.expiry == held.exchange.trading_day_for(clock.now())

    async def find_placed(client_order_id: ClientOrderId) -> BrokerOrderId | None:
        """Which broker order carries our tag, when placement lost its answer.

        The reference engine recovers by tag rather than retrying blind: a
        placement whose response was lost may well have reached the exchange,
        and a second attempt would double the position.
        """
        for order in await broker.fetch_orders():
            if order.client_order_id == client_order_id:
                return order.broker_order_id
        return None

    book = TradingClientManager(account.id, account.label, instrument, alerts)
    tracker = TradeTracker(book, broker.cancel, clock, alerts)
    protection = ProtectiveOrderService(
        book,
        broker.place,
        instrument,
        last_tick,
        price_band,
        _segment_gap,
        clock,
        alerts,
    )
    square_off = SquareOffService(
        book,
        protection,
        broker.cancel,
        instrument,
        last_tick,
        exit_window,
        is_expiry_day,
        clock,
        alerts,
    )

    async def place_replacement_stop(trade: Trade) -> BrokerOrderId | None:
        """A fresh stop, for when the broker will not modify the standing one."""
        result = await protection.place_stop(trade)
        return result.order_id

    coordinator = LegCoordinator(book, square_off.request, alerts)
    return ClientParts(
        account=account,
        broker=broker,
        book=book,
        tracker=tracker,
        entry=EntryService(
            book,
            broker.place,
            find_placed,
            instrument,
            clock,
            alerts,
        ),
        protection=protection,
        trailing=TrailingService(
            book,
            broker.modify,
            broker.cancel,
            place_replacement_stop,
            instrument,
            trail_config or _no_trailing,
            alerts,
        ),
        square_off=square_off,
        coordinator=coordinator,
        loop=TradeLoop(
            book,
            tracker,
            coordinator,
            square_off,
            broker.fetch_orders,
            intraday_cutoff,
            clock,
            alerts,
        ),
        store=TradeStore(sessions, alerts, label=account.label),
    )


def _segment_gap(trade: Trade) -> Decimal:  # noqa: ARG001
    """The venue's widest permitted stop gap. One number until there are rows."""
    return DEFAULT_SEGMENT_GAP


def _no_trailing(trade: Trade) -> TrailConfig | None:  # noqa: ARG001
    """No trailing until a strategy's configuration says otherwise.

    A stop that never moves is the conservative answer: trailing one on a
    guess would tighten a stop nobody asked to tighten.
    """
    return None


def _registry_for(
    instruments: InstrumentRegistryHolder, broker: str
) -> Callable[[], InstrumentRegistry]:
    """Read the broker's registry each time rather than capturing one.

    It is replaced whole every morning, and a captured reference would resolve
    yesterday's strikes for the rest of the day.
    """

    def current() -> InstrumentRegistry:
        return instruments.for_broker(broker)

    return current


def _venue_window(
    trade: Trade, registry: InstrumentRegistry, venues: Venues, now: datetime
) -> ExitWindow | None:
    held = registry.get(trade.instrument)
    if held is None:
        return None
    exchange = venues.exchanges.get(held.exchange.code)
    if exchange is None:
        return None
    return venues.exit_window(exchange, exchange.trading_day_for(now))


def _venue_cutoff(
    trade: Trade, registry: InstrumentRegistry, venues: Venues, now: datetime
) -> datetime | None:
    held = registry.get(trade.instrument)
    if held is None:
        return None
    exchange = venues.exchanges.get(held.exchange.code)
    if exchange is None:
        return None
    return venues.intraday_cutoff(exchange, exchange.trading_day_for(now))


def build_account_stream(
    credentials: Credentials,
    instruments: InstrumentRegistryHolder,
    clock: Clock,
    connector: Connector,
) -> AccountStream:
    """One account's order-update channel, on its own session."""
    return ZerodhaAccountStream(
        credentials.trading_client,
        credentials.api_key,
        credentials.access_token,
        _registry_for(instruments, credentials.broker),
        clock,
        connector,
    )
