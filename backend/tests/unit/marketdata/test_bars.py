"""Keeping a series of bars honest."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from garuda.domain import Currency, Money
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.marketdata.bars import bars_per_session, closed_bars, is_stale

STOCK = InstrumentId("NSE:RELIANCE")
OPEN = datetime(2026, 8, 31, 9, 15, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def bar(minute: int, interval: BarInterval = BarInterval.ONE_MINUTE) -> Bar:
    return Bar(
        instrument=STOCK,
        interval=interval,
        start=OPEN + timedelta(minutes=minute),
        open=rupees("100"),
        high=rupees("101"),
        low=rupees("99"),
        close=rupees("100.5"),
    )


# -- the forming bar --------------------------------------------------------


def test_a_bar_still_forming_is_not_history() -> None:
    """An indicator over it moves as the bar fills, and can cross a threshold
    and uncross it inside the minute."""
    bars = [bar(0), bar(1)]

    closed = closed_bars(bars, now=OPEN + timedelta(minutes=1, seconds=30))

    assert list(closed) == [bar(0)]


def test_a_bar_whose_period_has_elapsed_is_closed() -> None:
    bars = [bar(0), bar(1)]

    closed = closed_bars(bars, now=OPEN + timedelta(minutes=2))

    assert list(closed) == bars


def test_a_bar_is_closed_even_if_nothing_traded_since() -> None:
    """The right answer for an illiquid strike: the period ended, so the bar
    ended."""
    bars = [bar(0)]

    closed = closed_bars(bars, now=OPEN + timedelta(hours=3))

    assert list(closed) == bars


def test_only_the_last_bar_can_be_incomplete() -> None:
    bars = [bar(0), bar(1), bar(2)]

    closed = closed_bars(bars, now=OPEN + timedelta(minutes=2, seconds=1))

    assert list(closed) == [bar(0), bar(1)]


def test_an_empty_series_stays_empty() -> None:
    assert list(closed_bars([], now=OPEN)) == []


def test_a_single_forming_bar_leaves_nothing() -> None:
    closed = closed_bars([bar(0)], now=OPEN + timedelta(seconds=30))

    assert list(closed) == []


# -- staleness --------------------------------------------------------------


def test_a_series_keeping_up_is_not_stale() -> None:
    bars = [bar(0), bar(1)]

    assert not is_stale(
        bars,
        now=OPEN + timedelta(minutes=2, seconds=30),
        interval=BarInterval.ONE_MINUTE,
        session_start=OPEN,
    )


def test_a_series_a_whole_interval_behind_is_stale() -> None:
    """One late bar is a slow provider; two is a series that has stopped."""
    bars = [bar(0), bar(1)]

    assert is_stale(
        bars,
        now=OPEN + timedelta(minutes=3),
        interval=BarInterval.ONE_MINUTE,
        session_start=OPEN,
    )


def test_a_stalled_feed_leaves_plausible_but_old_bars() -> None:
    bars = [bar(0)]

    assert is_stale(
        bars,
        now=OPEN + timedelta(hours=2),
        interval=BarInterval.ONE_MINUTE,
        session_start=OPEN,
    )


def test_nothing_is_stale_before_the_first_bar_was_due() -> None:
    """An empty series at the open is a session that has not produced one."""
    assert not is_stale(
        [], now=OPEN + timedelta(seconds=30), interval=BarInterval.ONE_MINUTE, session_start=OPEN
    )


def test_an_empty_series_well_after_the_open_is_stale() -> None:
    assert is_stale(
        [], now=OPEN + timedelta(minutes=30), interval=BarInterval.ONE_MINUTE, session_start=OPEN
    )


def test_a_slower_interval_is_given_longer_before_it_counts_as_stale() -> None:
    five = BarInterval.FIVE_MINUTES

    assert not is_stale([], now=OPEN + timedelta(minutes=7), interval=five, session_start=OPEN)
    assert is_stale([], now=OPEN + timedelta(minutes=11), interval=five, session_start=OPEN)


# -- sizing a request -------------------------------------------------------


@pytest.mark.parametrize(
    ("interval", "expected"),
    [
        (BarInterval.ONE_MINUTE, 375),
        (BarInterval.FIVE_MINUTES, 75),
        (BarInterval.ONE_HOUR, 6),
    ],
)
def test_a_session_produces_as_many_bars_as_it_has_room_for(
    interval: BarInterval, expected: int
) -> None:
    closes = OPEN + timedelta(hours=6, minutes=15)

    assert bars_per_session(interval, opens=OPEN, closes=closes) == expected


def test_a_venue_trading_into_the_night_produces_far_more() -> None:
    """Which is why this takes the session rather than assuming a number."""
    closes = OPEN + timedelta(hours=14, minutes=15)

    assert bars_per_session(BarInterval.ONE_MINUTE, opens=OPEN, closes=closes) == 855


def test_a_session_of_no_length_produces_none() -> None:
    assert bars_per_session(BarInterval.ONE_MINUTE, opens=OPEN, closes=OPEN) == 0


def test_a_session_that_closes_before_it_opens_produces_none() -> None:
    """Floor division on a negative span answers -1, which is worse than
    useless as a count."""
    assert (
        bars_per_session(BarInterval.ONE_MINUTE, opens=OPEN, closes=OPEN - timedelta(hours=1)) == 0
    )
