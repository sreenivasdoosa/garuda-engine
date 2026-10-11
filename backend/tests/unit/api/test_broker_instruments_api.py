"""Broker Instruments, from the Console's side.

Behavioural: a small master is published to the engine's registry and the
claims are about what the page gets back -- the statistics, what a search
and a lookup find, which expiry is chosen when none is named, and the
segment exchange every row is filed under.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI

from garuda.api import envelope
from garuda.api.routers import broker_instruments
from garuda.core.clock import ReplayClock
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.marketdata.downloads import DownloadReport, InstrumentDownloads
from garuda.marketdata.loader import InstrumentRegistryHolder
from garuda.marketdata.registry import InstrumentRegistry

IST = ZoneInfo("Asia/Kolkata")
#: Tuesday the 8th of September, 09:30 in Kolkata.
NOW = datetime(2026, 9, 8, 4, 0, tzinfo=UTC)
NIFTY = InstrumentId("NSE:NIFTY")


def option(nse: Exchange, expiry: date, strike: int, kind: OptionType) -> Instrument:
    suffix = "CE" if kind is OptionType.CALL else "PE"
    symbol = f"NIFTY{expiry:%y%b%d}{strike}{suffix}".upper()
    return Instrument(
        id=InstrumentId(f"NSE:{symbol}"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol=symbol,
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=expiry,
        strike=Decimal(strike),
        option_type=kind,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


def future(nse: Exchange, expiry: date) -> Instrument:
    symbol = f"NIFTY{expiry:%y%b}FUT".upper()
    return Instrument(
        id=InstrumentId(f"NSE:{symbol}"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.FUTURE,
        trading_symbol=symbol,
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=expiry,
    )


def index(nse: Exchange, symbol: str) -> Instrument:
    return Instrument(
        id=InstrumentId(f"NSE:{symbol}"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.INDEX,
        trading_symbol=symbol.replace("_", " "),
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


def share(nse: Exchange, symbol: str) -> Instrument:
    return Instrument(
        id=InstrumentId(f"NSE:{symbol}"),
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.EQUITY,
        trading_symbol=symbol,
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


SEPT_10 = date(2026, 9, 10)
SEPT_17 = date(2026, 9, 17)
SEPT_3 = date(2026, 9, 3)


def master(nse: Exchange) -> Sequence[Instrument]:
    return [
        index(nse, "NIFTY_50"),
        share(nse, "RELIANCE"),
        share(nse, "NIFTYBEES"),
        option(nse, SEPT_3, 25000, OptionType.CALL),
        option(nse, SEPT_10, 25000, OptionType.CALL),
        option(nse, SEPT_10, 25000, OptionType.PUT),
        option(nse, SEPT_17, 25000, OptionType.CALL),
        future(nse, date(2026, 9, 24)),
    ]


class Parts:
    def __init__(self, nse: Exchange, holder: InstrumentRegistryHolder, downloads: Any) -> None:
        self.instruments = holder
        self.downloads = downloads
        self.exchanges = [nse]


class Engine:
    def __init__(self, parts: Parts) -> None:
        self.parts = parts


class Harness:
    def __init__(self, nse: Exchange, *, loaded: bool = True) -> None:
        self.clock = ReplayClock(NOW)
        self.holder = InstrumentRegistryHolder()
        registry = InstrumentRegistry.build(
            master(nse), {i.id: str(100 + n) for n, i in enumerate(master(nse))}
        )
        self.fetches = 0
        self.downloads = InstrumentDownloads(self.clock, IST)

        async def download(now: datetime, force: bool) -> DownloadReport:
            self.fetches += 1
            self.holder.publish("zerodha", registry)
            return DownloadReport(
                count=len(registry), downloaded=force, cached_at=now, file_bytes=4096
            )

        self.downloads.register("master:zerodha", download, kind="master", provider="zerodha")
        if loaded:
            self.holder.publish("zerodha", registry)
        self.app = FastAPI()
        envelope.install(self.app)
        self.app.state.engine = Engine(Parts(nse, self.holder, self.downloads))
        self.app.include_router(broker_instruments.build(self.clock))

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://t")


async def data(response: httpx.Response) -> Any:
    assert response.status_code == 200, response.text
    return response.json()["data"]


class TestTheStatistics:
    async def test_only_brokers_with_a_master_are_listed(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            [row] = await data(await client.get("/api/broker-instruments"))
        assert row["brokerName"] == "zerodha"
        assert row["supported"] is True
        assert row["cacheLoaded"] is True
        assert row["instrumentsCount"] == 8
        assert row["fileBytes"] is None, "nothing has been fetched through the registry yet"

    async def test_a_download_fetches_and_reports(self, nse: Exchange) -> None:
        harness = Harness(nse, loaded=False)
        async with harness.client() as client:
            [before] = await data(await client.get("/api/broker-instruments"))
            assert before["cacheLoaded"] is False
            assert before["instrumentsCount"] == 0
            after = await data(await client.post("/api/broker-instruments/zerodha/download"))
        assert harness.fetches == 1
        assert after["cacheLoaded"] is True
        assert after["instrumentsCount"] == 8
        assert after["fileBytes"] == 4096
        assert after["lastDownloadedTime"] == NOW.isoformat()

    async def test_an_unknown_broker_is_refused_by_name(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            response = await client.post("/api/broker-instruments/kotak/download")
            assert response.status_code == 404
            assert "zerodha" in response.json()["message"]
            assert (await client.get("/api/broker-instruments/kotak")).status_code == 404

    async def test_without_an_engine_the_page_says_so(self) -> None:
        app = FastAPI()
        envelope.install(app)
        app.state.engine = None
        app.include_router(broker_instruments.build(ReplayClock(NOW)))
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://t"
        ) as client:
            assert (await client.get("/api/broker-instruments")).status_code == 503


class TestSearching:
    async def test_by_a_piece_of_the_trading_symbol(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            found = await data(await client.get("/api/broker-instruments/zerodha/search?q=25000CE"))
        assert sorted(i["tradingSymbol"] for i in found) == [
            "NIFTY26SEP0325000CE",
            "NIFTY26SEP1025000CE",
            "NIFTY26SEP1725000CE",
        ]
        [first] = [i for i in found if i["tradingSymbol"] == "NIFTY26SEP1025000CE"]
        assert first["exchange"] == "NFO", "the segment's code, as the broker files it"
        assert first["venue"] == "NSE"
        assert first["name"] == "NIFTY"
        assert first["instrumentType"] == "CE"
        assert first["strike"] == "25000", "a price crosses as a string"
        assert first["expiry"] == "2026-09-10"
        assert first["lotSize"] == 75
        assert first["instrumentToken"] is not None

    async def test_a_share_is_filed_under_its_venue(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            found = await data(await client.get("/api/broker-instruments/zerodha/search?q=reli"))
        [reliance] = found
        assert reliance["exchange"] == "NSE"
        assert reliance["instrumentType"] == "EQ"
        assert reliance["strike"] is None

    async def test_it_needs_two_characters_and_stops_at_the_limit(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            assert (
                await client.get("/api/broker-instruments/zerodha/search?q=N")
            ).status_code == 400
            found = await data(
                await client.get("/api/broker-instruments/zerodha/search?q=NIFTY&limit=2")
            )
        assert len(found) == 2

    async def test_a_master_not_loaded_yet_is_a_409(self, nse: Exchange) -> None:
        async with Harness(nse, loaded=False).client() as client:
            response = await client.get("/api/broker-instruments/zerodha/search?q=NIFTY")
        assert response.status_code == 409


class TestLookingUp:
    async def test_the_nearest_expiry_on_or_after_today_when_none_is_named(
        self, nse: Exchange
    ) -> None:
        """Today is the 8th; the 3rd has passed, the 10th is next."""
        async with Harness(nse).client() as client:
            found = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={
                        "exchange": "NFO",
                        "symbol": "NIFTY",
                        "instrumentType": "CE",
                        "strike": "25000",
                    },
                )
            )
        assert found["found"] is True
        assert found["instrument"]["expiry"] == "2026-09-10"

    async def test_a_named_expiry_is_exact(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            found = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={
                        "exchange": "NFO",
                        "symbol": "nifty",
                        "instrumentType": "PE",
                        "expiry": "2026-09-10",
                        "strike": "25000",
                    },
                )
            )
            missing = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={"exchange": "NFO", "symbol": "NIFTY", "expiry": "2026-12-31"},
                )
            )
        assert found["instrument"]["tradingSymbol"] == "NIFTY26SEP1025000PE"
        assert missing == {"found": False, "instrument": None}

    async def test_the_venue_code_does_not_find_a_derivative(self, nse: Exchange) -> None:
        """NSE is the shares; NFO is where the option is listed."""
        async with Harness(nse).client() as client:
            found = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={"exchange": "NSE", "symbol": "NIFTY", "instrumentType": "CE"},
                )
            )
            share_found = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={"exchange": "NSE", "symbol": "RELIANCE"},
                )
            )
        assert found["found"] is False
        assert share_found["instrument"]["tradingSymbol"] == "RELIANCE"

    async def test_an_index_is_found_as_the_broker_spells_it(self, nse: Exchange) -> None:
        """The page says "NIFTY 50"; the master says NIFTY_50."""
        async with Harness(nse).client() as client:
            found = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={"exchange": "NSE", "symbol": "NIFTY 50"},
                )
            )
        assert found["instrument"]["instrumentType"] == "INDEX"
        assert found["instrument"]["tradingSymbol"] == "NIFTY 50"

    async def test_bad_inputs_are_refused(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            assert (
                await client.get("/api/broker-instruments/zerodha/lookup?symbol=NIFTY")
            ).status_code == 400
            assert (
                await client.get(
                    "/api/broker-instruments/zerodha/lookup",
                    params={"exchange": "NFO", "symbol": "NIFTY", "expiry": "next week"},
                )
            ).status_code == 400


class TestTheExpiries:
    async def test_every_expiry_listed_soonest_first(self, nse: Exchange) -> None:
        async with Harness(nse).client() as client:
            options = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/expiries",
                    params={"exchange": "NFO", "symbol": "NIFTY", "instrumentType": "CE"},
                )
            )
            everything = await data(
                await client.get(
                    "/api/broker-instruments/zerodha/expiries",
                    params={"exchange": "NFO", "symbol": "NIFTY"},
                )
            )
        assert options["expiries"] == ["2026-09-03", "2026-09-10", "2026-09-17"]
        assert everything["expiries"] == ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"]
        assert everything["exchange"] == "NFO"
