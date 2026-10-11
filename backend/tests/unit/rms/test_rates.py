"""Counting how much an account has sent.

The counts themselves rather than the checks that read them: what falls out of
a window, what does not, and what a restart forgets.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.rms.rates import OrderRates

APPA = TradingClientId("appa")
AMMA = TradingClientId("amma")
CALL = InstrumentId("NFO:NIFTY26SEP25000CE")
PUT = InstrumentId("NFO:NIFTY26SEP25000PE")

T0 = datetime(2026, 9, 1, 10, 15, 30, tzinfo=UTC)


def test_nothing_sent_counts_nothing() -> None:
    counts = OrderRates().counted(APPA, CALL, T0)

    assert counts.this_second == 0
    assert counts.today == 0


def test_an_order_is_counted_in_every_window() -> None:
    rates = OrderRates()
    rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, CALL, T0)

    assert counts.this_second == 1
    assert counts.this_minute == 1
    assert counts.today == 1
    assert counts.today_on_instrument == 1


def test_the_next_second_starts_again() -> None:
    rates = OrderRates()
    for _ in range(9):
        rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, CALL, T0 + timedelta(seconds=1))

    assert counts.this_second == 0
    assert counts.this_minute == 9
    assert counts.today == 9


def test_the_next_minute_starts_again() -> None:
    rates = OrderRates()
    rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, CALL, T0 + timedelta(minutes=1))

    assert counts.this_minute == 0
    assert counts.today == 1


def test_the_next_day_starts_again() -> None:
    rates = OrderRates()
    rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, CALL, T0 + timedelta(days=1))

    assert counts.today == 0
    assert counts.today_on_instrument == 0


def test_another_account_is_counted_apart() -> None:
    rates = OrderRates()
    rates.record(APPA, CALL, T0)

    assert rates.counted(AMMA, CALL, T0).today == 0


def test_another_instrument_shares_the_day_but_not_its_own_count() -> None:
    """The daily cap is on the account and the per-instrument one is not."""
    rates = OrderRates()
    rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, PUT, T0)

    assert counts.today == 1
    assert counts.today_on_instrument == 0


def test_windows_that_have_passed_are_forgotten() -> None:
    """A session would otherwise leave one entry per second behind it --
    twenty-odd thousand by the close, for counts nothing will ask about."""
    rates = OrderRates()
    for second in range(50):
        rates.record(APPA, CALL, T0 + timedelta(seconds=second))

    kept = len(rates._seconds) + len(rates._minutes)

    assert kept <= 2


def test_the_day_is_kept_while_it_lasts() -> None:
    """The seconds go and the day does not: a day is the window."""
    rates = OrderRates()
    for second in range(50):
        rates.record(APPA, CALL, T0 + timedelta(seconds=second))

    assert rates.counted(APPA, CALL, T0 + timedelta(seconds=49)).today == 50


def test_a_restart_is_handed_what_the_account_already_sent_today() -> None:
    """The reference rebuilds its daily counter from the table on start."""
    rates = OrderRates()
    rates.preload(APPA, T0.date(), 7)
    rates.record(APPA, CALL, T0)

    counts = rates.counted(APPA, CALL, T0)

    assert counts.today == 8
    assert counts.today_on_instrument == 1, "only the account's total is restored"
    assert counts.this_second == 1
    assert rates.counted(AMMA, CALL, T0).today == 0


def test_a_preload_never_lowers_a_count_already_made() -> None:
    rates = OrderRates()
    rates.record(APPA, CALL, T0)
    rates.record(APPA, PUT, T0)
    rates.preload(APPA, T0.date(), 1)

    assert rates.counted(APPA, CALL, T0).today == 2
