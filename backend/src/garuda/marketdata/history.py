"""Candle history, fetched rather than built.

The engine does not assemble candles from ticks. Brokers publish history for
every interval anyone needs, and reproducing it from a tick stream would mean
two sources for one number — with the reconstruction wrong in exactly the
cases that matter, across a restart or a dropped connection.

**Yesterday never changes.** A closed day's candles are the same on every
request for ever, so they are fetched once and kept. Today's change every
minute and are refetched when they fall behind. That split is the whole cache:

    ┌──────────────── settled ────────────────┬─── today ───┐
     fetched once for the day, then immutable   refreshed

Two rules the reference engine learned and this keeps:

* **A failed fetch is retried the same day, but not immediately.** Marking a
  symbol done on failure loses it until tomorrow; retrying at once hammers a
  broker that is already struggling. So a failure backs off and tries again.
* **An expired session is not a transient failure.** Retrying a dead token
  every few minutes until the close is a loop that cannot succeed, and it
  hides the one thing an operator needs to be told. Authentication failures
  stop the series until somebody logs in.
* **Incomplete history is refused, not served.** A gap in the middle or a
  stale tail during market hours produces indicator values that look
  plausible and are wrong, which is worse than no value at all.

Reads are synchronous and memory-only, because a rule is a pure function and
must not perform I/O. Asking for candles nobody has fetched yet **registers
the demand** and answers empty; the refresh that follows brings them, and the
next evaluation has them. A strategy's first pass over a new instrument says
"cannot tell", which is true.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Protocol

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.marketdata.bars import closed_bars, is_stale
from garuda.protocols.broker import AuthExpiredError
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: How long to wait before trying a failed fetch again. Long enough not to
#: hammer a struggling broker, short enough that a transient outage costs
#: minutes rather than the trading day.
FAILURE_BACKOFF = timedelta(minutes=5)

#: How far back settled history is fetched. Enough for a hundred-period
#: indicator on a daily interval, which is the longest lookback configured.
DEFAULT_HISTORY_DAYS = 30


class HistorySource(Protocol):
    """Where candles come from.

    The seam every broker plugs into. Each implementation knows its own
    endpoint, its own interval names and its own limits on how much it will
    answer at once; what comes back is :class:`Bar`, which is the engine's
    format and the same whichever broker filled it. Nothing above here knows
    which broker answered.
    """

    async def fetch(
        self,
        instrument: InstrumentId,
        interval: BarInterval,
        start: datetime,
        end: datetime,
    ) -> Sequence[Bar]:
        """Candles in ``[start, end]``, oldest first. Raises on failure."""
        ...


@dataclass(frozen=True, slots=True)
class Want:
    """One series someone has asked for."""

    instrument: InstrumentId
    interval: BarInterval


@dataclass
class _Settled:
    """Closed days, which do not change once fetched."""

    bars: tuple[Bar, ...]
    fetched_for: date


@dataclass
class _Today:
    bars: tuple[Bar, ...]
    fetched_at: datetime


@dataclass
class CandleCache:
    """Candle history for whatever anyone asks about."""

    source: HistorySource
    clock: Clock
    history_days: int = DEFAULT_HISTORY_DAYS
    backoff: timedelta = FAILURE_BACKOFF

    _settled: dict[Want, _Settled] = field(default_factory=dict)
    _today: dict[Want, _Today] = field(default_factory=dict)
    _wanted: set[Want] = field(default_factory=set)
    _failed_at: dict[Want, datetime] = field(default_factory=dict)
    #: Series that stopped because the session died. Not retried: a dead token
    #: cannot recover on its own, and this engine never re-authenticates by
    #: itself.
    _needs_login: set[Want] = field(default_factory=set)

    # -- reading, which a rule does ----------------------------------------

    def get(self, instrument: InstrumentId, interval: BarInterval, count: int) -> tuple[Bar, ...]:
        """The last ``count`` **closed** bars, oldest first.

        Memory only. Nothing here waits on a broker, because a rule must not.
        Asking for a series nobody has fetched registers it and answers empty,
        and the next refresh brings it.
        """
        want = Want(instrument, interval)
        self._wanted.add(want)

        settled = self._settled.get(want)
        today = self._today.get(want)
        bars = list(settled.bars if settled else ()) + list(today.bars if today else ())
        usable = tuple(closed_bars(bars, self.clock.now()))
        return usable[-count:] if count > 0 else usable

    @property
    def wanted(self) -> frozenset[Want]:
        """Every series anyone has asked about. What the refresh works on."""
        return frozenset(self._wanted)

    def wants(self, instrument: InstrumentId, interval: BarInterval) -> None:
        """Ask for a series up front, before anything reads it.

        A strategy's own instruments are known before its first evaluation, so
        registering them at the open saves every strategy one blind pass.
        """
        self._wanted.add(Want(instrument, interval))

    # -- refreshing, which the loop does ------------------------------------

    async def refresh_due(self, *, session_start: datetime) -> int:
        """Fetch whatever is missing or has fallen behind. Returns how many.

        Never raises. A series that cannot be fetched is left as it was and
        retried after the backoff, because the alternative is one broker
        hiccup stopping every strategy that reads candles.
        """
        now = self.clock.now()
        today = now.date()
        fetched = 0

        for want in sorted(self._wanted, key=lambda w: (w.instrument.value, w.interval.value)):
            if want in self._needs_login or self._backing_off(want, now):
                continue
            try:
                fetched += await self._refresh(want, now, today, session_start)
            except AuthExpiredError:
                self._needs_login.add(want)
                logger.error(
                    "the session is gone, so %s %s history stops until someone logs in",
                    want.instrument,
                    want.interval.value,
                )
            except Exception:
                self._failed_at[want] = now
                logger.warning(
                    "could not fetch %s %s history; retrying in %s",
                    want.instrument,
                    want.interval.value,
                    self.backoff,
                    exc_info=True,
                )
        return fetched

    @property
    def stopped_for_login(self) -> frozenset[Want]:
        """Series waiting on somebody to log in again."""
        return frozenset(self._needs_login)

    async def _refresh(
        self, want: Want, now: datetime, today: date, session_start: datetime
    ) -> int:
        fetched = 0
        settled = self._settled.get(want)
        if settled is None or settled.fetched_for != today:
            self._settled[want] = _Settled(
                bars=tuple(await self._fetch_settled(want, now)), fetched_for=today
            )
            fetched += 1

        current = self._today.get(want)
        if current is None or is_stale(
            current.bars,
            now,
            interval=want.interval,
            session_start=session_start,
        ):
            self._today[want] = _Today(
                bars=tuple(await self._fetch_today(want, now, session_start)),
                fetched_at=now,
            )
            fetched += 1

        return fetched

    async def _fetch_settled(self, want: Want, now: datetime) -> Sequence[Bar]:
        """Everything up to the start of today. Immutable once it lands."""
        start = now - timedelta(days=self.history_days)
        end = datetime.combine(now.date(), now.time().min, tzinfo=now.tzinfo)
        return [
            bar
            for bar in await self.source.fetch(want.instrument, want.interval, start, end)
            if bar.start < end
        ]

    async def _fetch_today(
        self, want: Want, now: datetime, session_start: datetime
    ) -> Sequence[Bar]:
        return list(await self.source.fetch(want.instrument, want.interval, session_start, now))

    def _backing_off(self, want: Want, now: datetime) -> bool:
        failed = self._failed_at.get(want)
        return failed is not None and now - failed < self.backoff

    # -- the day ------------------------------------------------------------

    def forget_today(self) -> None:
        """Drop today's candles. Run at day-init, when today becomes another day.

        The settled cache is left alone: it is keyed by the day it was fetched
        for and refetches itself, which is one fewer thing to remember to do.
        """
        self._today.clear()
        self._failed_at.clear()
        # A new session is the usual reason a new day starts, so the series
        # that were waiting on one get another go.
        self._needs_login.clear()
