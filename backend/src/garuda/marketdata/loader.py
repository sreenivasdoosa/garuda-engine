"""Loading the instrument master.

The first thing a trading day needs: nothing can be selected, priced or routed
before the engine knows what is listed. It runs at DAY_INIT and, if it fails,
the phase is not recorded complete so the next pass tries again.

The master is downloaded only when the cached copy is stale. Stale means from
an earlier day, or from today but downloaded before the broker published that
day's file — brokers publish around 08:00 with the day's new weekly strikes, so
a copy fetched at 07:40 after an early restart is already wrong by 08:01.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

from garuda.brokers.zerodha.instruments import is_stale, parse_instruments
from garuda.domain.exchange import Exchange
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.cache import CachedMaster, InstrumentCache
from garuda.marketdata.registry import InstrumentRegistry

#: Downloads a broker's raw instrument master.
type MasterDownloader = Callable[[], Awaitable[str]]


@dataclass(frozen=True)
class LoadResult:
    """What a load did, and what it refused."""

    registry: InstrumentRegistry
    downloaded: bool
    cached_at: datetime
    skipped: tuple[tuple[str, str], ...] = ()

    @property
    def count(self) -> int:
        return len(self.registry)


class InstrumentLoader:
    """Fetches, caches and indexes one broker's instrument master."""

    def __init__(
        self,
        broker: str,
        cache: InstrumentCache,
        download: MasterDownloader,
        exchanges: Mapping[str, Exchange],
        symbols: Mapping[str, SymbolInfo],
        timezone: ZoneInfo,
    ) -> None:
        self._broker = broker
        self._cache = cache
        self._download = download
        self._exchanges = dict(exchanges)
        self._symbols = dict(symbols)
        self._timezone = timezone

    async def load(self, now: datetime, *, force: bool = False) -> LoadResult:
        """Return today's registry, downloading only if the cache is stale."""
        cached = self._cache.read(self._broker)
        downloaded = False

        if force or self._needs_download(cached, now):
            cached = self._cache.write(self._broker, await self._download())
            downloaded = True

        assert cached is not None
        return self._index(cached, downloaded)

    def _needs_download(self, cached: CachedMaster | None, now: datetime) -> bool:
        if cached is None or cached.is_empty:
            return True
        return is_stale(cached.downloaded_at, now, timezone=self._timezone)

    def _index(self, cached: CachedMaster, downloaded: bool) -> LoadResult:
        catalogue = parse_instruments(cached.text, self._exchanges, self._symbols)
        registry = InstrumentRegistry.build(catalogue.instruments, catalogue.tokens)
        return LoadResult(
            registry=registry,
            downloaded=downloaded,
            cached_at=cached.downloaded_at,
            skipped=catalogue.skipped,
        )


class InstrumentRegistryHolder:
    """The registry the engine reads, swapped whole when a load succeeds.

    A holder rather than a module-level variable so a failed load cannot leave
    the engine with a half-built index: the new registry is only published once
    it is complete.
    """

    def __init__(self, registry: InstrumentRegistry | None = None) -> None:
        self._registry = registry or InstrumentRegistry()

    @property
    def current(self) -> InstrumentRegistry:
        return self._registry

    def publish(self, registry: InstrumentRegistry) -> None:
        if registry.is_empty:
            raise ValueError(
                "refusing to publish an empty instrument registry; "
                "an empty master means the download failed, not that nothing is listed"
            )
        self._registry = registry
