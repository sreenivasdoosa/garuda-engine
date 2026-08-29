"""Ticks, bars and trading clients."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.domain import Currency, DomainError, Money, NaiveDatetimeError
from garuda.domain.client import BrokerCode, TradingClient, TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, DepthLevel, Tick

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
        tick = Tick(
            INSTRUMENT,
            rupees("120"),
            NOW,
            bids=(DepthLevel(rupees("119.90"), 50),),
            asks=(DepthLevel(rupees("120.10"), 75),),
        )
        assert tick.has_depth
        assert tick.spread == rupees("0.20")
        assert tick.mid == rupees("120.00")

    def test_depth_in_another_currency_is_refused(self):
        with pytest.raises(DomainError, match="bid is USD"):
            Tick(
                INSTRUMENT,
                rupees("120"),
                NOW,
                bids=(DepthLevel(Money.of("119", Currency.USD), 50),),
            )

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


class TestTheDepthLadder:
    def test_the_touch_is_the_first_rung_not_a_second_copy_of_it(self):
        tick = Tick(
            INSTRUMENT,
            rupees("120"),
            NOW,
            bids=(DepthLevel(rupees("119.90"), 50), DepthLevel(rupees("119.85"), 100)),
            asks=(DepthLevel(rupees("120.10"), 60),),
        )
        assert tick.bid == rupees("119.90")
        assert tick.bid_quantity == 50
        assert tick.ask == rupees("120.10")
        assert tick.ask_quantity == 60

    def test_a_ladder_can_be_summed_for_liquidity(self):
        """A size check reads across rungs, not only the touch."""
        tick = Tick(
            INSTRUMENT,
            rupees("120"),
            NOW,
            asks=tuple(DepthLevel(rupees(f"120.{10 + i}"), 60) for i in range(5)),
        )
        assert sum(level.quantity for level in tick.asks) == 300

    def test_no_book_means_no_touch_rather_than_a_zero(self):
        tick = Tick(INSTRUMENT, rupees("120"), NOW)
        assert tick.bid is None
        assert tick.ask is None
        assert not tick.has_depth

    def test_a_rung_in_another_currency_is_refused(self):
        with pytest.raises(DomainError, match="a bid is"):
            Tick(
                INSTRUMENT,
                rupees("120"),
                NOW,
                bids=(DepthLevel(Money.of("119", Currency.USD), 50),),
            )

    def test_a_negative_quantity_is_not_a_depth_level(self):
        with pytest.raises(DomainError):
            DepthLevel(rupees("119.90"), -50)


class TestTheDaysNumbers:
    def test_the_change_is_measured_from_yesterdays_close(self):
        tick = Tick(INSTRUMENT, rupees("110"), NOW, previous_close=rupees("100"))
        assert tick.change_percent == Decimal(10)

    def test_a_fall_is_negative(self):
        tick = Tick(INSTRUMENT, rupees("90"), NOW, previous_close=rupees("100"))
        assert tick.change_percent == Decimal(-10)

    def test_without_a_previous_close_there_is_no_change(self):
        """A feed that sent none must not be answered with zero."""
        assert Tick(INSTRUMENT, rupees("110"), NOW).change_percent is None

    def test_a_previous_close_of_zero_does_not_divide(self):
        tick = Tick(INSTRUMENT, rupees("110"), NOW, previous_close=rupees("0"))
        assert tick.change_percent is None

    def test_the_days_range_is_carried_not_accumulated(self):
        """A restart at eleven cannot recompute a high it did not watch."""
        tick = Tick(
            INSTRUMENT,
            rupees("120"),
            NOW,
            open=rupees("110"),
            high=rupees("125"),
            low=rupees("108"),
        )
        assert (tick.open, tick.high, tick.low) == (rupees("110"), rupees("125"), rupees("108"))

    def test_a_days_number_in_another_currency_is_refused(self):
        with pytest.raises(DomainError, match="high is"):
            Tick(INSTRUMENT, rupees("120"), NOW, high=Money.of("125", Currency.USD))
