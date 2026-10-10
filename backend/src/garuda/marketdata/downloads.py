"""Every instrument file the engine downloads, and when each was last fetched.

The instrument master and each provider's catalogue are loaded at DAY_INIT by
the day model, and that was the only time they were ever loaded. It left two
gaps the reference service had already closed:

* **A login after the open ran on yesterday's strikes.** DAY_INIT had come
  and gone with nothing logged in, so the master it tried to load was never
  loaded, and nothing tried again until tomorrow. The reference refreshes
  the master whenever a session comes alive -- "login first" -- and that one
  rule is what self-healed its empty-master-after-early-restart window.
* **Nothing said when the file was last fetched.** A chain that will not
  price is, more often than not, a master from before 08:00, and the only way
  to find that out was the log.

So every load goes through here. The day's tasks, a login and the Console's
own button all call the same :meth:`InstrumentDownloads.refresh`, which is
why the status it keeps is the truth whichever of them ran last.

Two rules are ported from the reference's ``fetchAndLoadInstruments``:

* **A failed attempt is not retried for ten minutes** unless someone asks
  for it by name. A provider that is down is down for minutes, and a login
  storm -- five accounts signing in at 09:10 -- must not turn into five
  downloads of a file that is not there.
* **A forced download ignores the cache.** The Console's button exists for
  the morning the cached file is wrong in a way no staleness rule can see;
  it must fetch, not re-read.

The day's tasks are *not* throttled: the runner already retries a failed
phase on its own cadence, and a throttle on top would turn a minute's outage
into ten.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from garuda.brokers.zerodha.instruments import is_stale
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: How long a failed attempt holds off the next one that was not asked for by
#: name. The reference's figure.
RETRY_AFTER = timedelta(minutes=10)

#: When the day's file is published. Zerodha and Dhan both publish around
#: 08:00, so one rule serves every source today; a provider that publishes
#: later gets its own when it arrives.
PUBLISHED_AT = time(8, 0)


@dataclass(frozen=True, slots=True)
class DownloadReport:
    """What one load produced."""

    #: Instruments the loaded file indexed to.
    count: int
    #: Whether the file was fetched from the vendor, as opposed to re-read
    #: from the cache because the cache was still today's.
    downloaded: bool
    #: When the file now in use was fetched.
    cached_at: datetime


#: One source's load. ``force`` means fetch whatever the cache says.
type Download = Callable[[datetime, bool], Awaitable[DownloadReport]]


@dataclass(frozen=True)
class DownloadStatus:
    """What the Console shows for one source."""

    name: str
    #: ``master`` for the canonical instrument list, ``catalogue`` for a
    #: provider's translation of it.
    kind: str
    provider: str
    #: Whether anything is loaded at all. False before the first successful
    #: load of the process's life -- a restart at eleven starts here.
    loaded: bool = False
    count: int = 0
    cached_at: datetime | None = None
    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    #: Why the last attempt failed, or None when it succeeded.
    last_error: str | None = None
    #: Whether the last successful attempt fetched the file rather than
    #: re-reading today's.
    last_downloaded: bool = False
    in_progress: bool = False
    #: Whether the file in use was fetched today, and whether it predates
    #: today's publication. Computed against the engine's clock when the
    #: status is read, because a file that was fresh at 07:50 is stale at
    #: 08:01 without anything having happened to it.
    is_from_today: bool = False
    is_stale: bool = True
    #: Set when an attempt was skipped because the last one failed too
    #: recently. The caller is told rather than left to wonder why nothing
    #: happened.
    skipped_because: str | None = None


@dataclass
class _Source:
    name: str
    kind: str
    provider: str
    download: Download
    status: DownloadStatus
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


class InstrumentDownloads:
    """Every instrument file, with one place to fetch it and one to ask about it."""

    def __init__(
        self,
        clock: Clock,
        timezone: ZoneInfo,
        *,
        retry_after: timedelta = RETRY_AFTER,
        published_at: time = PUBLISHED_AT,
    ) -> None:
        self._clock = clock
        self._timezone = timezone
        self._retry_after = retry_after
        self._published_at = published_at
        self._sources: dict[str, _Source] = {}

    def register(self, name: str, download: Download, *, kind: str, provider: str) -> None:
        if name in self._sources:
            raise ValueError(f"{name!r} is already registered")
        self._sources[name] = _Source(
            name=name,
            kind=kind,
            provider=provider,
            download=download,
            status=DownloadStatus(name=name, kind=kind, provider=provider),
        )

    @property
    def names(self) -> tuple[str, ...]:
        return tuple(self._sources)

    def status(self) -> list[DownloadStatus]:
        """Every source, as of now."""
        now = self._clock.now()
        return [self._as_of(source.status, now) for source in self._sources.values()]

    def status_of(self, name: str) -> DownloadStatus:
        return self._as_of(self._source(name).status, self._clock.now())

    async def refresh(
        self, name: str, *, force: bool = False, throttle: bool = True
    ) -> DownloadStatus:
        """Load one source, and say what happened.

        Never raises on the load itself: the failure is recorded in the status
        and returned, and the caller decides whether that is fatal. The day's
        tasks say yes for the master and no for a catalogue; a login says no
        for both.

        ``throttle`` applies the ten-minute rule; ``force`` fetches regardless
        of the cache and of the throttle.
        """
        source = self._source(name)
        async with source.lock:
            now = self._clock.now()
            held_off = self._held_off(source.status, now)
            if held_off is not None and not force and throttle:
                logger.info("%s: not retried; %s", name, held_off)
                return self._as_of(replace(source.status, skipped_because=held_off), now)

            source.status = replace(
                source.status, in_progress=True, last_attempt_at=now, skipped_because=None
            )
            try:
                report = await source.download(now, force)
            except Exception as error:
                source.status = replace(
                    source.status,
                    in_progress=False,
                    last_error=f"{type(error).__name__}: {error}",
                )
                logger.warning("%s: could not be loaded: %s", name, source.status.last_error)
                return self._as_of(source.status, now)

            source.status = replace(
                source.status,
                in_progress=False,
                loaded=True,
                count=report.count,
                cached_at=report.cached_at,
                last_success_at=now,
                last_error=None,
                last_downloaded=report.downloaded,
            )
            logger.info(
                "%s: %d instruments, %s, file from %s",
                name,
                report.count,
                "downloaded" if report.downloaded else "re-read from today's cache",
                report.cached_at.isoformat(),
            )
            return self._as_of(source.status, now)

    async def refresh_all(
        self, *, force: bool = False, throttle: bool = True
    ) -> list[DownloadStatus]:
        """Every source in turn. One failing does not stop the next."""
        return [await self.refresh(name, force=force, throttle=throttle) for name in self._sources]

    # -- the rules ------------------------------------------------------------

    def _held_off(self, status: DownloadStatus, now: datetime) -> str | None:
        """Why this attempt should wait, or None when it may go ahead."""
        if status.last_error is None or status.last_attempt_at is None:
            return None
        since = now - status.last_attempt_at
        if since >= self._retry_after:
            return None
        remaining = self._retry_after - since
        return (
            f"the last attempt failed {int(since.total_seconds())}s ago "
            f"({status.last_error}); retrying in {int(remaining.total_seconds())}s"
        )

    def _as_of(self, status: DownloadStatus, now: datetime) -> DownloadStatus:
        if status.cached_at is None:
            return replace(status, is_from_today=False, is_stale=True)
        local_now = now.astimezone(self._timezone)
        local_cached = status.cached_at.astimezone(self._timezone)
        return replace(
            status,
            is_from_today=local_cached.date() == local_now.date(),
            is_stale=is_stale(
                status.cached_at, now, timezone=self._timezone, published_at=self._published_at
            ),
        )

    def _source(self, name: str) -> _Source:
        found = self._sources.get(name)
        if found is None:
            raise KeyError(f"{name!r} is not an instrument source; one of {', '.join(self.names)}")
        return found
