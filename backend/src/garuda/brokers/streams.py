"""Running one order update stream per trading client.

The market data feed is one connection the whole engine shares. These are not:
an order update is only visible to the account that placed the order, so there
is a connection per account and each fails on its own.

That independence is the design. One account's expired session, one account's
socket dropping, must not stop the others -- the reference engine's socket
manager kept a map keyed by account for exactly this reason. A client that
cannot start is recorded with why and retried; the rest trade.

Nothing here is the authority on an order. The stream is the fast path and the
reconciler's poll is the backstop, because frames are dropped and sockets
stall silently.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime

from garuda.alerts.manager import AlertManager
from garuda.brokers.sessions import Account, Credentials, SessionResolver, SessionUnavailableError
from garuda.core.backoff import ReconnectPolicy
from garuda.domain.alert import AlertLevel, EntityType
from garuda.domain.client import TradingClientId
from garuda.protocols.account import (
    AccountConnected,
    AccountDisconnected,
    AccountEvent,
    AccountProblem,
    AccountStream,
    OrderUpdate,
    PositionUpdate,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: Builds a stream for one account's credentials.
type StreamFactory = Callable[[Credentials], Awaitable[AccountStream]]

#: What the engine does with an update, once it is known whose it is.
type UpdateHandler = Callable[[AccountEvent, TradingClientId], Awaitable[None]]


@dataclass
class StreamHealth:
    """Per account, because they fail one at a time."""

    connected: bool = False
    order_updates: int = 0
    position_updates: int = 0
    problems: int = 0
    failures: int = 0
    last_event_at: datetime | None = None
    last_error: str | None = None


@dataclass(frozen=True, slots=True)
class StartReport:
    """Which accounts got a stream, and why the others did not."""

    started: tuple[TradingClientId, ...] = ()
    #: Account to the reason it could not start. Not an error: an operator who
    #: has logged in to three of five accounts should trade on three.
    unavailable: dict[TradingClientId, str] = field(default_factory=dict)

    @property
    def any_started(self) -> bool:
        return bool(self.started)


class AccountStreamManager:
    """Opens, watches and replaces one stream per trading client."""

    def __init__(
        self,
        resolver: SessionResolver,
        factory: StreamFactory,
        clock: Clock,
        handler: UpdateHandler,
        alerts: AlertManager,
        *,
        policy: ReconnectPolicy | None = None,
    ) -> None:
        self._alerts = alerts
        self._resolver = resolver
        self._factory = factory
        self._clock = clock
        self._handler = handler
        self._policy = policy or ReconnectPolicy()
        self._streams: dict[TradingClientId, AccountStream] = {}
        #: How each account should appear in a log line or an alert.
        self._labels: dict[TradingClientId, str] = {}
        self._tasks: dict[TradingClientId, asyncio.Task[None]] = {}
        self.health: dict[TradingClientId, StreamHealth] = {}

    @property
    def running(self) -> frozenset[TradingClientId]:
        return frozenset(self._tasks)

    async def start(self, now: datetime) -> StartReport:
        """Open a stream for every eligible account.

        One account failing is recorded, never raised. An operator who has
        logged in to three of five accounts should be trading on three, not
        stopped on all of them.
        """
        started: list[TradingClientId] = []
        unavailable: dict[TradingClientId, str] = {}

        for account in self._resolver.streaming_clients():
            if account.id in self._tasks:
                started.append(account.id)
                continue
            reason = await self._open(account, now)
            if reason is None:
                started.append(account.id)
            else:
                unavailable[account.id] = reason

        return StartReport(tuple(started), unavailable)

    async def _open(self, account: Account, now: datetime) -> str | None:
        health = self.health.setdefault(account.id, StreamHealth())
        try:
            credentials = self._resolver.credentials_for(account.id, now)
        except SessionUnavailableError as error:
            health.last_error = str(error)
            logger.info("no order stream for %s (%s): %s", account.label, account.id, error)
            # A warning rather than critical: the operator has not logged in
            # yet, which is a normal state at six in the morning and a serious
            # one at ten. Coalesced so a whole morning of retries is one line.
            await self._alerts.warning(
                EntityType.BROKER,
                account.label,
                "order-stream",
                f"no order updates: {error}",
                key=f"order-stream-session:{account.id}",
            )
            return str(error)

        try:
            stream = await self._factory(credentials)
            await stream.connect()
        except Exception as error:
            health.failures += 1
            health.last_error = f"{type(error).__name__}: {error}"
            logger.warning(
                "order stream failed to connect for %s (%s): %s", account.label, account.id, error
            )
            await self._alerts.warning(
                EntityType.BROKER,
                account.label,
                "order-stream",
                f"the order update socket would not connect: {error}",
                key=f"order-stream-connect:{account.id}",
            )
            return health.last_error

        self._streams[account.id] = stream
        self._labels[account.id] = account.label
        self._tasks[account.id] = asyncio.create_task(
            self._consume(account.id, stream), name=f"account-stream:{account.label}"
        )
        health.connected = True
        health.failures = 0
        await self._alerts.info(
            EntityType.BROKER,
            account.label,
            "order-stream",
            "receiving order updates",
            key=f"order-stream-up:{account.id}",
        )
        return None

    async def _consume(self, trading_client: TradingClientId, stream: AccountStream) -> None:
        """Read one stream until it ends, handing everything to the engine."""
        health = self.health.setdefault(trading_client, StreamHealth())
        try:
            async for event in stream.events():
                health.last_event_at = self._clock.now()
                match event:
                    case OrderUpdate():
                        health.order_updates += 1
                    case PositionUpdate():
                        health.position_updates += 1
                    case AccountProblem(_, detail, _):
                        health.problems += 1
                        health.last_error = detail
                        # Throttled: a stream sending malformed frames sends
                        # them faster than anyone can read.
                        await self._alerts.throttled(
                            AlertLevel.WARNING,
                            EntityType.BROKER,
                            self._label(trading_client),
                            "order-stream",
                            detail,
                            key=f"order-stream-problem:{trading_client}",
                        )
                    case AccountConnected():
                        health.connected = True
                    case AccountDisconnected(_, reason, _):
                        health.connected = False
                        health.last_error = reason
                        await self._alerts.warning(
                            EntityType.BROKER,
                            self._label(trading_client),
                            "order-stream",
                            f"order updates stopped: {reason}",
                            key=f"order-stream-down:{trading_client}",
                        )
                try:
                    await self._handler(event, trading_client)
                except Exception as error:
                    # A handler that raises must not take the stream down with
                    # it: the next update may be the fill that matters.
                    logger.exception(
                        "handling %s for %s (%s) failed: %s",
                        type(event).__name__,
                        self._label(trading_client),
                        trading_client,
                        error,
                    )
                    # Critical: an update that could not be applied is a fill
                    # the engine may not know about.
                    await self._alerts.critical(
                        EntityType.ORDER,
                        self._label(trading_client),
                        "order-update",
                        f"an order update could not be applied: {type(error).__name__}: {error}",
                        key=f"order-update-failed:{trading_client}",
                    )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            health.connected = False
            health.last_error = f"{type(error).__name__}: {error}"
            logger.warning(
                "order stream for %s (%s) ended: %s",
                self._label(trading_client),
                trading_client,
                error,
            )
        finally:
            health.connected = False

    def _label(self, trading_client: TradingClientId) -> str:
        """Never the bare id: nobody recognises one at seven in the morning."""
        return self._labels.get(trading_client, str(trading_client))

    async def reconcile(self, now: datetime) -> StartReport:
        """Replace whatever has stopped. Cheap when everything is healthy."""
        for trading_client, task in list(self._tasks.items()):
            if task.done():
                await self._retire(trading_client)

        if not self._tasks:
            # Nothing is up. Wait before hammering a provider that is down.
            failures = max((h.failures for h in self.health.values() if h.failures), default=0)
            if failures:
                await self._clock.sleep(self._policy.delay_after(failures))
        return await self.start(now)

    async def _retire(self, trading_client: TradingClientId) -> None:
        task = self._tasks.pop(trading_client, None)
        stream = self._streams.pop(trading_client, None)
        if task is not None and not task.done():
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task
        if stream is not None:
            # Closed completely, not merely dereferenced: a half-dead socket
            # left alive holds the account's session and blocks its
            # replacement.
            with suppress(Exception):
                await stream.close()

    async def stop(self) -> None:
        for trading_client in list(self._tasks):
            await self._retire(trading_client)
        for trading_client, health in self.health.items():
            health.connected = False
            logger.debug("order stream for %s stopped", self._label(trading_client))
