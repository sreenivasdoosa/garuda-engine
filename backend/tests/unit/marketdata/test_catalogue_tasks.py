"""Loading a provider's catalogue as part of the day.

The rule that matters here is containment: a provider whose catalogue will not
load must not take DAY_INIT down with it. DAY_INIT is also where the
instrument master, the venues and every trade loop are set up, and losing those
because a provider the operator may not even be using failed to download is a
far worse day than losing that provider.
"""

from __future__ import annotations

from datetime import date, datetime
from zoneinfo import ZoneInfo

import pytest

from garuda.core.runner import PhaseContext, TaskRegistry
from garuda.domain.exchange import Exchange
from garuda.domain.phases import DayPhase
from garuda.marketdata.providers.catalogues import CatalogueHolder
from garuda.marketdata.tasks import register_provider_catalogue

IST = ZoneInfo("Asia/Kolkata")
DAY_INIT_TIME = datetime(2026, 8, 31, 7, 0, tzinfo=IST)


class Catalogue:
    """Stands in for a provider's table. Only its size is ever read here."""

    def __init__(self, size: int = 3) -> None:
        self._size = size

    def __len__(self) -> int:
        return self._size


def context(nse: Exchange) -> PhaseContext:
    return PhaseContext(
        exchange=nse,
        trading_day=date(2026, 8, 31),
        phase=DayPhase.DAY_INIT,
        now=DAY_INIT_TIME,
    )


async def run_day_init(registry: TaskRegistry, nse: Exchange) -> None:
    for _, task in registry.tasks_for(DayPhase.DAY_INIT, nse.code):
        await task(context(nse))


class TestLoadingACatalogue:
    @pytest.mark.asyncio
    async def test_a_loaded_catalogue_is_published_under_its_provider(self, nse: Exchange) -> None:
        holder = CatalogueHolder()
        registry = TaskRegistry()
        loaded = Catalogue()

        async def load() -> Catalogue:
            return loaded

        register_provider_catalogue(registry, holder, load, provider="dhan")
        await run_day_init(registry, nse)

        assert holder.for_provider("dhan", None) is loaded

    @pytest.mark.asyncio
    async def test_it_is_registered_at_day_init(self, nse: Exchange) -> None:
        """Before anything subscribes, and beside the instrument master."""
        holder = CatalogueHolder()
        registry = TaskRegistry()

        async def load() -> Catalogue:
            return Catalogue()

        register_provider_catalogue(registry, holder, load, provider="dhan")

        assert DayPhase.DAY_INIT in registry.phases

    @pytest.mark.asyncio
    async def test_a_failed_load_does_not_take_the_phase_down(self, nse: Exchange) -> None:
        """The whole point of catching it. DAY_INIT carries the instrument
        master and every trade loop as well."""
        holder = CatalogueHolder()
        registry = TaskRegistry()

        async def load() -> Catalogue:
            raise RuntimeError("dhan did not answer")

        register_provider_catalogue(registry, holder, load, provider="dhan")

        await run_day_init(registry, nse)

        assert holder.has("dhan") is False

    @pytest.mark.asyncio
    async def test_a_failed_load_leaves_yesterdays_table_rather_than_half_of_one(
        self, nse: Exchange
    ) -> None:
        """Published only on success, so nothing reads a partial master."""
        yesterday = Catalogue(size=1)
        holder = CatalogueHolder({"dhan": yesterday})
        registry = TaskRegistry()

        async def load() -> Catalogue:
            raise RuntimeError("dhan did not answer")

        register_provider_catalogue(registry, holder, load, provider="dhan")
        await run_day_init(registry, nse)

        assert holder.for_provider("dhan", None) is yesterday

    @pytest.mark.asyncio
    async def test_each_provider_loads_independently(self, nse: Exchange) -> None:
        """One provider failing must not cost another its table: they are
        separate downloads answering separate questions."""
        holder = CatalogueHolder()
        registry = TaskRegistry()
        good = Catalogue()

        async def fails() -> Catalogue:
            raise RuntimeError("no")

        async def works() -> Catalogue:
            return good

        register_provider_catalogue(registry, holder, fails, provider="dhan")
        register_provider_catalogue(registry, holder, works, provider="fyers")
        await run_day_init(registry, nse)

        assert holder.has("dhan") is False
        assert holder.for_provider("fyers", None) is good


class TestTheHolder:
    def test_a_provider_with_no_table_yet_reads_the_empty_one(self) -> None:
        """An engine can be built before any master is downloaded."""
        empty = Catalogue(size=0)

        assert CatalogueHolder().for_provider("dhan", empty) is empty

    def test_a_reload_replaces_the_table_whole(self) -> None:
        """Never merged: half of yesterday's strikes and half of today's is
        worse than either."""
        holder = CatalogueHolder({"dhan": Catalogue(size=1)})
        today = Catalogue(size=2)

        holder.publish("dhan", today)

        assert holder.for_provider("dhan", None) is today
