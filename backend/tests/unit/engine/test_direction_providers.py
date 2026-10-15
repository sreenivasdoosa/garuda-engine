"""Direction providers: each answers LONG, SHORT, BOTH, or declines and says why."""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Currency, Money
from garuda.engine.direction_providers import Side, applicable, build, registered

IST = ZoneInfo("Asia/Kolkata")
TODAY = dt.date(2026, 10, 15)
NOW = dt.datetime(2026, 10, 15, 10, 30, tzinfo=IST)
NIFTY = InstrumentId("NSE:NIFTY")


def rupees(value: object) -> Money:
    return Money(Decimal(str(value)), Currency.INR)


def bar(start: dt.datetime, interval: BarInterval, o: int, h: int, low: int, c: int) -> Bar:
    return Bar(
        instrument=NIFTY,
        interval=interval,
        start=start,
        open=rupees(o),
        high=rupees(h),
        low=rupees(low),
        close=rupees(c),
    )


@dataclass
class Context:
    price: Decimal | None = Decimal(22500)
    bars: dict[BarInterval, list[Bar]] = field(default_factory=dict)
    series: dict[str, Decimal] = field(default_factory=dict)
    ago: dict[tuple[str, int], Decimal] = field(default_factory=dict)
    rules: Direction | None = None
    memory: Mapping[str, Any] = field(default_factory=dict)
    now: dt.datetime = NOW
    trading_day: dt.date = TODAY
    timezone: ZoneInfo = IST
    underlying: InstrumentId = NIFTY
    day_open: Decimal | None = None

    def spot(self, underlying: InstrumentId) -> Money | None:
        return rupees(self.price) if self.price is not None else None

    def quote(self, instrument: InstrumentId) -> Tick | None:
        if self.price is None:
            return None
        return Tick(
            instrument=instrument,
            last_price=rupees(self.price),
            timestamp=self.now,
            open=rupees(self.day_open) if self.day_open is not None else None,
        )

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        return self.bars.get(interval, [])[-count:]

    def synthetic(self, kind: str) -> Decimal | None:
        return self.series.get(kind)

    def synthetic_ago(self, kind: str, minutes: int) -> Decimal | None:
        return self.ago.get((kind, minutes))

    def indicator_direction(self) -> Direction | None:
        return self.rules


def decide(name: str, context: Context, **params: Any) -> Side | None:
    return build(name, params).decide(context).side


def test_every_reference_provider_is_registered() -> None:
    assert set(registered()) >= {
        "FIXED",
        "CANDLE",
        "INDICATOR",
        "PCR",
        "IV_SKEW",
        "N_BARS_BREAKOUT",
        "ORB_BREAKOUT",
    }


def test_an_unknown_provider_is_refused_by_name() -> None:
    with pytest.raises(DomainError, match="TEA_LEAVES"):
        build("TEA_LEAVES", {})


class TestFixed:
    def test_it_says_what_it_was_told(self) -> None:
        assert decide("FIXED", Context(), direction="SHORT") is Side.SHORT

    def test_none_means_no_trade(self) -> None:
        assert decide("FIXED", Context(), direction="NONE") is None


class TestNBarsBreakout:
    def bars(self, closes: list[int]) -> list[Bar]:
        start = dt.datetime(2026, 10, 15, 9, 15, tzinfo=IST)
        out = []
        for index, close in enumerate(closes):
            out.append(
                bar(
                    start + dt.timedelta(minutes=15 * index),
                    BarInterval.FIFTEEN_MINUTES,
                    close,
                    close + 5,
                    close - 5,
                    close,
                )
            )
        return out

    def test_a_close_above_the_high_is_bullish(self) -> None:
        context = Context(bars={BarInterval.FIFTEEN_MINUTES: self.bars([100, 102, 101, 120])})
        assert decide("N_BARS_BREAKOUT", context, lookbackBars=3) is Side.LONG

    def test_a_close_below_the_low_is_bearish_and_mappable(self) -> None:
        context = Context(bars={BarInterval.FIFTEEN_MINUTES: self.bars([100, 102, 101, 80])})
        assert decide("N_BARS_BREAKOUT", context, lookbackBars=3) is Side.SHORT
        assert decide("N_BARS_BREAKOUT", context, lookbackBars=3, onLowBreak="LONG") is Side.LONG

    def test_inside_the_range_declines_and_short_history_declines(self) -> None:
        inside = Context(bars={BarInterval.FIFTEEN_MINUTES: self.bars([100, 102, 101, 101])})
        assert decide("N_BARS_BREAKOUT", inside, lookbackBars=3) is None
        short = Context(bars={BarInterval.FIFTEEN_MINUTES: self.bars([100, 120])})
        assert decide("N_BARS_BREAKOUT", short, lookbackBars=3) is None


class TestOrbBreakout:
    def minutes(self) -> list[Bar]:
        start = dt.datetime(2026, 10, 15, 9, 15, tzinfo=IST)
        return [
            bar(
                start + dt.timedelta(minutes=m),
                BarInterval.ONE_MINUTE,
                22500,
                22520 + m,
                22480 - m,
                22500,
            )
            for m in range(15)
        ]

    def test_above_the_opening_range_is_bullish(self) -> None:
        context = Context(price=Decimal(22600), bars={BarInterval.ONE_MINUTE: self.minutes()})
        assert decide("ORB_BREAKOUT", context, rangeStart="09:15", rangeEnd="09:30") is Side.LONG

    def test_below_is_bearish_inside_declines(self) -> None:
        below = Context(price=Decimal(22400), bars={BarInterval.ONE_MINUTE: self.minutes()})
        assert decide("ORB_BREAKOUT", below, rangeStart="09:15", rangeEnd="09:30") is Side.SHORT
        inside = Context(price=Decimal(22500), bars={BarInterval.ONE_MINUTE: self.minutes()})
        assert decide("ORB_BREAKOUT", inside, rangeStart="09:15", rangeEnd="09:30") is None

    def test_before_the_range_closes_it_declines(self) -> None:
        early = Context(
            now=dt.datetime(2026, 10, 15, 9, 20, tzinfo=IST),
            bars={BarInterval.ONE_MINUTE: self.minutes()},
        )
        assert decide("ORB_BREAKOUT", early, rangeStart="09:15", rangeEnd="09:30") is None

    def test_an_inverted_window_is_refused(self) -> None:
        with pytest.raises(DomainError):
            build("ORB_BREAKOUT", {"rangeStart": "10:00", "rangeEnd": "09:30"})


class TestPcr:
    def test_threshold(self) -> None:
        assert decide("PCR", Context(series={"PCR": Decimal("0.8")})) is Side.SHORT
        assert decide("PCR", Context(series={"PCR": Decimal("1.2")})) is Side.LONG
        assert decide("PCR", Context(series={"PCR": Decimal("1.2")}), threshold="1.5") is Side.SHORT

    def test_trend(self) -> None:
        rising = Context(series={"PCR": Decimal("1.1")}, ago={("PCR", 15): Decimal("0.9")})
        assert decide("PCR", rising, comparisonMode="TREND") is Side.LONG
        assert decide("PCR", rising, comparisonMode="TREND", longWhen="DECREASING") is Side.SHORT

    def test_unpriced_declines(self) -> None:
        assert decide("PCR", Context()) is None


class TestIvSkew:
    def test_call_vol_above_put_vol_is_bearish(self) -> None:
        assert decide("IV_SKEW", Context(series={"IVSKEW": Decimal("1.5")})) is Side.SHORT
        assert decide("IV_SKEW", Context(series={"IVSKEW": Decimal("-0.5")})) is Side.LONG
        assert (
            decide("IV_SKEW", Context(series={"IVSKEW": Decimal(0)}), defaultDirection="SHORT")
            is Side.SHORT
        )


class TestCandle:
    def days(self) -> list[Bar]:
        return [
            bar(
                dt.datetime(2026, 10, 13, 9, 15, tzinfo=IST),
                BarInterval.ONE_DAY,
                22300,
                22450,
                22250,
                22400,
            ),
            bar(
                dt.datetime(2026, 10, 14, 9, 15, tzinfo=IST),
                BarInterval.ONE_DAY,
                22400,
                22550,
                22350,
                22450,
            ),
        ]

    def test_the_live_price_above_yesterdays_close_is_bullish(self) -> None:
        context = Context(price=Decimal(22500), bars={BarInterval.ONE_DAY: self.days()})
        assert decide("CANDLE", context) is Side.LONG
        assert decide("CANDLE", context, longWhen="LESS") is Side.SHORT

    def test_inside_the_neutral_band_declines(self) -> None:
        context = Context(price=Decimal(22460), bars={BarInterval.ONE_DAY: self.days()})
        assert decide("CANDLE", context, neutralBandPercent="0.1") is None

    def test_ref_vs_ref_compares_two_sessions(self) -> None:
        context = Context(bars={BarInterval.ONE_DAY: self.days()})
        # ref1 = yesterday's open 22400 vs ref2 = the day before's close 22400: >= is LONG
        assert decide("CANDLE", context, comparisonMode="REF_VS_REF") is Side.LONG


class TestIndicator:
    def test_it_follows_the_strategys_direction_rules(self) -> None:
        assert decide("INDICATOR", Context(rules=Direction.SHORT)) is Side.SHORT
        assert decide("INDICATOR", Context()) is None


class TestApplicableDirection:
    def test_it_suppresses_the_unwanted_side(self) -> None:
        assert applicable(Side.SHORT, {"applicableDirection": "LONG"}, provider_name="PCR") is None
        assert (
            applicable(Side.LONG, {"applicableDirection": "LONG"}, provider_name="PCR") is Side.LONG
        )
        assert (
            applicable(Side.BOTH, {"applicableDirection": "SHORT"}, provider_name="PCR")
            is Side.SHORT
        )

    def test_fixed_is_never_filtered(self) -> None:
        assert (
            applicable(Side.SHORT, {"applicableDirection": "LONG"}, provider_name="FIXED")
            is Side.SHORT
        )
