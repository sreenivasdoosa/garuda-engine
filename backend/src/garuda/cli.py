"""The ``garuda`` command.

A server, not a library: this is the only entry point, and everything it does
is assemble the engine from configuration and hand control to the runner.

``garuda run`` starts the engine. ``garuda check`` builds it and reports what
it found without opening a socket or placing anything -- which is the command
to run at six in the morning to find out whose session has expired.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from garuda.brokers.routing import trading_client_factory
from garuda.brokers.sessions import Credentials, SessionResolver, SessionUnavailableError
from garuda.brokers.websocket import websocket_connector
from garuda.capital import CapitalLotAllocator, Sizer
from garuda.capital.event_days import EventDays
from garuda.composition.accounts import build_resolver, load_accounts, load_sessions
from garuda.composition.brokers import load_brokers
from garuda.composition.catalogues import CatalogueLoad, build_catalogue_loads
from garuda.composition.data_providers import (
    DataProviders,
    load_active_providers,
    load_data_providers,
)
from garuda.composition.derived_series import DerivedSeriesRecorder
from garuda.composition.engine import Engine, build_engine
from garuda.composition.event_days import load_event_days
from garuda.composition.instruments import SymbolBook, build_loader, load_symbols
from garuda.composition.protection import ProtectionBook, load_protection
from garuda.composition.risk import load_kill_switches, load_limits
from garuda.composition.runtime import Runtime, start
from garuda.composition.strategies import Loaded, load_strategies, validate_strategy
from garuda.composition.strategy_context import MarketView
from garuda.composition.strategy_loop import StrategyLoop, deliver_for
from garuda.composition.terminal import TerminalView
from garuda.composition.venues import Venues, load_venues
from garuda.composition.watchlist import Watchlist
from garuda.config.settings import Settings, load_settings
from garuda.core.clock import LiveClock
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId, canonical_symbol
from garuda.domain.symbol import SymbolInfo
from garuda.engine.signals import SignalFactory
from garuda.engine.strategy import StrategyRunner
from garuda.engine.tranches import TrancheLedger
from garuda.marketdata.loader import InstrumentLoader
from garuda.marketdata.providers.catalogues import CatalogueHolder
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.synthetics import (
    ImpliedVolatility,
    Synthetic,
    SyntheticPublisher,
    for_symbol,
    for_symbols,
)
from garuda.persistence.derived_bars import DerivedBarStore
from garuda.persistence.engine import create_engine, create_session_factory
from garuda.persistence.secrets import SecretBox
from garuda.persistence.seed import load_seed
from garuda.persistence.single_engine import SingleEngineLock
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.clock import Clock
from garuda.rms.killswitch import KillSwitch
from garuda.rms.scope import LimitBook

logger = logging.getLogger(__name__)

#: The only broker with an adapter today. When there is a second, this comes
#: from each account's own ``broker`` column instead.
DEFAULT_BROKER = "zerodha"

#: Used only when no venue is configured at all, which is a database that has
#: not been seeded rather than a running system.
FALLBACK_TIMEZONE = ZoneInfo("Asia/Kolkata")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="garuda", description="An algorithmic trading engine.")
    parser.add_argument("--log-level", default="INFO", help="Python logging level (default: INFO)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("run", help="Trade the day with no Console. `serve` runs both.")
    commands.add_parser("check", help="Build the engine and report, without connecting.")
    commands.add_parser("seed", help="Load reference data: venues, holidays, symbols, brokers.")
    serve = commands.add_parser("serve", help="Run the engine and the Console together.")
    serve.add_argument("--host", default=None, help="Interface to bind. Defaults to the setting.")
    serve.add_argument("--port", type=int, default=None, help="Port. Defaults to the setting.")
    serve.add_argument(
        "--reload",
        action="store_true",
        help="Serve the API alone, restarting on a source change. No engine, so no prices.",
    )

    args = parser.parse_args(argv)
    logging.basicConfig(
        level=args.log_level.upper(),
        format="%(asctime)s %(levelname)-8s %(name)s: %(message)s",
    )

    try:
        if args.command == "check":
            return asyncio.run(_check())
        if args.command == "seed":
            return asyncio.run(_seed())
        if args.command == "serve":
            return _serve(args.host, args.port, reload=args.reload)
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 130
    except DomainError as error:
        # Misconfiguration, not a crash. An operator needs the sentence, not
        # a stack trace through the composition root.
        print(f"garuda: {error}", file=sys.stderr)
        return 2


def _serve(host: str | None, port: int | None, *, reload: bool) -> int:
    """Run the engine and the API the Console talks to, in one process.

    One process because a tick has nowhere else to live. It exists in the hub
    for an instant and is never written anywhere a second process could read
    it in time, so an API served apart from the engine can show configuration
    and history and nothing that moves. That is the shape `DESIGN.md`
    specifies, and this is it.

    `--reload` is the exception: it re-imports the application in a child
    process on every edit, which no live engine can survive. It therefore
    serves the API alone, and says so.
    """
    settings = load_settings()
    if reload:
        return _serve_api_only(settings, host, port)
    return asyncio.run(_serve_with_engine(settings, host, port))


def _serve_api_only(settings: Settings, host: str | None, port: int | None) -> int:
    """The API on its own, reloading on every edit.

    For working on the Console. Nothing has prices: no engine is running, so
    the feed, the synthetics and the live socket are all absent.
    """
    import uvicorn

    logger.warning(
        "--reload serves the API alone: no engine, so no live prices, no socket and "
        "no derived series. Run `garuda serve` without it to trade."
    )
    uvicorn.run(
        "garuda.api:create_app",
        factory=True,
        host=host or settings.host,
        port=port or settings.port,
        reload=True,
        log_level="info",
    )
    return 0


async def _serve_with_engine(settings: Settings, host: str | None, port: int | None) -> int:
    """Build the engine, start the day, and serve the Console over it."""
    import uvicorn

    from garuda.api import create_app

    clock = LiveClock()
    assembled = await _build(settings, clock)

    # Taken before anything opens a socket or places anything. A second engine
    # on one database would read the same subscriptions and place the same
    # orders, and both would look correct doing it.
    lock = SingleEngineLock(assembled.database)
    await lock.acquire()

    runtime: Runtime | None = None
    try:
        runtime = await start(
            assembled.engine,
            resolver=assembled.resolver,
            loader=assembled.loader,
            connector=websocket_connector(),
            now=clock.now(),
            strategies=_strategy_loop(assembled, clock),
            catalogue_loads=assembled.catalogue_loads,
        )

        async def reload_sessions() -> None:
            """Re-read the trading clients, their sessions and the providers.

            A login in the Console writes rows; the engine's resolver and
            provider table are copies read at build. Swapping their contents
            is what lets the next feed connect carry the token issued a
            moment ago rather than the one the engine started with.
            """
            accounts = await load_accounts(assembled.sessions)
            broker_sessions = await load_sessions(assembled.sessions, assembled.secrets)
            assembled.resolver.replace(accounts, broker_sessions)
            assembled.providers.replace(
                await load_data_providers(assembled.sessions, assembled.secrets, assembled.resolver)
            )
            # And then whoever can trade now and could not at startup: an
            # account that just logged in, or was enabled, or whose broker was
            # unstopped on the Brokers page.
            if runtime is not None:
                admitted = await runtime.admit(clock.now(), await load_brokers(assembled.sessions))
                if admitted:
                    logger.info("engine now: %s", assembled.engine.describe())

        async def reload_strategies() -> None:
            """Re-read the strategy tables into the running loop.

            The loop reads its strategies on every sweep, so swapping them is
            the whole of taking effect: a strategy defined, a subscription
            made or paused in the Console is seen on the next pass.
            """
            loaded = await load_strategies(assembled.sessions)
            _report(loaded)
            if runtime is not None and runtime.strategies is not None:
                runtime.strategies.replace(loaded)

        async def reload_protection() -> None:
            """Re-read the Broker Config page into the engine's book.

            Every account's placement reads the book on each order, so
            swapping its contents is the whole of taking effect.
            """
            assembled.protection.replace(await load_protection(assembled.sessions))

        async def reload_limits() -> None:
            """Re-read the RMS Config page into the engine's book.

            Every account's gate resolves its limits from the book on each
            order, so swapping its rows is the whole of taking effect.
            """
            assembled.limits.replace((await load_limits(assembled.sessions)).rows)

        async def reload_kill_switches() -> None:
            """Re-read today's kill switches into the engine's book.

            The Kill Switches page is the operator's hand on the brake, and
            a brake that works after the next restart is not one.
            """
            loaded = await load_kill_switches(
                assembled.sessions, today=_trading_day(assembled.venues, clock.now())
            )
            assembled.kill_switch.replace(loaded.switches)

        async def reload_symbols() -> None:
            """Re-read the Symbols page into the engine's book.

            Everything that reads symbols reads the book, so swapping its
            contents is the whole of taking effect: the strategy loop notices
            the version change on its next sweep and rebuilds the derived
            series from it -- enabling one, and disabling one, without a
            restart.
            """
            assembled.symbols.replace(await load_symbols(assembled.sessions))

        server = uvicorn.Server(
            uvicorn.Config(
                create_app(
                    settings,
                    engine=assembled.engine,
                    reload_symbols=reload_symbols,
                    reload_sessions=reload_sessions,
                    reload_protection=reload_protection,
                    reload_strategies=reload_strategies,
                    reload_limits=reload_limits,
                    reload_kill_switches=reload_kill_switches,
                    validate_strategy=validate_strategy,
                    terminal_view=TerminalView(assembled.engine, clock),
                ),
                host=host or settings.host,
                port=port or settings.port,
                log_level="info",
            )
        )
        # The runner drives the venue's day; the server answers the Console.
        # Whichever finishes first brings the other down: a stopped engine
        # must not leave a Console that looks alive.
        running = asyncio.create_task(runtime.runner.run_forever(), name="runner")
        serving = asyncio.create_task(server.serve(), name="api")
        await asyncio.wait({running, serving}, return_when=asyncio.FIRST_COMPLETED)
        logger.info("stopping")
        server.should_exit = True
        with suppress(asyncio.CancelledError):
            await serving
        running.cancel()
    finally:
        if runtime is not None:
            # Unwinds through Runtime.stop rather than a cancelled task: the
            # last thing it does is write the book out.
            await runtime.stop()
        await lock.release()
    return 0


async def _build(settings: Settings, clock: Clock) -> _Assembled:
    """Everything both commands need, built once."""
    database = create_engine(settings.database)
    sessions = create_session_factory(database)
    secrets = SecretBox(settings.secret_key.get_secret_value())

    venues = await load_venues(sessions)
    resolver = await build_resolver(sessions, secrets, _timezone(venues))
    # A book rather than a snapshot: the Symbols page can swap its contents
    # while the engine runs, and everything holding it sees the change.
    symbols = SymbolBook(await load_symbols(sessions))
    loader = build_loader(
        broker=DEFAULT_BROKER,
        directory=Path(settings.app_home) / "instruments",
        exchanges=venues.exchanges,
        symbols=symbols,
        timezone=_timezone(venues),
        clock=clock,
        http=trading_client_factory(None),
    )
    limits = await load_limits(sessions)
    event_days = await load_event_days(sessions)
    active_ticker, active_history = await load_active_providers(sessions)
    providers = await load_data_providers(sessions, secrets, resolver)
    brokers = await load_brokers(sessions)
    # Swapped whole when the Broker Config page writes; see reload_protection.
    protection = ProtectionBook(await load_protection(sessions))
    # Loaded at DAY_INIT, empty until then. The holder is built here rather
    # than inside the engine so the same one is both read by the adapters and
    # written by the day's tasks.
    catalogues = CatalogueHolder()
    catalogue_loads = build_catalogue_loads(
        providers=providers.configured,
        directory=Path(settings.app_home) / "instruments",
        timezone=_timezone(venues),
        clock=clock,
        http=trading_client_factory(None),
    )
    # The venue's day, not the server's: a switch set on Tuesday evening in
    # one timezone must not still be stopping Wednesday in another.
    stopped = await load_kill_switches(sessions, today=_trading_day(venues, clock.now()))
    engine = build_engine(
        sessions=sessions,
        resolver=resolver,
        venues=venues,
        clock=clock,
        now=clock.now(),
        connector=websocket_connector(),
        limits=limits,
        kill_switch=stopped,
        active_ticker=active_ticker,
        active_history=active_history,
        data_providers=providers,
        catalogues=catalogues,
        master_broker=DEFAULT_BROKER,
        brokers=brokers,
        protection=protection,
    )
    strategies = await load_strategies(sessions)
    _report(strategies)
    try:
        market_data = resolver.market_data_credentials(clock.now())
    except SessionUnavailableError:
        market_data = None

    return _Assembled(
        engine=engine,
        venues=venues,
        loader=loader,
        resolver=resolver,
        secrets=secrets,
        protection=protection,
        limits=limits,
        kill_switch=stopped,
        symbols=symbols,
        strategies=strategies,
        market_data=market_data,
        event_days=event_days,
        sessions=sessions,
        database=database,
        providers=providers,
        catalogue_loads=catalogue_loads,
    )


@dataclass(frozen=True)
class _Assembled:
    """Everything both commands build, kept together rather than positional."""

    engine: Engine
    venues: Venues
    loader: InstrumentLoader
    resolver: SessionResolver
    #: What opens every stored credential, kept so a login made while the
    #: engine runs can be read the same way the ones at startup were.
    secrets: SecretBox
    #: Order protection per broker and venue, the book every account reads.
    protection: ProtectionBook
    #: The risk limits and the kill switches, the books every account's gate
    #: reads. Swapped whole when their Console pages write.
    limits: LimitBook
    kill_switch: KillSwitch
    symbols: SymbolBook
    strategies: Loaded
    #: Whose session fetches history, when one is nominated.
    market_data: Credentials | None
    #: Dates the operator wants traded at reduced size, and any strategy that
    #: differs. Empty means every date is full size.
    event_days: EventDays
    #: How anything below opens its own transaction. Carried here because the
    #: engine deliberately does not hold it: the stores do.
    sessions: async_sessionmaker[AsyncSession]
    #: The connection pool itself, for the one thing that needs a connection of
    #: its own rather than a transaction: the lock saying this process is the
    #: engine.
    database: AsyncEngine
    #: The Data Providers page's rows, resolved. Empty on an install that has
    #: not filled the page in, which falls back to the nominated client.
    providers: DataProviders
    #: How to load each configured provider's translation table, registered at
    #: DAY_INIT beside the instrument master.
    catalogue_loads: Mapping[str, CatalogueLoad]


def _report(strategies: Loaded) -> None:
    logger.info(
        "%d strategies loaded, %d subscriptions, %d strategies left out",
        len(strategies.strategies),
        len(strategies.subscriptions),
        len(strategies.refused),
    )
    for name, why in sorted(strategies.refused.items()):
        logger.warning("%s will not be traded: %s", name, why)


def _trading_day(venues: Venues, now: datetime) -> date:
    """Which session a kill switch belongs to, on the venue's own clock."""
    exchanges = venues.all
    if exchanges:
        return exchanges[0].trading_day_for(now)
    return now.astimezone(FALLBACK_TIMEZONE).date()


def _timezone(venues: Venues) -> ZoneInfo:
    """The timezone sessions are aged against.

    One venue's, because a broker session expires on the broker's clock and
    every account here belongs to one market. A second market means a second
    resolver, not a second guess at which timezone this is.
    """
    exchanges = venues.all
    return exchanges[0].timezone if exchanges else FALLBACK_TIMEZONE


async def _check() -> int:
    """Build everything and say what it found. Places nothing."""
    settings = load_settings()
    clock = LiveClock()
    assembled = await _build(settings, clock)
    engine = assembled.engine
    parts = engine.parts

    print(engine.describe())
    for client in sorted(parts.clients.values(), key=lambda c: c.account.label):
        print(f"  ready   {client.account.label}")
    for client_id, reason in sorted(parts.unavailable.items()):
        account = parts.accounts.get(client_id)
        print(f"  waiting {account.label if account else client_id.value}: {reason}")

    ready = len(assembled.strategies.subscriptions)
    print(f"  {ready} subscription(s) will look for an entry")
    for name, why in sorted(assembled.strategies.refused.items()):
        print(f"  left out {name}: {why}")

    # A configured engine with nothing able to trade is not an error -- nobody
    # has logged in yet at dawn -- but it is worth a non-zero exit so a health
    # check notices.
    return 0 if parts.clients else 1


async def _seed() -> int:
    """Load the reference data an engine cannot start without.

    Idempotent: every file upserts, so running it after an upgrade takes new
    venues and holidays without disturbing anything an operator has edited by
    hand.
    """
    settings = load_settings()
    sessions = create_session_factory(create_engine(settings.database))
    async with UnitOfWork(sessions) as uow:
        result = await load_seed(uow.repositories)
    for name, count in sorted(result.loaded.items()):
        print(f"  {count:>6}  {name}")
    if result.skipped:
        print(f"  nothing to load for: {', '.join(sorted(result.skipped))}")
    print(f"{result.total} rows")
    return 0


def _strategy_loop(assembled: _Assembled, clock: Clock) -> StrategyLoop | None:
    """The loop that sweeps the day.

    It looks for entries, but that is not all it does: it also keeps the feed
    subscribed to what should be quoted, and prices the derived series. Both
    of those belong to the Console rather than to any strategy, so the loop
    runs when there is *anything* to do -- an index to watch or a series to
    derive is enough.

    Building it only when something was subscribed is what left the Live Feed
    blank on an engine that was otherwise healthy: no loop, so no watchlist, so
    the feed connected with nothing to quote.

    None when there is genuinely nothing: the engine still runs, still manages
    whatever is already on, and still squares off on time.
    """
    engine = assembled.engine
    watchlist = _watchlist(assembled)
    derived = _derived(assembled, clock)
    # `configured_indices`, not `indices`: this runs before the instrument
    # master has loaded, when nothing resolves yet. The question is whether
    # the operator has curated any, not whether today's master lists them.
    if (
        not assembled.strategies.subscriptions
        and not watchlist.configured_indices()
        and derived is None
    ):
        # Built anyway: a subscription made in the Console while the engine
        # runs needs a loop to land in, and an idle sweep costs nothing.
        logger.info("nothing subscribed, no index curated and no series configured yet")
    venues = assembled.venues.all
    if not venues:
        logger.warning("no venue is configured, so no strategy can be evaluated")
        return None
    venue = venues[0]

    broker = next(iter(engine.parts.accounts.values())).broker if engine.parts.accounts else ""

    def registry() -> InstrumentRegistry:
        return engine.parts.instruments.for_broker(broker)

    def instrument(instrument_id: InstrumentId) -> Instrument | None:
        return registry().get(instrument_id)

    market = MarketView(
        hub=engine.parts.hub,
        registry=registry,
        symbols=assembled.symbols,
        timezone=venue.timezone,
        # The engine's, not one of its own: a strategy trailing by SuperTrend
        # and a rule testing SuperTrend must see the same bars.
        candles=engine.parts.candles,
    )

    async def deliver(batch: object) -> bool:
        return await deliver_for(engine, batch)  # type: ignore[arg-type]

    factory = SignalFactory(
        Sizer(CapitalLotAllocator()),
        instrument,
        engine.parts.hub.latest,
        event_days=assembled.event_days,
    )
    # One ledger, shared. Two would let the loop think a tranche was open
    # while the runner had already fired it, and it would enter every sweep.
    ledger = TrancheLedger(venue.trading_day_for(clock.now()))
    return StrategyLoop(
        engine=engine,
        loaded=assembled.strategies,
        market=market,
        venue=venue,
        clock=clock,
        alerts=engine.parts.alerts,
        runner=StrategyRunner(factory=factory, deliver=deliver, ledger=ledger),
        ledger=ledger,
        watchlist=watchlist,
        synthetics=SyntheticPublisher(sources=_synthetics(assembled)),
        derived=derived,
        symbols=assembled.symbols,
    )


def _watchlist(assembled: _Assembled) -> Watchlist:
    return Watchlist(
        hub=assembled.engine.parts.hub,
        symbols=assembled.symbols,
        # Venues holds only what is switched on, so this is already the enabled
        # set rather than every exchange the engine knows.
        exchanges=frozenset(assembled.venues.exchanges),
    )


def _derived(assembled: _Assembled, clock: Clock) -> DerivedSeriesRecorder | None:
    """Somewhere to keep the series, when any symbol asked for one.

    None when nothing is configured, so an install that has not switched any
    of this on runs exactly as it did before: no folding, no writes, no table
    growing in the background.
    """
    configured = _configured(assembled)
    if not configured:
        return None
    # The skew extends _AtTheMoney rather than ImpliedVolatility, so this
    # picks up the level series only -- which is the one that can answer for
    # both legs at once.
    volatility = tuple(
        (underlying, source)
        for underlying, info in configured.items()
        for source in for_symbol(underlying, info)
        if isinstance(source, ImpliedVolatility)
    )

    def opened_today(symbol: str) -> datetime | None:
        """The open of the session this instant falls in, on this symbol's venue.

        Per symbol rather than one window for everything: MCX trades until
        half past eleven at night and NSE closes at half past three, so a
        single venue's session drops a commodity's whole evening.

        **The session containing `now`, not the engine's trading day.** After
        a venue closes, the trading day rolls to the next one -- correctly, for
        deciding what to trade -- and a window from tomorrow makes every bar
        recorded this evening "before the open". That is what silently stopped
        every series from being stored the moment the first venue shut.

        Yesterday is considered too, for a session that began before midnight.
        None when nothing matches, which stores the bar: the guard exists to
        keep indicative pre-open prices out, not to arbitrate what may be kept.
        """
        info = assembled.symbols.get(symbol)
        if info is None:
            return None
        venue = assembled.venues.exchanges.get(info.exchange_code)
        if venue is None:
            return None

        now = clock.now()
        local = now.astimezone(venue.timezone).date()
        starts = [
            window.start
            for day in (local, local - timedelta(days=1))
            for window in venue.calendar.windows_on(day)
            if window.start <= now
        ]
        return max(starts) if starts else None

    return DerivedSeriesRecorder(
        store=DerivedBarStore(assembled.sessions),
        timezone=_timezone(assembled.venues),
        volatility=volatility,
        session_start=opened_today,
    )


def _synthetics(assembled: _Assembled) -> tuple[Synthetic, ...]:
    """The series maintained, as the Symbols page asks for them.

    Declared by what is *curated* rather than by what is subscribed. Both are
    defensible and this is the one the Console needs: these series are charted
    and stored whether or not a strategy happens to trade the underlying
    today, and an operator watching the NIFTY straddle should not have to
    create a subscription to see it.

    The cost that made the old rule attractive is paid by the flags instead --
    an underlying with none set contributes nothing and walks no chain.
    """
    return for_symbols(_configured(assembled))


def _configured(assembled: _Assembled) -> dict[InstrumentId, SymbolInfo]:
    """Curated underlyings that asked for at least one derived series."""
    return {
        InstrumentId(f"{info.exchange_code}:{canonical_symbol(info.symbol)}"): info
        for info in sorted(assembled.symbols.values(), key=lambda i: i.symbol)
        if info.derives_anything
    }


async def _run() -> int:
    """The engine with no HTTP surface.

    `serve` is what an operator runs; this is the same engine without the
    Console, for a box that is driven entirely from the database. It takes the
    same lock, so running both is refused rather than silently doubling every
    order.
    """
    settings = load_settings()
    clock = LiveClock()
    assembled = await _build(settings, clock)

    lock = SingleEngineLock(assembled.database)
    await lock.acquire()

    runtime = await start(
        assembled.engine,
        resolver=assembled.resolver,
        loader=assembled.loader,
        connector=websocket_connector(),
        now=clock.now(),
        strategies=_strategy_loop(assembled, clock),
        catalogue_loads=assembled.catalogue_loads,
    )
    try:
        await _run_until_signalled(runtime)
    finally:
        await lock.release()
    return 0


async def _run_until_signalled(runtime: Runtime) -> None:
    """Run the day, and stop cleanly when asked.

    A stop must unwind through :meth:`Runtime.stop` rather than through a
    cancelled task, because the last thing it does is write the book out.
    """
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    for received in (signal.SIGINT, signal.SIGTERM):
        # Windows has no signal handlers on the event loop. Ctrl-C still raises
        # KeyboardInterrupt there, which main() catches.
        with suppress(NotImplementedError):
            loop.add_signal_handler(received, stopping.set)

    running = asyncio.create_task(runtime.runner.run_forever(), name="runner")
    waiting = asyncio.create_task(stopping.wait(), name="signal")
    await asyncio.wait({running, waiting}, return_when=asyncio.FIRST_COMPLETED)
    logger.info("stopping")
    await runtime.stop()
    running.cancel()


if __name__ == "__main__":
    sys.exit(main())
