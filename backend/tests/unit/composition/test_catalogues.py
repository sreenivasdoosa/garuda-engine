"""Loading a data provider's translation table.

Behavioural: what the load answers, and how often it reaches for the network.
The download is the expensive part -- Dhan's master is tens of megabytes -- so
"did it download again" is asserted directly rather than inferred.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

from garuda.composition.catalogues import (
    build_catalogue_loads,
    empty_catalogue_for,
)
from garuda.core.clock import ReplayClock
from garuda.domain.instrument import InstrumentId

IST = ZoneInfo("Asia/Kolkata")

HEADER = (
    "SEM_SMST_SECURITY_ID,SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_EXCH_INSTRUMENT_TYPE,"
    "SEM_OPTION_TYPE,SEM_TRADING_SYMBOL,SEM_CUSTOM_SYMBOL,UNDERLYING_SYMBOL,"
    "SEM_LOT_UNITS,SEM_STRIKE_PRICE,SEM_EXPIRY_DATE"
)

MASTER = (
    HEADER
    + "\n"
    + "2885,NSE,E,EQUITY,,RELIANCE,Reliance,,1,0,\n"
    + "13,NSE,I,INDEX,,NIFTY 50,NIFTY 50,,1,0,\n"
)

RELIANCE = InstrumentId("NSE:RELIANCE")

#: After the master is published, so a file cached before it is stale.
AFTER_PUBLICATION = datetime(2026, 8, 31, 9, 0, tzinfo=IST)
BEFORE_PUBLICATION = datetime(2026, 8, 31, 7, 0, tzinfo=IST)


def serving(master: str, calls: list[str]) -> httpx.AsyncClient:
    """A client that answers the master and records every fetch."""

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        return httpx.Response(200, text=master)

    return httpx.AsyncClient(transport=httpx.MockTransport(handle))


def loads_for(
    tmp_path: Path, clock: ReplayClock, calls: list[str], *, providers: tuple[str, ...] = ("dhan",)
) -> dict[str, object]:
    return dict(
        build_catalogue_loads(
            providers=providers,
            directory=tmp_path,
            timezone=IST,
            clock=clock,
            http=serving(MASTER, calls),
        )
    )


class TestWhichProvidersAreLoaded:
    def test_a_provider_with_a_catalogue_gets_a_load(self, tmp_path: Path) -> None:
        calls: list[str] = []

        assert "dhan" in loads_for(tmp_path, ReplayClock(AFTER_PUBLICATION), calls)

    def test_a_provider_with_no_catalogue_is_absent(self, tmp_path: Path) -> None:
        """Absent rather than a load that does nothing: nothing should register
        a DAY_INIT task that can only ever succeed at doing nothing."""
        calls: list[str] = []

        loads = loads_for(
            tmp_path, ReplayClock(AFTER_PUBLICATION), calls, providers=("zerodha", "fyers")
        )

        assert loads == {}

    def test_a_provider_with_no_row_is_never_loaded(self, tmp_path: Path) -> None:
        """An install that does not use Dhan must not download Dhan's master."""
        calls: list[str] = []

        loads_for(tmp_path, ReplayClock(AFTER_PUBLICATION), calls, providers=())

        assert calls == []


class TestTheDhanCatalogue:
    @pytest.mark.asyncio
    async def test_it_answers_a_catalogue_that_translates(self, tmp_path: Path) -> None:
        calls: list[str] = []
        load = loads_for(tmp_path, ReplayClock(AFTER_PUBLICATION), calls)["dhan"]

        catalogue = await load()  # type: ignore[operator]

        assert catalogue.details_for(RELIANCE) is not None
        assert catalogue.details_for(RELIANCE).security_id == "2885"

    @pytest.mark.asyncio
    async def test_the_master_is_downloaded_once_and_then_read_from_disk(
        self, tmp_path: Path
    ) -> None:
        """A restart at eleven must not re-download tens of megabytes."""
        clock = ReplayClock(AFTER_PUBLICATION)
        calls: list[str] = []
        load = loads_for(tmp_path, clock, calls)["dhan"]

        await load()  # type: ignore[operator]
        await load()  # type: ignore[operator]

        assert len(calls) == 1

    @pytest.mark.asyncio
    async def test_a_master_cached_yesterday_is_downloaded_again(self, tmp_path: Path) -> None:
        """Yesterday's file has yesterday's weekly strikes."""
        clock = ReplayClock(AFTER_PUBLICATION)
        calls: list[str] = []
        load = loads_for(tmp_path, clock, calls)["dhan"]
        await load()  # type: ignore[operator]

        await clock.advance_to(AFTER_PUBLICATION + timedelta(days=1))
        await load()  # type: ignore[operator]

        assert len(calls) == 2

    @pytest.mark.asyncio
    async def test_a_master_cached_before_publication_is_downloaded_again(
        self, tmp_path: Path
    ) -> None:
        """Downloaded at seven, read at nine: the file it read was written
        before Dhan published the day's."""
        clock = ReplayClock(BEFORE_PUBLICATION)
        calls: list[str] = []
        load = loads_for(tmp_path, clock, calls)["dhan"]
        await load()  # type: ignore[operator]

        await clock.advance_to(AFTER_PUBLICATION)
        await load()  # type: ignore[operator]

        assert len(calls) == 2


class TestTheEmptyCatalogue:
    def test_dhan_has_one_that_answers_not_listed(self) -> None:
        """An adapter built before DAY_INIT reads this. Every lookup on it must
        answer absence rather than raise."""
        empty = empty_catalogue_for("dhan")

        assert empty is not None
        assert empty.details_for(RELIANCE) is None

    def test_a_provider_that_does_not_translate_has_none(self) -> None:
        """Zerodha addresses instruments by the master's own token."""
        assert empty_catalogue_for("zerodha") is None
