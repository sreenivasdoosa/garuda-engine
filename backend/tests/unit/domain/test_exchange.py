"""Exchanges: venue attributes as data, and settlement counted in trading days."""

from __future__ import annotations

from datetime import date

import pytest

from garuda.domain import Currency, DomainError, Exchange, Segment, SettlementCycle


class TestVenueAttributes:
    def test_the_timezone_comes_from_the_calendar(self, nse, nse_calendar):
        assert nse.timezone is nse_calendar.timezone

    def test_a_venue_reports_the_segments_it_trades(self, nse, mcx):
        assert nse.trades(Segment.FNO)
        assert not nse.trades(Segment.COMMODITY)
        assert mcx.trades(Segment.COMMODITY)

    def test_venues_can_differ_in_currency_without_any_special_casing(self, nse, cme):
        assert nse.currency is Currency.INR
        assert cme.currency is Currency.USD


class TestSettlement:
    def test_settlement_counts_in_trading_days_not_calendar_days(self, nse):
        """T+1 from a Friday settles on Monday, not Saturday."""
        friday = date(2026, 8, 28)
        assert friday.weekday() == 4
        assert nse.settlement_day(friday) == date(2026, 8, 31)

    def test_settlement_skips_a_holiday(self, nse):
        friday = date(2026, 1, 23)
        assert nse.settlement_day(friday) == date(2026, 1, 27)

    def test_a_cycle_knows_its_own_length(self):
        assert SettlementCycle.T0.days == 0
        assert SettlementCycle.T2.days == 2

    def test_t0_settles_on_the_trade_day_itself(self, nse_calendar):
        same_day = Exchange(
            code="SPOT",
            name="same-day settling venue",
            currency=Currency.INR,
            calendar=nse_calendar,
            settlement=SettlementCycle.T0,
            segments=frozenset({Segment.EQUITY}),
        )
        assert same_day.settlement_day(date(2026, 8, 27)) == date(2026, 8, 27)


class TestRejections:
    def test_a_lower_case_code_is_refused(self, nse_calendar):
        with pytest.raises(DomainError, match="upper-case"):
            Exchange(
                code="nse",
                name="x",
                currency=Currency.INR,
                calendar=nse_calendar,
                settlement=SettlementCycle.T1,
                segments=frozenset({Segment.EQUITY}),
            )

    def test_a_venue_that_trades_nothing_is_refused(self, nse_calendar):
        with pytest.raises(DomainError, match="no segments"):
            Exchange(
                code="NSE",
                name="x",
                currency=Currency.INR,
                calendar=nse_calendar,
                settlement=SettlementCycle.T1,
            )
