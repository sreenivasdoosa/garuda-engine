"""Recording the derived series, without a database.

What matters is the contract with the engine: a minute that closes is stored,
a minute still forming is not, the last minute of the day is not lost, and
nothing that goes wrong in here ever reaches the caller.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, cast
from zoneinfo import ZoneInfo

import pytest

from garuda.composition.derived_series import DerivedSeriesRecorder
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.marketdata.synthetics import ChainView, IVReading

IST = ZoneInfo("Asia/Kolkata")
STRADDLE = InstrumentId("SYNTH:STRADDLE-NIFTY")
NIFTY = InstrumentId("NSE:NIFTY")


def rupees(amount: str) -> Money:
    return Money(Decimal(amount), Currency.INR)


def at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 2, hour, minute, second, tzinfo=IST)


def tick(price: str, when: datetime) -> Tick:
    return Tick(instrument=STRADDLE, last_price=rupees(price), timestamp=when)


def no_chain() -> ChainView:
    """The recorder never reads the view itself -- it hands it to the
    volatility source, which is stubbed here. So a bare object is honest."""
    return cast("ChainView", object())


class RecordingStore:
    """Stands in for the database. Records what it was asked to keep."""

    def __init__(self, *, fail: bool = False) -> None:
        self.bars: list[tuple[str, str, datetime]] = []
        self.iv: list[tuple[str, datetime]] = []
        #: What each write was guarded against, so a test can assert the
        #: window came from the symbol's own venue.
        self.guards: list[tuple[str, Any]] = []
        self._fail = fail

    async def write(
        self, series: str, symbol: str, bar: Any, *, not_before: Any = None, **_: Any
    ) -> bool:
        if self._fail:
            raise RuntimeError("the database is down")
        self.guards.append((symbol, not_before))
        self.bars.append((series, symbol, bar.start))
        return True

    async def write_iv(self, symbol: str, bar: Any, **_: Any) -> bool:
        if self._fail:
            raise RuntimeError("the database is down")
        self.iv.append((symbol, bar.start))
        return True


class StubVolatility:
    """An IV source that answers a fixed reading, or nothing."""

    def __init__(self, call: str | None) -> None:
        self._call = call

    def reading(self, _view: Any) -> IVReading | None:
        if self._call is None:
            return None
        return IVReading(
            call=Decimal(self._call),
            put=Decimal("14"),
            call_strike=Decimal("25000"),
            put_strike=Decimal("25000"),
            spot=rupees("25010"),
        )


def recorder(store: Any, *, volatility: Any = (), opened: Any = None) -> DerivedSeriesRecorder:
    return DerivedSeriesRecorder(
        store=store, timezone=IST, volatility=volatility, session_start=opened
    )


class TestStoringWhatCloses:
    @pytest.mark.asyncio
    async def test_a_minute_still_forming_is_not_stored(self) -> None:
        store = RecordingStore()
        recording = recorder(store)

        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))

        assert store.bars == []

    @pytest.mark.asyncio
    async def test_the_minute_that_closed_is_stored_under_its_series(self) -> None:
        store = RecordingStore()
        recording = recorder(store)
        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))

        await recording.record((tick("110", at(9, 21)),), no_chain(), at(9, 21))

        assert store.bars == [("STRADDLE", "NIFTY", at(9, 20))]

    @pytest.mark.asyncio
    async def test_the_last_minute_of_the_day_is_not_lost(self) -> None:
        """Nothing arrives after it to roll it over, so the day has to end it."""
        store = RecordingStore()
        recording = recorder(store)
        await recording.record((tick("100", at(15, 29)),), no_chain(), at(15, 29))

        await recording.close_day()

        assert store.bars == [("STRADDLE", "NIFTY", at(15, 29))]

    @pytest.mark.asyncio
    async def test_a_new_day_does_not_carry_yesterdays_minute(self) -> None:
        store = RecordingStore()
        recording = recorder(store)
        await recording.record((tick("100", at(15, 29)),), no_chain(), at(15, 29))

        recording.forget_day()
        await recording.close_day()

        assert store.bars == []


class TestTheVolatilitySeries:
    @pytest.mark.asyncio
    async def test_it_is_sampled_from_the_chain_not_from_the_tick(self) -> None:
        """The published tick carries the average of both legs; the stored
        series carries each. So the reading is taken from the chain."""
        store = RecordingStore()
        recording = recorder(store, volatility=((NIFTY, StubVolatility("12")),))
        await recording.record((), no_chain(), at(9, 20))

        await recording.record((), no_chain(), at(9, 21))

        assert store.iv == [("NIFTY", at(9, 20))]

    @pytest.mark.asyncio
    async def test_a_chain_that_cannot_be_read_stores_nothing(self) -> None:
        store = RecordingStore()
        recording = recorder(store, volatility=((NIFTY, StubVolatility(None)),))

        await recording.record((), no_chain(), at(9, 20))
        await recording.record((), no_chain(), at(9, 21))

        assert store.iv == []

    @pytest.mark.asyncio
    async def test_with_no_symbol_asking_for_it_nothing_walks_the_chain(self) -> None:
        store = RecordingStore()
        recording = recorder(store)

        await recording.record((), no_chain(), at(9, 20))

        assert store.iv == []


class TestNeverDisturbingTheEngine:
    @pytest.mark.asyncio
    async def test_a_store_that_is_down_costs_the_chart_and_nothing_else(self) -> None:
        """These bars are a record, not part of any decision. Nothing sizes,
        gates or exits off them."""
        recording = recorder(RecordingStore(fail=True), volatility=((NIFTY, StubVolatility("12")),))
        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))

        # Must not raise.
        await recording.record((tick("110", at(9, 21)),), no_chain(), at(9, 21))
        await recording.close_day()

    @pytest.mark.asyncio
    async def test_a_tick_the_folder_refuses_does_not_stop_the_round(self) -> None:
        store = RecordingStore()
        recording = recorder(store)
        naive = Tick(
            instrument=STRADDLE,
            last_price=rupees("100"),
            timestamp=datetime(2026, 9, 2, 9, 20, tzinfo=UTC),
        )

        await recording.record((naive,), no_chain(), at(9, 20))


class TestTheVenuesOwnSession:
    @pytest.mark.asyncio
    async def test_each_symbol_is_guarded_by_its_own_venue(self) -> None:
        """MCX trades until half past eleven at night and NSE closes at half
        past three. One window for everything drops a commodity's whole
        evening -- silently, because the rejection is a debug line and an
        empty chart reads as a quiet series."""
        store = RecordingStore()
        opens = {"NIFTY": at(9, 15), "CRUDEOIL": at(9, 0)}
        recording = recorder(store, opened=lambda symbol: opens.get(symbol))

        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))
        await recording.record((tick("110", at(9, 21)),), no_chain(), at(9, 21))

        assert store.guards == [("NIFTY", at(9, 15))]

    @pytest.mark.asyncio
    async def test_an_unknown_venue_stores_the_bar_rather_than_dropping_it(self) -> None:
        """The guard exists to keep indicative pre-open prices out, not to be
        the arbiter of what may be kept."""
        store = RecordingStore()
        recording = recorder(store, opened=lambda _: None)

        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))
        await recording.record((tick("110", at(9, 21)),), no_chain(), at(9, 21))

        assert store.guards == [("NIFTY", None)]

    @pytest.mark.asyncio
    async def test_a_venue_lookup_that_raises_does_not_lose_the_bar(self) -> None:
        store = RecordingStore()

        def broken(_: str) -> datetime:
            raise RuntimeError("no calendar")

        recording = recorder(store, opened=broken)
        await recording.record((tick("100", at(9, 20)),), no_chain(), at(9, 20))
        await recording.record((tick("110", at(9, 21)),), no_chain(), at(9, 21))

        assert store.bars == [("STRADDLE", "NIFTY", at(9, 20))]
