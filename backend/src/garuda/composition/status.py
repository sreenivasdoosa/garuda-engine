"""System Status: the running engine, read end to end for one page.

Ported from the reference engine's system status servlet, panel by panel,
keeping the ones garuda has a counterpart for -- the feed, the loops, the
accounts, the brokers, the venues, the strategies, the risk books, the
process's own resources, the quote-and-history probe and the two init
timelines -- and dropping the ones that describe a multi-tenant JVM: trade
processors, thread pools, the servlet container, licences, eviction, the
archive and the queue depths. Those were built for thousands of users on a
shared box, which this engine is not (``CLAUDE.md``, deliberately absent).

Every panel reads the engine's own parts, which is what makes the page say
what the engine *believes* rather than what the tables say. The counts
that live only in the tables -- definitions by status, subscriptions, who
has logged in -- are the API's to add, since it holds the session factory
and this layer deliberately does not.

Each panel is built on its own: a part that cannot report degrades that
panel, never the page.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path

import garuda
from garuda.composition.engine import Engine
from garuda.composition.runtime import Runtime
from garuda.core.timeline import InitTimeline, TimelineEvent
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.domain.money import Money
from garuda.domain.phases import DayPhase, PhaseInstant, next_phase_after
from garuda.marketdata.downloads import DownloadStatus
from garuda.marketdata.service import MarketDataService
from garuda.protocols.clock import Clock
from garuda.rms.killswitch import ActiveKillSwitch

logger = logging.getLogger(__name__)

#: What the probe asks for, as the reference does: the NSE index everyone
#: has, so a failure is the provider's and not a missing subscription's.
PROBE_INSTRUMENT = InstrumentId("NSE:NIFTY_50")
PROBE_INTERVAL = BarInterval.FIVE_MINUTES
#: The reference fetches the last six hours of five-minute candles.
PROBE_HISTORY_SPAN = timedelta(hours=6)


# -- what the page is made of -----------------------------------------------


@dataclass(frozen=True, slots=True)
class ProcessStatus:
    """The process and the box it runs on."""

    version: str
    python: str
    started_at: datetime
    uptime: timedelta
    cpu_count: int | None
    #: The one, five and fifteen minute averages, where the platform has them.
    load_average: tuple[float, float, float] | None
    process_rss_mb: int | None
    system_memory_total_mb: int | None
    system_memory_available_mb: int | None
    open_file_descriptors: int | None
    max_file_descriptors: int | None
    threads: int
    asyncio_tasks: int


@dataclass(frozen=True, slots=True)
class FeedStatus:
    """The feed, with the reference's one-word verdict on it.

    ``UP`` when connected; otherwise ``INACTIVE`` outside market hours, which
    is expected, and ``DOWN`` while a market is open, which is a problem.
    """

    service: MarketDataService | None
    state: str
    any_market_open: bool
    history_provider: str | None


@dataclass(frozen=True, slots=True)
class StrategyLoopStatus:
    running: bool
    interval: timedelta
    trading_day: date
    strategies_loaded: int
    subscriptions: int
    refused: Mapping[str, str]
    tranches_open: int
    tranches_today: int


@dataclass(frozen=True, slots=True)
class LoopStatus:
    """What is cycling: the runner, the trade loops and the strategy loop."""

    runner_running: bool
    trade_loops_started: bool
    accounts_cycling: frozenset[str]
    strategy_loop: StrategyLoopStatus | None


@dataclass(frozen=True, slots=True)
class AccountStatus:
    trading_client_id: str
    display_name: str
    broker: str
    client_id: str
    enabled: bool
    is_trading: bool
    unavailable_because: str | None
    is_cycling: bool


@dataclass(frozen=True, slots=True)
class VenueStatus:
    code: str
    name: str
    timezone: str
    trading_day: date
    is_trading_day: bool
    is_open: bool
    #: Today's sessions as local open and close times, where it trades today.
    sessions: tuple[tuple[str, str], ...]
    next_phase: PhaseInstant | None


@dataclass(frozen=True, slots=True)
class RiskStatus:
    kill_switches: tuple[ActiveKillSwitch, ...]
    limit_rows: int


@dataclass(frozen=True, slots=True)
class ProbeResult:
    ok: bool
    latency: timedelta
    error: str | None = None
    last_price: Money | None = None
    at: datetime | None = None
    candles: int | None = None
    interval: str | None = None


@dataclass(frozen=True, slots=True)
class HealthCheck:
    instrument: InstrumentId
    tick: ProbeResult
    history: ProbeResult


# -- the view --------------------------------------------------------------


class SystemStatusView:
    """Reads the engine for the System Status page."""

    def __init__(
        self,
        engine: Engine,
        clock: Clock,
        *,
        runtime: Runtime | None = None,
        timeline: InitTimeline | None = None,
        started_at: datetime | None = None,
    ) -> None:
        self._engine = engine
        self._clock = clock
        self._runtime = runtime
        self._timeline = timeline if timeline is not None else getattr(runtime, "timeline", None)
        self._started_at = started_at if started_at is not None else clock.now()

    # -- the process ---------------------------------------------------------

    def process(self) -> ProcessStatus:
        now = self._clock.now()
        load: tuple[float, float, float] | None
        try:
            one, five, fifteen = os.getloadavg()
            load = (one, five, fifteen)
        except (AttributeError, OSError):
            load = None
        total_mb, available_mb = _meminfo_mb()
        return ProcessStatus(
            version=garuda.__version__,
            python=sys.version.split()[0],
            started_at=self._started_at,
            uptime=now - self._started_at,
            cpu_count=os.cpu_count(),
            load_average=load,
            process_rss_mb=_rss_mb(),
            system_memory_total_mb=total_mb,
            system_memory_available_mb=available_mb,
            open_file_descriptors=_open_fds(),
            max_file_descriptors=_max_fds(),
            threads=threading.active_count(),
            asyncio_tasks=_task_count(),
        )

    # -- the feed ------------------------------------------------------------

    def feed(self) -> FeedStatus:
        parts = self._engine.parts
        service = parts.market_data
        now = self._clock.now()
        any_open = any(exchange.is_open(now) for exchange in parts.exchanges)
        connected = False
        if service is not None and service.is_running:
            feed = service.supervisor.feed
            connected = feed is not None and feed.is_connected
        state = "UP" if connected else ("DOWN" if any_open else "INACTIVE")
        return FeedStatus(
            service=service,
            state=state,
            any_market_open=any_open,
            history_provider=_history_provider(parts.candles),
        )

    # -- the loops -----------------------------------------------------------

    def loops(self) -> LoopStatus:
        parts = self._engine.parts
        runtime = self._runtime
        loops = parts.loops
        strategy: StrategyLoopStatus | None = None
        if runtime is not None and runtime.strategies is not None:
            loop = runtime.strategies
            strategy = StrategyLoopStatus(
                running=not loop.is_stopping,
                interval=loop.interval,
                trading_day=loop.trading_day,
                strategies_loaded=len(loop.loaded.strategies),
                subscriptions=len(loop.loaded.subscriptions),
                refused=dict(loop.loaded.refused),
                tranches_open=len(loop.ledger.open),
                tranches_today=len(loop.ledger.all),
            )
        return LoopStatus(
            runner_running=runtime is not None and not runtime.runner.is_stopping,
            trade_loops_started=loops is not None and loops.is_running,
            accounts_cycling=loops.running if loops is not None else frozenset(),
            strategy_loop=strategy,
        )

    # -- the accounts --------------------------------------------------------

    def accounts(self) -> list[AccountStatus]:
        parts = self._engine.parts
        cycling = parts.loops.running if parts.loops is not None else frozenset()
        rows = [
            AccountStatus(
                trading_client_id=account.id.value,
                display_name=account.display_name,
                broker=account.broker,
                client_id=account.client_id,
                enabled=account.enabled,
                is_trading=account.id in parts.clients,
                unavailable_because=parts.unavailable.get(account.id),
                is_cycling=account.id.value in cycling,
            )
            for account in parts.accounts.values()
        ]
        return sorted(rows, key=lambda row: row.display_name.lower())

    # -- the venues ----------------------------------------------------------

    def venues(self) -> list[VenueStatus]:
        parts = self._engine.parts
        now = self._clock.now()
        rows: list[VenueStatus] = []
        for exchange in parts.exchanges:
            today = now.astimezone(exchange.timezone).date()
            sessions = tuple(
                (session.opens.strftime("%H:%M"), session.closes.strftime("%H:%M"))
                for session in exchange.calendar.sessions_on(today)
            )
            try:
                upcoming = next_phase_after(exchange, now, parts.venues.offsets.get(exchange.code))
            except Exception:
                logger.exception("%s: could not work out its next phase", exchange.code)
                upcoming = None
            rows.append(
                VenueStatus(
                    code=exchange.code,
                    name=exchange.name,
                    timezone=str(exchange.timezone),
                    trading_day=exchange.trading_day_for(now),
                    is_trading_day=exchange.calendar.is_trading_day(today),
                    is_open=exchange.is_open(now),
                    sessions=sessions,
                    next_phase=upcoming,
                )
            )
        return rows

    # -- risk ----------------------------------------------------------------

    def risk(self) -> RiskStatus:
        parts = self._engine.parts
        return RiskStatus(
            kill_switches=parts.kill_switch.switches,
            limit_rows=len(parts.limits.rows),
        )

    # -- the instrument files ------------------------------------------------

    def instrument_files(self) -> list[DownloadStatus]:
        downloads = self._engine.parts.downloads
        return downloads.status() if downloads is not None else []

    # -- the timelines -------------------------------------------------------

    def startup_events(self) -> list[TimelineEvent]:
        return self._timeline.startup_events() if self._timeline is not None else []

    def day_events(self) -> list[TimelineEvent]:
        return self._timeline.day_events() if self._timeline is not None else []

    # -- a phase, now ----------------------------------------------------------

    async def run_phase(
        self, exchange_code: str, phase: str, trading_day: date | None
    ) -> str | None:
        """Run one phase for one venue by hand. Returns the failure reason or None."""
        if self._runtime is None:
            raise RuntimeError("the engine is built but not running, so no phase can run")
        try:
            wanted = DayPhase(phase.strip().upper())
        except ValueError:
            raise ValueError(
                f"{phase!r} is not a phase; one of {', '.join(p.value for p in DayPhase)}"
            ) from None
        day = trading_day
        if day is None:
            now = self._clock.now()
            for exchange in self._engine.parts.exchanges:
                if exchange.code == exchange_code.upper():
                    day = exchange.trading_day_for(now)
                    break
            else:
                day = now.date()
        return await self._runtime.runner.run_now(exchange_code.upper(), wanted, day)

    # -- the probe -----------------------------------------------------------

    async def health_check(self, instrument: InstrumentId = PROBE_INSTRUMENT) -> HealthCheck:
        """Is market data answering? One tick read, one history round-trip.

        The reference pulls a quote over REST; garuda's engine prices from
        the feed and has no quote caller yet, so the tick probe reads the
        hub's last price for the instrument and says how old it is. The
        history probe is the network round-trip the reference makes.
        """
        return HealthCheck(
            instrument=instrument,
            tick=self._probe_tick(instrument),
            history=await self._probe_history(instrument),
        )

    def _probe_tick(self, instrument: InstrumentId) -> ProbeResult:
        parts = self._engine.parts
        started = self._clock.now()
        if parts.market_data is None:
            return ProbeResult(
                ok=False,
                latency=timedelta(0),
                error="no provider is nominated for ticks",
            )
        tick = parts.hub.latest(instrument)
        latency = self._clock.now() - started
        if tick is None:
            subscribed = instrument in parts.hub.subscriptions
            return ProbeResult(
                ok=False,
                latency=latency,
                error=(
                    f"no tick received for {instrument}"
                    if subscribed
                    else f"{instrument} is not subscribed"
                ),
            )
        return ProbeResult(ok=True, latency=latency, last_price=tick.last_price, at=tick.timestamp)

    async def _probe_history(self, instrument: InstrumentId) -> ProbeResult:
        parts = self._engine.parts
        started = self._clock.now()
        if parts.candles is None:
            return ProbeResult(
                ok=False,
                latency=timedelta(0),
                error="no provider is logged in for candle history",
                interval=PROBE_INTERVAL.value,
            )
        try:
            bars = await parts.candles.source.fetch(
                instrument, PROBE_INTERVAL, started - PROBE_HISTORY_SPAN, started
            )
        except Exception as error:
            return ProbeResult(
                ok=False,
                latency=self._clock.now() - started,
                error=f"{type(error).__name__}: {error}",
                interval=PROBE_INTERVAL.value,
            )
        return ProbeResult(
            ok=True,
            latency=self._clock.now() - started,
            candles=len(bars),
            interval=PROBE_INTERVAL.value,
        )


# -- the box ----------------------------------------------------------------
#
# Read from /proc where there is one, as the reference does. Elsewhere -- the
# unit tests run on Windows too -- every figure is None rather than a guess.


def _history_provider(candles: object) -> str | None:
    source = getattr(candles, "source", None)
    built = getattr(source, "_built", None)
    if isinstance(built, tuple) and built and isinstance(built[0], str):
        return built[0]
    return None


def _task_count() -> int:
    try:
        return len(asyncio.all_tasks())
    except RuntimeError:
        return 0


def _read_proc_kb(path: str, key: str) -> int | None:
    try:
        for line in Path(path).read_text().splitlines():
            if line.startswith(key + ":"):
                return int(line.split()[1])
    except (OSError, ValueError, IndexError):
        return None
    return None


def _rss_mb() -> int | None:
    kb = _read_proc_kb("/proc/self/status", "VmRSS")
    return kb // 1024 if kb is not None else None


def _meminfo_mb() -> tuple[int | None, int | None]:
    total = _read_proc_kb("/proc/meminfo", "MemTotal")
    available = _read_proc_kb("/proc/meminfo", "MemAvailable")
    return (
        total // 1024 if total is not None else None,
        available // 1024 if available is not None else None,
    )


def _open_fds() -> int | None:
    try:
        return sum(1 for _ in Path("/proc/self/fd").iterdir())
    except OSError:
        return None


def _max_fds() -> int | None:
    try:
        import resource

        soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        return int(soft) if soft >= 0 else None
    except (ImportError, OSError, ValueError):
        return None


__all__: Sequence[str] = (
    "AccountStatus",
    "FeedStatus",
    "HealthCheck",
    "LoopStatus",
    "ProbeResult",
    "ProcessStatus",
    "RiskStatus",
    "StrategyLoopStatus",
    "SystemStatusView",
    "VenueStatus",
)
