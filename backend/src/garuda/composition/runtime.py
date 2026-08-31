"""Turning a built engine into a running one.

:mod:`garuda.composition.engine` constructs the parts. This starts them: it
subscribes the entry services to the tick stream, opens each account's order
channel, registers the tasks a venue's day is made of, and runs the loops.

The split matters for tests. A built engine can be inspected without a socket
being opened or a clock advancing; only this module needs either.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime

from garuda.brokers.sessions import Credentials, SessionResolver
from garuda.brokers.streams import AccountStreamManager, UpdateHandler
from garuda.brokers.websocket import Connector
from garuda.composition.engine import Engine, build_account_stream
from garuda.composition.persistence import TradePersistence
from garuda.composition.strategy_loop import StrategyLoop
from garuda.core.runner import EngineRunner, InMemoryPhaseRecorder
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.market import Tick
from garuda.marketdata.loader import InstrumentLoader
from garuda.marketdata.tasks import register_feed_lifecycle, register_instrument_load
from garuda.protocols.account import AccountEvent, AccountStream, OrderUpdate
from garuda.protocols.topics import Topic
from garuda.trademgmt.tasks import register_trade_loops

logger = logging.getLogger(__name__)


@dataclass
class Runtime:
    """A started engine, and everything that has to be stopped again."""

    engine: Engine
    runner: EngineRunner
    streams: AccountStreamManager
    persistence: dict[TradingClientId, TradePersistence] = field(default_factory=dict)
    #: The strategies, once there are any subscribed. None means nothing is
    #: looking for an entry — which is a state, not a fault.
    strategies: StrategyLoop | None = None
    _tasks: list[asyncio.Task[None]] = field(default_factory=list)

    async def stop(self) -> None:
        """Stop everything, in the reverse of the order it started.

        Order matters at the end as much as at the beginning: the loops stop
        placing before the streams that inform them close, and the books are
        written out last so the final state reaches disk.
        """
        self.runner.stop()
        if self.strategies is not None:
            # First: nothing new should go on while everything else is coming
            # down.
            self.strategies.stop()
        await _quietly("the trade loops", self.engine.loops.stop())
        await _quietly("the account streams", self.streams.stop())
        market_data = self.engine.parts.market_data
        if market_data is not None:
            await _quietly("market data", market_data.stop())

        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            with suppress(asyncio.CancelledError):
                await task

        # Last, and every one of them: a book that did not reach disk is a
        # position the engine will not know it holds tomorrow, so one account
        # failing to write must not cost the others their final state.
        for keeper in self.persistence.values():
            keeper.stop()
            await _quietly(f"the final save for {keeper.book.label}", keeper.flush())
        logger.info("engine stopped")


async def start(
    engine: Engine,
    *,
    resolver: SessionResolver,
    loader: InstrumentLoader | None,
    connector: Connector,
    now: datetime,
    strategies: StrategyLoop | None = None,
) -> Runtime:
    """Restore the books, open the channels, and register the day's tasks."""
    parts = engine.parts
    persistence = {
        client_id: TradePersistence(client.book, client.store, parts.clock)
        for client_id, client in parts.clients.items()
    }
    for client_id, keeper in persistence.items():
        trades, signals = await keeper.restore()
        logger.info(
            "%s: restored %d trades and %d signals",
            parts.clients[client_id].account.label,
            trades,
            signals,
        )

    streams = _account_streams(engine, resolver, connector)
    report = await streams.start(now)
    if not report.any_started and parts.clients:
        await parts.alerts.warning(
            EntityType.SYSTEM,
            "order updates",
            "account-stream",
            "no account opened an order-update channel. Fills will only be seen "
            "by the trade loop's own polling, which is slower.",
            key="account-streams-none",
        )

    _register_tasks(engine, loader)
    runner = EngineRunner(
        parts.exchanges,
        parts.clock,
        parts.registry,
        InMemoryPhaseRecorder(),
        offsets=dict(parts.venues.offsets),
    )

    runtime = Runtime(
        engine=engine,
        runner=runner,
        streams=streams,
        persistence=persistence,
        strategies=strategies,
    )
    runtime._tasks = [
        asyncio.create_task(_fan_out_ticks(engine), name="ticks"),
        *(
            [asyncio.create_task(strategies.run_forever(), name="strategies")]
            if strategies is not None
            else []
        ),
        *(
            asyncio.create_task(keeper.run_forever(), name=f"persist:{client_id.value}")
            for client_id, keeper in persistence.items()
        ),
    ]
    if strategies is None:
        logger.warning(
            "no strategy is subscribed on any account, so nothing will look for an entry"
        )
    logger.info("engine started: %s", engine.describe())
    return runtime


async def _quietly(what: str, work: Awaitable[object]) -> None:
    """Do one part of a shutdown, and carry on if it fails.

    Stopping is the one path that must always reach its end. A part that
    cannot be stopped cleanly is reported and stepped over, because the steps
    after it -- writing the books out -- matter more than it does.
    """
    try:
        await work
    except Exception:
        logger.exception("could not stop %s cleanly", what)


# -- the moving parts -------------------------------------------------------


async def _fan_out_ticks(engine: Engine) -> None:
    """Hand every tick to every account, for entry and then for what is open.

    One subscription, not one per account: the bus drops the oldest tick when a
    subscriber falls behind, and giving each account its own queue would let
    them fall behind by different amounts and enter the same signal at
    different prices.

    Entry runs first. A signal that fires on this tick is a position by the
    time the watch sees it, which is the order an operator would expect and
    the one that lets a group be complete on the tick that completes it.

    The two are guarded separately. Entry failing on one tick must not stop a
    trailing stop moving or a combined level being read -- those protect money
    already at risk, and it is least excusable for them to stop because
    something upstream broke.
    """
    parts = engine.parts
    subscription = parts.bus.subscribe(Topic.TICKS, name="entry")
    async for event in subscription:
        if not isinstance(event, Tick):
            continue
        for client in parts.clients.values():
            try:
                await client.entry.on_tick(event)
            except Exception:
                logger.exception("%s: entry failed on a tick", client.account.label)
            try:
                await client.positions.on_tick(event)
            except Exception:
                logger.exception("%s: the position watch failed on a tick", client.account.label)


def route_updates(engine: Engine) -> UpdateHandler:
    """Apply each order update to the book that owns the order.

    Routed by the client id the payload carries, which is what
    ``AccountStreamManager`` passes here -- not by whose socket it arrived on.
    A dealer session carries several accounts, and routing by the socket's
    owner would apply one account's fills to another.
    """

    async def handle(event: AccountEvent, arrived_on: TradingClientId) -> None:
        if not isinstance(event, OrderUpdate):
            return
        client = engine.parts.clients.get(arrived_on)
        if client is None:
            logger.debug("an order update arrived for %s, which is not trading", arrived_on)
            return
        await client.tracker.on_order_update(event)

    return handle


def _account_streams(
    engine: Engine, resolver: SessionResolver, connector: Connector
) -> AccountStreamManager:
    parts = engine.parts

    async def factory(credentials: Credentials) -> AccountStream:
        return build_account_stream(credentials, parts.instruments, parts.clock, connector)

    return AccountStreamManager(resolver, factory, parts.clock, route_updates(engine), parts.alerts)


def _register_tasks(engine: Engine, loader: InstrumentLoader | None) -> None:
    """Everything a venue's day is made of, in phase order."""
    parts = engine.parts
    exchanges: Sequence[str] = [e.code for e in parts.exchanges]

    if loader is not None:
        register_instrument_load(
            parts.registry, loader, parts.instruments, broker=loader.broker, exchanges=exchanges
        )
    if parts.market_data is not None:
        register_feed_lifecycle(parts.registry, parts.market_data, parts.exchanges)
    register_trade_loops(parts.registry, engine.loops, parts.exchanges)
