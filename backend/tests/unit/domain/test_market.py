"""Ticks, bars and trading clients."""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from garuda.domain import Currency, DomainError, Money, NaiveDatetimeError
from garuda.domain.client import BrokerCode, TradingClient, TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick

INSTRUMENT = InstrumentId("NSE:NIFTY")
NOW = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


class TestTick:
    def test_a_tick_without_depth_reports_none_rather_than_zero(self):
        """A missing value is absent. Zero would read as a real price."""
        tick = Tick(INSTRUMENT, rupees("120"), NOW)
        assert not tick.has_depth
        assert tick.spread is None
        assert tick.mid is None

    def test_spread_and_mid_come_from_the_depth(self):
        tick = Tick(INSTRUMENT, rupees("120"), NOW, bid=rupees("119.90"), ask=rupees("120.10"))
        assert tick.has_depth
        assert tick.spread == rupees("0.20")
        assert tick.mid == rupees("120.00")

    def test_depth_in_another_currency_is_refused(self):
        with pytest.raises(DomainError, match="bid is USD"):
            Tick(INSTRUMENT, rupees("120"), NOW, bid=Money.of("119", Currency.USD))

    def test_a_naive_timestamp_is_refused(self):
        with pytest.raises(NaiveDatetimeError):
            Tick(INSTRUMENT, rupees("120"), datetime(2026, 8, 27, 9, 20))  # noqa: DTZ001


class TestBar:
    def bar(self, **overrides: object) -> Bar:
        base: dict[str, object] = {
            "instrument": INSTRUMENT,
            "interval": BarInterval.FIVE_MINUTES,
            "start": NOW,
            "open": rupees("100"),
            "high": rupees("110"),
            "low": rupees("95"),
            "close": rupees("105"),
        }
        return Bar(**{**base, **overrides})  # type: ignore[arg-type]

    def test_the_bar_covers_its_interval(self):
        bar = self.bar()
        assert (bar.end - bar.start) == BarInterval.FIVE_MINUTES.duration

    def test_range_and_direction(self):
        bar = self.bar()
        assert bar.range == rupees("15")
        assert bar.is_bullish

    def test_typical_price_is_the_hlc_mean(self):
        assert self.bar().typical_price == (rupees("110") + rupees("95") + rupees("105")) / 3

    def test_a_high_below_the_close_is_refused(self):
        """Broker candle APIs reconstruct bars from snapshots and get this wrong."""
        with pytest.raises(DomainError, match="not the highest"):
            self.bar(high=rupees("104"))

    def test_a_low_above_the_open_is_refused(self):
        with pytest.raises(DomainError, match="not the lowest"):
            self.bar(low=rupees("101"))

    def test_mixed_currencies_are_refused(self):
        with pytest.raises(DomainError, match="mixes currencies"):
            self.bar(close=Money.of("105", Currency.USD))


class TestTradingClient:
    def client(self, **overrides: object) -> TradingClient:
        base: dict[str, object] = {
            "id": TradingClientId("family-1"),
            "display_name": "Appa — Zerodha",
            "broker": BrokerCode.ZERODHA,
            "client_id": "AB1234",
        }
        return TradingClient(**{**base, **overrides})  # type: ignore[arg-type]

    def test_the_account_key_is_broker_and_client_id(self):
        assert self.client().account_key == (BrokerCode.ZERODHA, "AB1234")

    def test_two_accounts_at_the_same_broker_are_distinct(self):
        first = self.client(id=TradingClientId("a"), client_id="AB1234")
        second = self.client(id=TradingClientId("b"), client_id="CD5678")
        assert first.account_key != second.account_key

    def test_a_client_without_a_display_name_is_refused(self):
        with pytest.raises(DomainError, match="display name"):
            self.client(display_name="   ")

    def test_a_client_without_a_broker_client_id_is_refused(self):
        with pytest.raises(DomainError, match="broker client id"):
            self.client(client_id="")

    def test_paper_is_a_broker_code_because_orders_route_to_it(self):
        assert BrokerCode.PAPER in set(BrokerCode)
