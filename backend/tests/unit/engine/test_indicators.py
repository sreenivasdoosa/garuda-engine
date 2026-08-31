"""Indicators.

The numbers matter more than the shapes here. An operator compares what the
engine says against what their charting platform says, and "mine reads 62" is
not a conversation worth having — so the standard indicators are pinned to
their published worked examples.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.engine.indicators import (
    SuperTrend,
    build,
    compute,
    registered,
)

STOCK = InstrumentId("NSE:X")
T0 = datetime(2026, 8, 31, 9, 15, tzinfo=UTC)

#: Wilder's own worked example, as every reference reproduces it.
WILDER = [
    "44.34",
    "44.09",
    "44.15",
    "43.61",
    "44.33",
    "44.83",
    "45.10",
    "45.42",
    "45.84",
    "46.08",
    "45.89",
    "46.03",
    "45.61",
    "46.28",
    "46.28",
    "46.00",
    "46.03",
    "46.41",
    "46.22",
    "45.64",
]


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def flat(closes: list[str]) -> list[Bar]:
    """Bars with no range, for indicators that read only the close."""
    return [
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_DAY,
            start=T0 + timedelta(days=index),
            open=rupees(close),
            high=rupees(close),
            low=rupees(close),
            close=rupees(close),
        )
        for index, close in enumerate(closes)
    ]


def ranged(rows: list[tuple[str, str, str]]) -> list[Bar]:
    """Bars with a high, low and close."""
    return [
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_DAY,
            start=T0 + timedelta(days=index),
            open=rupees(low),
            high=rupees(high),
            low=rupees(low),
            close=rupees(close),
        )
        for index, (high, low, close) in enumerate(rows)
    ]


def near(value: Decimal | None, expected: str, places: str = "0.01") -> bool:
    assert value is not None
    return abs(value - Decimal(expected)) < Decimal(places)


# -- the published numbers --------------------------------------------------


def test_the_first_relative_strength_matches_wilder() -> None:
    """Fifteen closes, fourteen changes, and the number every reference gives."""
    value = compute("RSI", flat(WILDER[:15]), period=14)

    assert near(value, "70.46")


def test_relative_strength_after_one_more_bar() -> None:
    """The smoothing step, which is where a simple mean would diverge."""
    assert near(compute("RSI", flat(WILDER[:16]), period=14), "66.25")


def test_relative_strength_after_two_more_bars() -> None:
    assert near(compute("RSI", flat(WILDER[:17]), period=14), "66.48")


def test_nothing_falling_puts_the_index_at_its_ceiling() -> None:
    """The ratio is undefined and a chart shows 100."""
    rising = [str(100 + n) for n in range(20)]

    assert compute("RSI", flat(rising), period=14) == Decimal(100)


def test_a_simple_mean_is_the_mean_of_the_window() -> None:
    assert compute("SMA", flat(["10", "20", "30", "40"]), period=2) == Decimal(35)


def test_a_simple_mean_ignores_what_is_outside_the_window() -> None:
    assert compute("SMA", flat(["1", "1", "10", "20"]), period=2) == Decimal(15)


def test_an_exponential_average_is_the_standard_smoothing() -> None:
    """Pinned to the number, because 2/(n+1) and 2/n both look plausible and
    give different answers at a threshold."""
    # Seeded with mean(1,2,3) = 2, then alpha = 2/4 = 0.5 over 4 and 5.
    assert compute("EMA", flat(["1", "2", "3", "4", "5"]), period=3) == Decimal(4)


def test_an_exponential_average_reacts_faster_than_a_simple_one() -> None:
    """Which is the reason to use one. A steady climb suits both equally — it
    is a jump that separates them."""
    jumped = ["10"] * 10 + ["20"]
    exponential = compute("EMA", flat(jumped), period=5)
    simple = compute("SMA", flat(jumped), period=5)

    assert exponential is not None
    assert simple is not None
    assert exponential > simple


def test_the_true_range_accounts_for_a_gap() -> None:
    """A bar that opens beyond yesterday's close has a range larger than its
    own high minus low, and an average that missed that understates risk."""
    gapping = ranged([("10", "9", "10"), ("20", "19", "20")])

    # The second bar's own range is 1, but it opened ten above yesterday's
    # close — so the true range is 10, and an average that read 1 would
    # understate the risk by an order of magnitude.
    assert compute("ATR", gapping, period=1) == Decimal(10)


def test_the_average_true_range_smooths_the_way_wilder_did() -> None:
    steady = ranged([("11", "9", "10")] * 20)

    assert compute("ATR", steady, period=14) == Decimal(2)


def test_the_first_bar_is_not_averaged_into_the_true_range() -> None:
    """It has no previous close, so its range is not a true range — and a
    quiet first bar would understate the risk for the whole window."""
    # A still first bar, then two that gap by 10.
    bars = ranged([("10", "10", "10"), ("20", "20", "20"), ("30", "30", "30")])

    assert compute("ATR", bars, period=2) == Decimal(10)


def test_a_standard_deviation_of_a_flat_series_is_nothing() -> None:
    assert compute("STDDEV", flat(["10"] * 10), period=5) == Decimal(0)


def test_a_standard_deviation_measures_the_spread() -> None:
    value = compute("STDDEV", flat(["8", "12"]), period=2)

    assert value == Decimal(2)


# -- volume weighting -------------------------------------------------------


def test_volume_weighting_favours_the_heavier_bar() -> None:
    bars = [
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_MINUTE,
            start=T0,
            open=rupees("10"),
            high=rupees("10"),
            low=rupees("10"),
            close=rupees("10"),
            volume=1,
        ),
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_MINUTE,
            start=T0 + timedelta(minutes=1),
            open=rupees("20"),
            high=rupees("20"),
            low=rupees("20"),
            close=rupees("20"),
            volume=99,
        ),
    ]

    assert near(compute("VWAP", bars), "19.90")


def test_volume_weighting_uses_the_typical_price_not_the_close() -> None:
    """A bar that ranged widely and closed at one end is not represented by
    its close, which is the reason VWAP uses the typical price."""
    wide = Bar(
        instrument=STOCK,
        interval=BarInterval.ONE_MINUTE,
        start=T0,
        open=rupees("10"),
        high=rupees("30"),
        low=rupees("10"),
        close=rupees("10"),
        volume=10,
    )

    # (30 + 10 + 10) / 3, not the close of 10.
    assert near(compute("VWAP", [wide]), "16.67")


def test_a_bar_with_no_volume_is_not_counted_as_one_unit() -> None:
    """A feed that omits volume would otherwise turn this into a plain mean."""
    bars = [
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_MINUTE,
            start=T0,
            open=rupees("10"),
            high=rupees("10"),
            low=rupees("10"),
            close=rupees("10"),
        ),
        Bar(
            instrument=STOCK,
            interval=BarInterval.ONE_MINUTE,
            start=T0 + timedelta(minutes=1),
            open=rupees("20"),
            high=rupees("20"),
            low=rupees("20"),
            close=rupees("20"),
            volume=5,
        ),
    ]

    assert compute("VWAP", bars) == Decimal(20)


def test_no_volume_at_all_is_no_average() -> None:
    assert compute("VWAP", flat(["10", "20"])) is None


# -- supertrend -------------------------------------------------------------


def test_the_supertrend_line_sits_below_a_rising_close() -> None:
    """Which is what makes "close above supertrend" a trend test."""
    rising = ranged([(str(100 + n + 1), str(100 + n - 1), str(100 + n)) for n in range(40)])

    line = compute("SUPERTREND", rising, period=10, multiplier=Decimal(3))

    assert line is not None
    assert line < Decimal(139)


def test_the_supertrend_line_sits_above_a_falling_close() -> None:
    falling = ranged([(str(200 - n + 1), str(200 - n - 1), str(200 - n)) for n in range(40)])

    line = compute("SUPERTREND", falling, period=10, multiplier=Decimal(3))

    assert line is not None
    assert line > Decimal(161)


def test_the_trend_is_up_when_the_line_is_below() -> None:
    rising = ranged([(str(100 + n + 1), str(100 + n - 1), str(100 + n)) for n in range(40)])

    assert SuperTrend(period=10).rising(rising) is True


def test_the_trend_is_down_when_the_line_is_above() -> None:
    falling = ranged([(str(200 - n + 1), str(200 - n - 1), str(200 - n)) for n in range(40)])

    assert SuperTrend(period=10).rising(falling) is False


def test_a_wider_multiplier_puts_the_line_further_away() -> None:
    """Which is the whole point of the multiplier: a looser trend test."""
    rising = ranged([(str(100 + n + 1), str(100 + n - 1), str(100 + n)) for n in range(40)])

    near_line = compute("SUPERTREND", rising, period=10, multiplier=Decimal(2))
    far_line = compute("SUPERTREND", rising, period=10, multiplier=Decimal(5))

    assert near_line is not None
    assert far_line is not None
    assert far_line < near_line


def test_a_multiplier_of_nothing_makes_no_band() -> None:
    with pytest.raises(DomainError, match="makes no band"):
        SuperTrend(multiplier=Decimal(0))


# -- too little history -----------------------------------------------------


@pytest.mark.parametrize("name", ["RSI", "SMA", "EMA", "ATR", "STDDEV", "SUPERTREND"])
def test_too_little_history_is_no_value(name: str) -> None:
    """Not zero, and not a value computed from what happens to be there."""
    assert compute(name, flat(["10", "11"])) is None


def test_no_bars_at_all_is_no_value() -> None:
    assert compute("RSI", []) is None


def test_a_period_of_nothing_is_not_a_period() -> None:
    with pytest.raises(DomainError, match="not a period"):
        build("SMA", period=0)


# -- as plug-ins ------------------------------------------------------------


def test_an_indicator_nobody_registered_is_refused() -> None:
    with pytest.raises(DomainError, match="not a known indicator"):
        build("VIBES")


def test_a_parameter_nobody_recognises_is_refused() -> None:
    with pytest.raises(DomainError, match="takes no parameter"):
        build("RSI", perod=14)


def test_the_name_is_read_case_insensitively() -> None:
    assert compute("rsi", flat(WILDER), period=14) == compute("RSI", flat(WILDER), period=14)


def test_every_indicator_says_how_much_history_it_wants() -> None:
    """More than its strict minimum: Wilder's smoothing never quite forgets
    its seed, and a value from exactly the minimum differs from a chart's."""
    assert build("RSI", period=14).bars_needed > 14


def test_the_catalogue_lists_what_is_available() -> None:
    assert {"rsi", "atr", "supertrend"} <= set(registered())
