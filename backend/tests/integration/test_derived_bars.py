"""Storing the series the engine prices for itself, against a real database.

The rules worth pinning are the two the reference learned: a bar from before
the open is not stored, and a failed write never reaches the engine. Plus the
upsert, which is what makes a restart mid-session safe.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.domain.money import Currency, Money
from garuda.marketdata.minute_bars import IVBar
from garuda.persistence import models
from garuda.persistence.derived_bars import DerivedBarStore, series_and_symbol, store_bars

pytestmark = pytest.mark.integration

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
OPEN = dt.datetime(2026, 9, 2, 9, 15, tzinfo=IST)
STRADDLE = InstrumentId("SYNTH:STRADDLE-NIFTY")


def rupees(amount: str) -> Money:
    return Money(Decimal(amount), Currency.INR)


def a_bar(
    at: dt.datetime,
    *,
    instrument: InstrumentId = STRADDLE,
    open_: str = "100",
    close: str = "110",
) -> Bar:
    """A coherent bar. High and low are widened to cover the two ends, so a
    test can vary the close without hand-maintaining the range."""
    ends = [Decimal(open_), Decimal(close)]
    return Bar(
        instrument=instrument,
        interval=BarInterval.ONE_MINUTE,
        start=at,
        open=rupees(open_),
        high=Money(max(ends), Currency.INR),
        low=Money(min(ends), Currency.INR),
        close=rupees(close),
    )


async def straddle_rows(
    sessions: async_sessionmaker[AsyncSession],
) -> list[models.StraddleBars1MinRow]:
    async with sessions() as db:
        found = await db.execute(
            select(models.StraddleBars1MinRow).order_by(models.StraddleBars1MinRow.bar_start)
        )
        return list(found.scalars())


class TestNamingTheSeries:
    def test_a_synthetic_splits_into_its_series_and_underlying(self) -> None:
        assert series_and_symbol("SYNTH:STRADDLE-NIFTY") == ("STRADDLE", "NIFTY")
        assert series_and_symbol("SYNTH:IV-BANKNIFTY") == ("IV", "BANKNIFTY")

    def test_an_ordinary_instrument_belongs_to_no_series(self) -> None:
        """Quietly writing a tradable into these tables would be worse than
        dropping it."""
        assert series_and_symbol("NSE:RELIANCE") is None
        assert series_and_symbol("SYNTH:") is None
        assert series_and_symbol("") is None


class TestStoringABar:
    async def test_a_bar_lands_with_its_prices_intact(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = DerivedBarStore(session_factory)

        assert await store.write("STRADDLE", "NIFTY", a_bar(OPEN)) is True

        [row] = await straddle_rows(session_factory)
        assert row.symbol == "NIFTY"
        assert (row.open, row.high, row.low, row.close) == (
            Decimal("100.000000"),
            Decimal("110.000000"),
            Decimal("100.000000"),
            Decimal("110.000000"),
        )

    async def test_decimals_survive_the_round_trip(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """123.45 is stored as 123.45, not rounded to a whole number."""
        store = DerivedBarStore(session_factory)

        await store.write("STRADDLE", "NIFTY", a_bar(OPEN, close="123.45"))

        [row] = await straddle_rows(session_factory)
        assert row.close == Decimal("123.450000")

    async def test_rewriting_a_minute_replaces_it_rather_than_doubling_it(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """What makes a restart mid-session safe: the half-written bar is
        simply written again, whole."""
        store = DerivedBarStore(session_factory)
        await store.write("STRADDLE", "NIFTY", a_bar(OPEN, close="110"))

        await store.write("STRADDLE", "NIFTY", a_bar(OPEN, close="150"))

        rows = await straddle_rows(session_factory)
        assert len(rows) == 1
        assert rows[0].close == Decimal("150.000000")

    async def test_a_bar_from_before_the_open_is_not_stored(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Pre-open prices are indicative, not traded. A 09:07 straddle bar
        built from them is indistinguishable in the table from a real one."""
        store = DerivedBarStore(session_factory)
        early = OPEN - dt.timedelta(minutes=8)

        assert await store.write("STRADDLE", "NIFTY", a_bar(early), not_before=OPEN) is False

        assert await straddle_rows(session_factory) == []

    async def test_a_bar_exactly_at_the_open_is_stored(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = DerivedBarStore(session_factory)

        assert await store.write("STRADDLE", "NIFTY", a_bar(OPEN), not_before=OPEN) is True

    async def test_the_volatility_series_is_not_written_through_this_path(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        """Its tick carries the two legs averaged; the table carries both with
        their strikes, written from a reading. Routing the tick here logged an
        error every minute for a bar the other path was already storing."""
        store = DerivedBarStore(session_factory)

        assert await store.write("IV", "NIFTY", a_bar(OPEN)) is False
        assert await store.write("IVSKEW", "NIFTY", a_bar(OPEN)) is False

    async def test_a_series_nobody_declared_is_refused_not_guessed(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = DerivedBarStore(session_factory)

        assert await store.write("VEGA", "NIFTY", a_bar(OPEN)) is False


class TestStoringTheVolatilityBar:
    async def test_both_legs_and_their_context_land(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = DerivedBarStore(session_factory)
        bar = IVBar(
            underlying=InstrumentId("NSE:NIFTY"),
            start=OPEN,
            call_open=Decimal("12.5"),
            call_high=Decimal("13"),
            call_low=Decimal("12"),
            call_close=Decimal("12.75"),
            put_open=Decimal("14.5"),
            put_high=Decimal("15"),
            put_low=Decimal("14"),
            put_close=Decimal("14.25"),
            call_strike=Decimal("25000"),
            put_strike=Decimal("25000"),
            spot_close=rupees("25010.55"),
        )

        assert await store.write_iv("NIFTY", bar) is True

        async with session_factory() as db:
            found = await db.execute(select(models.IvBars1MinRow))
            [row] = list(found.scalars())
        assert row.call_close == Decimal("12.750000")
        assert row.put_close == Decimal("14.250000")
        assert row.spot_close == Decimal("25010.550000")


class TestStoringManyAtOnce:
    async def test_only_the_engines_own_series_are_written(
        self, session_factory: async_sessionmaker[AsyncSession]
    ) -> None:
        store = DerivedBarStore(session_factory)
        bars = [
            a_bar(OPEN),
            a_bar(OPEN, instrument=InstrumentId("NSE:RELIANCE")),
            a_bar(OPEN, instrument=InstrumentId("SYNTH:PCR-NIFTY")),
        ]

        assert await store_bars(store, bars) == 2

        assert len(await straddle_rows(session_factory)) == 1
