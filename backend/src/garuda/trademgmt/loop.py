"""The cycle that keeps one account's trades moving.

Trade management does not react to everything as it happens. Two things drive
it, and separating them is what makes each one comprehensible:

**Ticks drive entry and trailing**, because both are answers to a price.

**A cycle drives everything else** -- polling the broker's order book,
withdrawing entries that rested too long, exiting positions whose time has
come, keeping multi-leg groups coherent, and working the square-off queue.
These are questions about state, and asking them on a timer means the answer
does not depend on whether a tick happened to arrive.

The reference engine ran a thread per partition of accounts, taking each
through the same steps. Here it is one pass over one account on the single
event loop; a slow broker delays that account's next cycle and nothing else.

**Every step is independent and every step is guarded.** A failure in one
account's poll must not stop its coordination sweep, and a failure in one
account must not stop the next -- the reference engine learned that as a
processor thread dying and leaving every account on it untended.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.enums import ProductType
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.protocols.broker import BrokerOrder
from garuda.protocols.clock import Clock
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.coordination import LegCoordinator
from garuda.trademgmt.squareoff import SquareOffService
from garuda.trademgmt.tracking import TradeTracker, update_from_broker_order

logger = logging.getLogger(__name__)

#: How long between cycles. Short enough that an exit is not left waiting on a
#: dropped update, long enough not to spend an account's rate limit on polling.
DEFAULT_INTERVAL = timedelta(seconds=5)

#: Products the venue closes itself at the end of the day.
_INTRADAY_PRODUCTS = frozenset({ProductType.MIS, ProductType.CO, ProductType.BO})

#: Fetches the broker's order book for this account.
type FetchOrders = Callable[[], Awaitable[Sequence[BrokerOrder]]]

#: The venue's own cut-off for intraday products, today. None when the venue
#: does not force one.
type IntradayCutoff = Callable[[Trade], datetime | None]


@dataclass
class CycleReport:
    """What one pass did. Counted rather than logged per item."""

    orders_seen: int = 0
    trades_advanced: int = 0
    entries_withdrawn: int = 0
    exits_requested: int = 0
    legs_coordinated: int = 0
    square_offs_worked: int = 0
    failures: list[str] = field(default_factory=list)

    @property
    def did_anything(self) -> bool:
        return bool(
            self.trades_advanced
            or self.entries_withdrawn
            or self.exits_requested
            or self.legs_coordinated
            or self.square_offs_worked
        )


class TradeLoop:
    """One account's periodic pass."""

    def __init__(
        self,
        book: TradingClientManager,
        tracker: TradeTracker,
        coordinator: LegCoordinator,
        square_off: SquareOffService,
        fetch_orders: FetchOrders,
        intraday_cutoff: IntradayCutoff,
        clock: Clock,
        alerts: AlertManager,
        *,
        interval: timedelta = DEFAULT_INTERVAL,
    ) -> None:
        self.book = book
        self._tracker = tracker
        self._coordinator = coordinator
        self._square_off = square_off
        self._fetch = fetch_orders
        self._intraday_cutoff = intraday_cutoff
        self._clock = clock
        self._alerts = alerts
        self._interval = interval

    async def run_once(self) -> CycleReport:
        """One pass, in the order the steps depend on each other.

        The poll comes first so everything after it reads current state. Exits
        are requested before the queue is worked, so a position whose time came
        this cycle is acted on in the same cycle.
        """
        now = self._clock.now()
        report = CycleReport()

        await self._step(report, "poll", self._poll_orders(report))
        await self._step(report, "stale-entries", self._withdraw_stale_entries(report, now))
        await self._step(report, "time-exits", self._exit_on_time(report, now))
        await self._step(report, "coordination", self._coordinate(report, now))
        await self._step(report, "square-off", self._work_square_offs(report))
        return report

    async def _step(self, report: CycleReport, name: str, work: Awaitable[None]) -> None:
        """Run one step, and let the others run whatever it does.

        A poll that fails must not stop the square-off queue: the queue is what
        gets positions out, and it is least excusable for it to stop because
        something unrelated broke.
        """
        try:
            await work
        except Exception as error:
            detail = f"{name}: {type(error).__name__}: {error}"
            report.failures.append(detail)
            logger.exception("%s: the %s step failed", self.book.label, name)
            await self._alerts.critical(
                EntityType.SYSTEM,
                self.book.label,
                "trade-loop",
                f"the {name} step of trade management failed ({error}). The rest of the "
                f"cycle ran and it will be retried.",
                key=f"trade-loop-step:{self.book.trading_client}:{name}",
            )

    # -- the steps ----------------------------------------------------------

    async def _poll_orders(self, report: CycleReport) -> None:
        """Read the broker's order book and fold it in.

        The backstop for the push stream. Every row goes through the same rules
        an update from the stream does, so a frame the stream dropped lands
        identically rather than through a second implementation.
        """
        orders = await self._fetch()
        report.orders_seen = len(orders)
        for order in orders:
            result = await self._tracker.on_order_update(update_from_broker_order(order))
            if result is not None and result.trade.state is not None:
                report.trades_advanced += 1

    async def _withdraw_stale_entries(self, report: CycleReport, now: datetime) -> None:
        withdrawn = await self._tracker.cancel_stale_entries(now)
        report.entries_withdrawn = len(withdrawn)

    async def _exit_on_time(self, report: CycleReport, now: datetime) -> None:
        """Close positions whose time has come, whoever set it.

        A strategy may name its own exit time and the venue forces one on
        intraday products. Whichever is earlier wins: past the venue's cut-off
        the broker starts closing positions itself, so an engine holding out
        for a later time gets neither its price nor its choice of moment.
        """
        for trade in self.book.live_trades():
            if trade.no_square_off or trade.is_exiting or trade.filled_quantity == 0:
                continue
            deadline = self._deadline_for(trade)
            if deadline is None or now < deadline:
                continue
            if await self._square_off.request(trade, TradeExitReason.TIME_BASED_EXIT):
                report.exits_requested += 1

    def _deadline_for(self, trade: Trade) -> datetime | None:
        venue = self._intraday_cutoff(trade) if trade.product in _INTRADAY_PRODUCTS else None
        chosen = [moment for moment in (trade.square_off_at, venue) if moment is not None]
        return min(chosen) if chosen else None

    async def _coordinate(self, report: CycleReport, now: datetime) -> None:
        report.legs_coordinated = len(await self._coordinator.sweep(now))

    async def _work_square_offs(self, report: CycleReport) -> None:
        report.square_offs_worked = len(await self._square_off.run_once())

    # -- running ------------------------------------------------------------

    async def run_forever(self) -> None:
        """Cycle until stopped.

        A failed cycle is followed by another. The alternative -- stopping on
        error -- leaves an account with open positions and nothing tending
        them, which is how a processor thread dying took every account on it
        down with it.
        """
        while True:
            try:
                await self.run_once()
            except Exception:
                logger.exception("%s: the trade cycle failed", self.book.label)
            await self._clock.sleep(self._interval)

    async def pre_open(self) -> CycleReport:
        """One pass before the session starts.

        Positions carried overnight, and orders that resolved after the engine
        stopped, are both settled here -- so the open finds a book that matches
        the broker rather than one it is about to discover is wrong.
        """
        report = await self.run_once()
        logger.info(
            "%s: pre-open pass saw %d orders and advanced %d trades",
            self.book.label,
            report.orders_seen,
            report.trades_advanced,
        )
        return report


class TradeLoops:
    """Every account's cycle, started and stopped as one.

    One task per account rather than one task over all of them, so a broker
    that answers slowly delays that account and no other. The reference engine
    sharded accounts across threads for the same reason; with one event loop
    the tasks are cheap enough to give each account its own.
    """

    def __init__(self, clock: Clock, alerts: AlertManager) -> None:
        self._clock = clock
        self._alerts = alerts
        self._loops: dict[str, TradeLoop] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def add(self, loop: TradeLoop) -> None:
        self._loops[str(loop.book.trading_client)] = loop

    @property
    def running(self) -> frozenset[str]:
        return frozenset(self._tasks)

    async def start(self) -> None:
        """Settle every account against its broker, then begin cycling.

        The pre-open pass runs for all of them before any starts cycling, so
        the session opens on a book that matches the broker rather than one
        that is about to find out it does not.
        """
        for name, loop in self._loops.items():
            try:
                await loop.pre_open()
            except Exception as error:
                # One account failing to settle must not stop the others from
                # trading. It is told and its cycle starts anyway.
                logger.exception("%s: the pre-open pass failed", name)
                await self._alerts.critical(
                    EntityType.SYSTEM,
                    loop.book.label,
                    "trade-loop",
                    f"the pre-open reconciliation failed ({error}). Positions carried "
                    f"overnight may not match the broker; the cycle is starting anyway.",
                    key=f"pre-open-failed:{name}",
                )
        for name, loop in self._loops.items():
            if name not in self._tasks:
                self._tasks[name] = asyncio.create_task(
                    loop.run_forever(), name=f"trade-loop:{name}"
                )

    async def stop(self) -> None:
        tasks, self._tasks = self._tasks, {}
        for task in tasks.values():
            task.cancel()
        for task in tasks.values():
            with suppress(asyncio.CancelledError):
                await task
