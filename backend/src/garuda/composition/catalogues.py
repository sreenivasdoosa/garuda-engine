"""Building each data provider's translation table.

The instrument master says what exists; a catalogue says what one provider
calls it. They are loaded the same way and cached the same way, and for the
same reason -- the file is tens of megabytes and a restart at eleven must not
re-download it -- but they are separate loads, because a provider's names are
not an opinion about which contracts are listed.

A catalogue is loaded for every **configured** provider rather than only the
active one. Dhan's master is public and needs no session, so the cost is one
download, and it buys switching the ticker or history provider mid-day without
a restart. Providers with no row are not loaded: an install that does not use
Dhan should not be downloading Dhan's master every morning.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable
from datetime import time
from pathlib import Path
from typing import Any, Final
from zoneinfo import ZoneInfo

import httpx

from garuda.brokers.zerodha.instruments import is_stale
from garuda.marketdata.cache import InstrumentCache
from garuda.marketdata.providers.catalogues import CatalogueLoad, CatalogueResult
from garuda.marketdata.providers.dhan_catalogue import EMPTY as EMPTY_DHAN
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_master import download_master as download_dhan
from garuda.marketdata.providers.dhan_master import parse_master as parse_dhan
from garuda.protocols.clock import Clock

__all__ = ["CatalogueLoad", "build_catalogue_loads", "empty_catalogue_for"]

logger = logging.getLogger(__name__)

#: Dhan republishes its scrip master each morning, with that day's new weekly
#: strikes. Same hour as the broker masters, and for the same reason: a file
#: downloaded before it is stale once it passes.
DHAN_MASTER_PUBLISHED_AT: Final = time(8, 0)

#: What each provider's adapters read before that provider's first load of the
#: day. Kept here rather than in the engine so that adding a provider does not
#: mean editing the composition root's fallback.
EMPTY_CATALOGUES: Final[dict[str, Any]] = {"dhan": EMPTY_DHAN}


def empty_catalogue_for(provider: str) -> Any:
    """That provider's empty table, or None where it has no catalogue at all.

    None is the honest answer for a provider that does not translate -- Zerodha
    addresses instruments by the master's own token -- and an adapter that does
    not take a catalogue never reads it.
    """
    return EMPTY_CATALOGUES.get(provider)


def build_catalogue_loads(
    *,
    providers: Iterable[str],
    directory: Path,
    timezone: ZoneInfo,
    clock: Clock,
    http: httpx.AsyncClient,
) -> dict[str, CatalogueLoad]:
    """A load per configured provider that has a catalogue to load.

    A provider with no catalogue is absent from the result rather than present
    with a load that does nothing, so nothing registers a DAY_INIT task that
    could only ever succeed at doing nothing.
    """
    cache = InstrumentCache(directory, clock)
    loads: dict[str, CatalogueLoad] = {}
    for provider in providers:
        if provider == "dhan":
            loads[provider] = _dhan_load(cache, http, clock, timezone)
    if loads:
        logger.info("catalogues to load: %s", ", ".join(sorted(loads)))
    return loads


def _dhan_load(
    cache: InstrumentCache, http: httpx.AsyncClient, clock: Clock, timezone: ZoneInfo
) -> CatalogueLoad:
    """Dhan's scrip master, downloaded only when the cached one is stale.

    The raw CSV is cached, not the parsed catalogue: the first thing anyone
    wants when a strike does not tick is the file Dhan actually sent.
    """

    async def load(*, force: bool = False) -> CatalogueResult:
        cached = cache.read("dhan")
        downloaded = False
        if (
            force
            or cached is None
            or cached.is_empty
            or _stale(cached.downloaded_at, clock, timezone)
        ):
            cached = cache.write("dhan", await download_dhan(http))
            downloaded = True
            logger.info("Dhan scrip master downloaded")
        return CatalogueResult(
            catalogue=DhanCatalogue(parse_dhan(cached.text)),
            downloaded=downloaded,
            cached_at=cached.downloaded_at,
        )

    return load


def _stale(downloaded_at: Any, clock: Clock, timezone: ZoneInfo) -> bool:
    return is_stale(
        downloaded_at, clock.now(), timezone=timezone, published_at=DHAN_MASTER_PUBLISHED_AT
    )
