"""Dhan's REST shapes: the ones that are easy to get subtly wrong."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.domain.money import Currency, Money
from garuda.marketdata.providers.dhan_rest import (
    SUPPORTED_INTRADAY_MINUTES,
    bar_from_row,
    instrument_kind,
    nearest_supported,
    rows_from_columns,
    tick_from_quote,
)

NIFTY = InstrumentId("NSE:NIFTY26JUN21100CE")
NOW = datetime(2026, 9, 2, 6, 0, tzinfo=UTC)
RUPEE = Money(Decimal(1), Currency.INR)


class TestInstrumentKind:
    """Commodity and currency are decided before index-ness, so a commodity
    underlying is never mis-tagged as an index."""

    def test_an_index_option(self) -> None:
        assert (
            instrument_kind(segment="NSE_FNO", option_type="CE", is_future=False, is_index=True)
            == "OPTIDX"
        )

    def test_a_stock_option(self) -> None:
        assert (
            instrument_kind(segment="NSE_FNO", option_type="PE", is_future=False, is_index=False)
            == "OPTSTK"
        )

    def test_a_commodity_option_is_not_an_index_option(self) -> None:
        assert (
            instrument_kind(segment="MCX_COMM", option_type="CE", is_future=False, is_index=True)
            == "OPTFUT"
        )

    def test_a_currency_option_is_not_an_index_option(self) -> None:
        assert (
            instrument_kind(
                segment="NSE_CURRENCY", option_type="CE", is_future=False, is_index=True
            )
            == "OPTCUR"
        )

    def test_futures_follow_the_same_order(self) -> None:
        assert (
            instrument_kind(segment="MCX_COMM", option_type="", is_future=True, is_index=True)
            == "FUTCOM"
        )
        assert (
            instrument_kind(segment="NSE_FNO", option_type="", is_future=True, is_index=True)
            == "FUTIDX"
        )

    def test_the_index_segment_makes_it_an_index(self) -> None:
        assert (
            instrument_kind(segment="IDX_I", option_type="", is_future=False, is_index=False)
            == "INDEX"
        )

    def test_anything_else_is_equity(self) -> None:
        assert (
            instrument_kind(segment="NSE_EQ", option_type="", is_future=False, is_index=False)
            == "EQUITY"
        )


class TestIntervals:
    @pytest.mark.parametrize("minutes", SUPPORTED_INTRADAY_MINUTES)
    def test_a_supported_interval_is_left_alone(self, minutes: int) -> None:
        assert nearest_supported(minutes) == minutes

    def test_an_unsupported_interval_maps_to_the_nearest(self) -> None:
        """Returning nothing would read as 'no data' rather than 'not offered'."""
        assert nearest_supported(30) == 25
        assert nearest_supported(45) == 60
        assert nearest_supported(2) == 1

    def test_a_tie_goes_to_the_shorter_interval(self) -> None:
        """Three is equally far from one and five. One-minute candles aggregate
        into three; five-minute candles cannot be split into them."""
        assert nearest_supported(3) == 1
        assert nearest_supported(10) == 5
        assert nearest_supported(20) == 15


class TestColumnarCandles:
    def test_parallel_arrays_become_rows(self) -> None:
        payload = {
            "timestamp": [100, 200],
            "open": [1.0, 2.0],
            "high": [3.0, 4.0],
            "low": [0.5, 1.5],
            "close": [2.5, 3.5],
            "volume": [10, 20],
        }

        rows = rows_from_columns(payload)

        assert [row["timestamp"] for row in rows] == [100, 200]
        assert rows[1]["close"] == 3.5
        assert rows[1]["volume"] == 20

    def test_a_short_column_truncates_rather_than_mispairing(self) -> None:
        """Pairing past the shortest column attaches one candle's close to
        another candle's time."""
        payload = {
            "timestamp": [100, 200, 300],
            "open": [1.0, 2.0, 3.0],
            "high": [3.0, 4.0, 5.0],
            "low": [0.5, 1.5, 2.5],
            "close": [2.5, 3.5],
        }

        assert len(rows_from_columns(payload)) == 2

    def test_a_missing_column_yields_nothing(self) -> None:
        assert rows_from_columns({"timestamp": [1], "open": [1.0]}) == []

    def test_volume_is_optional(self) -> None:
        rows = rows_from_columns(
            {"timestamp": [1], "open": [1.0], "high": [2.0], "low": [0.5], "close": [1.5]}
        )

        assert rows[0].get("volume") is None


class TestQuotes:
    def test_the_days_range_is_read_from_the_nested_ohlc(self) -> None:
        """Read at the top level those four fields are simply absent, and the
        tick loses its day range with nothing looking wrong."""
        quote = {
            "last_price": 101.5,
            "last_quantity": 75,
            "volume": 5000,
            "average_price": 100.2,
            "buy_quantity": 900,
            "sell_quantity": 1100,
            "oi": 4321,
            "ohlc": {"open": 99.0, "high": 103.0, "low": 97.0, "close": 98.0},
        }

        tick = tick_from_quote(NIFTY, quote, NOW, RUPEE)

        assert tick.last_price.amount == Decimal("101.5")
        assert tick.open_interest == 4321
        day = (tick.open, tick.high, tick.low, tick.previous_close)
        assert [None if m is None else m.amount for m in day] == [
            Decimal("99.0"),
            Decimal("103.0"),
            Decimal("97.0"),
            Decimal("98.0"),
        ]

    def test_the_trade_time_is_read_in_indias_zone(self) -> None:
        quote = {"last_price": 100.0, "last_trade_time": "2026-09-02 11:30:00"}

        tick = tick_from_quote(NIFTY, quote, NOW, RUPEE)

        assert tick.timestamp.hour == 11
        assert tick.timestamp.utcoffset() is not None

    def test_an_unreadable_trade_time_falls_back_to_now(self) -> None:
        quote = {"last_price": 100.0, "last_trade_time": "not a time"}

        assert tick_from_quote(NIFTY, quote, NOW, RUPEE).timestamp == NOW

    def test_a_quote_with_no_price_is_refused(self) -> None:
        """An absent price is not a zero price. The risk gate already refuses
        to trade on a missing one."""
        from garuda.marketdata.providers.dhan_rest import DhanDataError

        with pytest.raises(DhanDataError, match="no last price"):
            tick_from_quote(NIFTY, {"volume": 10}, NOW, RUPEE)


class TestBars:
    def test_a_row_becomes_a_bar(self) -> None:
        row = {"timestamp": 1788000000, "open": 99.0, "high": 103.0, "low": 97.0, "close": 101.0}

        bar = bar_from_row(NIFTY, BarInterval.FIVE_MINUTES, row, RUPEE)

        assert bar is not None
        assert bar.close.amount == Decimal("101.0")
        assert bar.interval is BarInterval.FIVE_MINUTES

    def test_an_incoherent_bar_is_dropped_not_raised(self) -> None:
        """One bad candle at a session edge must not cost the month around it."""
        row = {"timestamp": 1788000000, "open": 99.0, "high": 50.0, "low": 97.0, "close": 101.0}

        assert bar_from_row(NIFTY, BarInterval.ONE_DAY, row, RUPEE) is None

    def test_a_row_missing_a_field_is_dropped(self) -> None:
        assert bar_from_row(NIFTY, BarInterval.ONE_DAY, {"timestamp": 1}, RUPEE) is None
