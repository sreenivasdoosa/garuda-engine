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
from contextlib import suppress
from pathlib import Path
from zoneinfo import ZoneInfo

from garuda.brokers.routing import trading_client_factory
from garuda.brokers.sessions import SessionResolver
from garuda.brokers.websocket import websocket_connector
from garuda.composition.accounts import build_resolver
from garuda.composition.engine import Engine, build_engine
from garuda.composition.instruments import build_loader, load_symbols
from garuda.composition.runtime import Runtime, start
from garuda.composition.venues import Venues, load_venues
from garuda.config.settings import Settings, load_settings
from garuda.core.clock import LiveClock
from garuda.domain.errors import DomainError
from garuda.marketdata.loader import InstrumentLoader
from garuda.persistence.engine import create_engine, create_session_factory
from garuda.persistence.secrets import SecretBox
from garuda.persistence.seed import load_seed
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.clock import Clock

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
    commands.add_parser("run", help="Start the engine and trade the day.")
    commands.add_parser("check", help="Build the engine and report, without connecting.")
    commands.add_parser("seed", help="Load reference data: venues, holidays, symbols, brokers.")

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
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 130
    except DomainError as error:
        # Misconfiguration, not a crash. An operator needs the sentence, not
        # a stack trace through the composition root.
        print(f"garuda: {error}", file=sys.stderr)
        return 2


async def _build(
    settings: Settings, clock: Clock
) -> tuple[Engine, Venues, InstrumentLoader, SessionResolver]:
    """Everything both commands need, built once."""
    database = create_engine(settings.database)
    sessions = create_session_factory(database)
    secrets = SecretBox(settings.secret_key.get_secret_value())

    venues = await load_venues(sessions)
    resolver = await build_resolver(sessions, secrets, _timezone(venues))
    symbols = await load_symbols(sessions)
    loader = build_loader(
        broker=DEFAULT_BROKER,
        directory=Path(settings.app_home) / "instruments",
        exchanges=venues.exchanges,
        symbols=symbols,
        timezone=_timezone(venues),
        clock=clock,
        http=trading_client_factory(None),
    )
    engine = build_engine(
        sessions=sessions,
        resolver=resolver,
        venues=venues,
        clock=clock,
        now=clock.now(),
        connector=websocket_connector(),
    )
    return engine, venues, loader, resolver


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
    engine, _, _, _ = await _build(settings, clock)
    parts = engine.parts

    print(engine.describe())
    for client in sorted(parts.clients.values(), key=lambda c: c.account.label):
        print(f"  ready   {client.account.label}")
    for client_id, reason in sorted(parts.unavailable.items()):
        account = parts.accounts.get(client_id)
        print(f"  waiting {account.label if account else client_id.value}: {reason}")

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


async def _run() -> int:
    settings = load_settings()
    clock = LiveClock()
    engine, _, loader, resolver = await _build(settings, clock)

    runtime = await start(
        engine,
        resolver=resolver,
        loader=loader,
        connector=websocket_connector(),
        now=clock.now(),
    )
    await _run_until_signalled(runtime)
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
