"""Choosing an expiry from the instrument master."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import ClassVar

import pytest

from garuda.domain.enums import (
    ExerciseStyle,
    ExpiryKind,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.marketdata.registry import InstrumentRegistry


class TestChoosingAnExpiry:
    """Which contract a strategy means by "weekly" or "monthly".

    Both come from the master rather than from a rule about last Thursdays,
    because venues move their expiry days and a rule would be wrong the week
    they do.
    """

    def build(self, expiries: list[date], nse: Exchange) -> InstrumentRegistry:
        return InstrumentRegistry.build(
            [
                Instrument(
                    id=InstrumentId(f"NFO:X{expiry:%y%m%d}CE"),
                    exchange=nse,
                    segment=Segment.FNO,
                    kind=InstrumentKind.OPTION,
                    trading_symbol=f"X{expiry:%y%m%d}CE",
                    lot_size=75,
                    tick_size=Decimal("0.05"),
                    underlying=InstrumentId("NSE:X"),
                    expiry=expiry,
                    strike=Decimal(100),
                    option_type=OptionType.CALL,
                    exercise_style=ExerciseStyle.EUROPEAN,
                    settlement_type=SettlementType.CASH,
                )
                for expiry in expiries
            ]
        )

    #: Four Thursdays in September plus two in October.
    SEPTEMBER: ClassVar[list[date]] = [
        date(2026, 9, 3),
        date(2026, 9, 10),
        date(2026, 9, 17),
        date(2026, 9, 24),
    ]
    OCTOBER: ClassVar[list[date]] = [date(2026, 10, 1), date(2026, 10, 29)]

    def test_the_weekly_is_the_next_expiry_listed(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        chosen = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 1))

        assert chosen == date(2026, 9, 3)

    def test_an_offset_takes_a_later_weekly(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        chosen = registry.expiry_for(
            InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 1), offset=2
        )

        assert chosen == date(2026, 9, 17)

    def test_expiry_day_itself_is_still_the_immediate_expiry(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        chosen = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 3))

        assert chosen == date(2026, 9, 3)

    def test_the_monthly_is_the_last_expiry_of_the_month(self, nse: Exchange) -> None:
        registry = self.build([*self.SEPTEMBER, *self.OCTOBER], nse)

        chosen = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.MONTHLY, date(2026, 9, 1))

        assert chosen == date(2026, 9, 24)

    def test_the_next_monthly_is_the_last_of_the_next_month(self, nse: Exchange) -> None:
        registry = self.build([*self.SEPTEMBER, *self.OCTOBER], nse)

        chosen = registry.expiry_for(
            InstrumentId("NSE:X"), ExpiryKind.MONTHLY, date(2026, 9, 1), offset=1
        )

        assert chosen == date(2026, 10, 29)

    def test_the_monthly_is_a_weekly_too_in_the_week_it_falls_last(self, nse: Exchange) -> None:
        """The same date. Which series it belongs to is the strategy's choice,
        not a property of the contract."""
        registry = self.build([*self.SEPTEMBER, *self.OCTOBER], nse)
        on = date(2026, 9, 21)

        weekly = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.WEEKLY, on)
        monthly = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.MONTHLY, on)

        assert weekly == monthly == date(2026, 9, 24)

    def test_a_master_missing_this_week_refuses_rather_than_taking_next_week(
        self, nse: Exchange
    ) -> None:
        """Trading next week's expiry instead of this week's is quite different
        premiums, and nothing about it would look wrong."""
        registry = self.build([date(2026, 9, 24)], nse)

        chosen = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 1))

        assert chosen is None

    def test_a_master_missing_this_month_refuses_too(self, nse: Exchange) -> None:
        registry = self.build([date(2026, 12, 31)], nse)

        chosen = registry.expiry_for(InstrumentId("NSE:X"), ExpiryKind.MONTHLY, date(2026, 9, 1))

        assert chosen is None

    def test_an_offset_past_the_end_is_no_expiry(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        chosen = registry.expiry_for(
            InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 1), offset=9
        )

        assert chosen is None

    def test_an_underlying_with_no_derivatives_has_no_expiry(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        assert (
            registry.expiry_for(InstrumentId("NSE:NOTHING"), ExpiryKind.WEEKLY, date(2026, 9, 1))
            is None
        )

    def test_a_negative_offset_is_refused(self, nse: Exchange) -> None:
        registry = self.build(self.SEPTEMBER, nse)

        with pytest.raises(DomainError, match="offset"):
            registry.expiry_for(
                InstrumentId("NSE:X"), ExpiryKind.WEEKLY, date(2026, 9, 1), offset=-1
            )

    def test_every_month_contributes_exactly_one_monthly(self, nse: Exchange) -> None:
        registry = self.build([*self.SEPTEMBER, *self.OCTOBER], nse)

        monthly = registry.monthly_expiries_for(InstrumentId("NSE:X"))

        assert list(monthly) == [date(2026, 9, 24), date(2026, 10, 29)]
