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
from garuda.marketdata.registry import EMPTY_REGISTRY, InstrumentRegistry

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

    @property
    def broker(self) -> str:
        """Whose master this loads. Named, because the holder is keyed by it."""
        return self._broker

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
    """One instrument registry per broker, swapped whole when a load succeeds.

    **Per broker, because each broker publishes its own master.** They cover
    the same contracts and disagree about how to address them: the token is
    private to each, and the trading symbol can differ for the same instrument
    on the same exchange. One shared map would resolve the second broker's
    orders through the first broker's identifiers.

    A holder rather than module state so a failed load cannot leave the engine
    with a half-built index: a registry is published only once it is complete,
    and the previous one stays readable until then.
    """

    def __init__(self, registries: Mapping[str, InstrumentRegistry] | None = None) -> None:
        self._registries: dict[str, InstrumentRegistry] = dict(registries or {})

    def for_broker(self, broker: str) -> InstrumentRegistry:
        """That broker's instruments, or an empty registry before its first load.

        Empty rather than an error: an account can be configured before its
        master has been downloaded, and every lookup on an empty registry
        answers "not known", which is the truth.
        """
        return self._registries.get(broker, EMPTY_REGISTRY)

    def publish(self, broker: str, registry: InstrumentRegistry) -> None:
        if registry.is_empty:
            raise ValueError(
                f"refusing to publish an empty instrument registry for {broker}; "
                "an empty master means the download failed, not that nothing is listed"
            )
        self._registries[broker] = registry

    @property
    def brokers(self) -> frozenset[str]:
        return frozenset(self._registries)

    def is_loaded(self, broker: str) -> bool:
        return broker in self._registries
