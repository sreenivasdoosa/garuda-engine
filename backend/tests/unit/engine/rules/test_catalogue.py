"""The first rules.

Between them these carry every shape configured in the reference engine today:
a tranche time, a cutoff, a level break, an indicator comparison, and a move
from a reference — which is the rolling-straddle condition that used to arrive
as an "external signal".
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.engine.rules.breakout import Breakout, Confirm, Way
from garuda.engine.rules.indicator import Comparator, IndicatorCompare
from garuda.engine.rules.outcome import Verdict
from garuda.engine.rules.price import PercentFromReference, PriceAbove, PriceBelow, Reference
from garuda.engine.rules.registry import build
from garuda.engine.rules.timing import AtOrAfter, Before, WithinWindow

from .conftest import IST, UNDERLYING, FakeContext

STRADDLE = InstrumentId("SYNTH:STRADDLE-X")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def at(hour: int, minute: int) -> datetime:
    """A venue-local wall clock time, as the instant the engine would see."""
    return datetime(2026, 8, 31, hour, minute, tzinfo=IST).astimezone(UTC)


def tick(instrument: InstrumentId, last: str, **carried: Money | None) -> Tick:
    return Tick(
        instrument=instrument,
        last_price=rupees(last),
        timestamp=at(10, 30),
        **carried,  # type: ignore[arg-type]
    )


def bar(instrument: InstrumentId, minute: int, close: str, **prices: str) -> Bar:
    opened = prices.get("open", close)
    return Bar(
        instrument=instrument,
        interval=BarInterval.ONE_MINUTE,
        start=at(9, 15) + timedelta(minutes=minute),
        open=rupees(opened),
        high=rupees(prices.get("high", max(opened, close, key=Decimal))),
        low=rupees(prices.get("low", min(opened, close, key=Decimal))),
        close=rupees(close),
    )


# -- the clock --------------------------------------------------------------


def test_a_tranche_time_is_reached(context: FakeContext) -> None:
    context.now = at(13, 0)

    assert AtOrAfter(time(13, 0)).evaluate(context).is_pass


def test_a_tranche_time_not_yet_reached(context: FakeContext) -> None:
    context.now = at(12, 59)

    assert AtOrAfter(time(13, 0)).evaluate(context).verdict is Verdict.FAIL


def test_the_time_is_the_venue_s_not_the_server_s(context: FakeContext) -> None:
    """13:00 in Mumbai is 07:30 UTC; a naive comparison would read it as 07:30
    and hold the tranche back for five and a half hours."""
    context.now = datetime(2026, 8, 31, 7, 30, tzinfo=UTC)

    assert AtOrAfter(time(13, 0)).evaluate(context).is_pass


def test_a_cutoff_holds_until_it_is_reached(context: FakeContext) -> None:
    context.now = at(14, 59)
    assert Before(time(15, 0)).evaluate(context).is_pass

    context.now = at(15, 0)
    assert not Before(time(15, 0)).evaluate(context).is_pass


def test_a_window_is_open_between_its_ends(context: FakeContext) -> None:
    window = WithinWindow(time(9, 30), time(15, 0))

    context.now = at(9, 30)
    assert window.evaluate(context).is_pass
    context.now = at(14, 59)
    assert window.evaluate(context).is_pass


def test_a_window_excludes_its_end(context: FakeContext) -> None:
    context.now = at(15, 0)

    assert not WithinWindow(time(9, 30), time(15, 0)).evaluate(context).is_pass


def test_a_window_that_is_never_open_is_refused() -> None:
    with pytest.raises(DomainError, match="never open"):
        WithinWindow(time(15, 0), time(9, 30))


# -- a level ----------------------------------------------------------------


def test_a_price_above_a_level(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "25100")}

    assert PriceAbove(Decimal(25000)).evaluate(context).is_pass


def test_volatility_needs_no_rule_of_its_own(context: FakeContext) -> None:
    """VIX is an instrument, so "VIX below 14" is price_below."""
    vix = InstrumentId("SYNTH:VIX")
    context.quotes = {vix: tick(vix, "13.4")}

    assert PriceBelow(Decimal(14), instrument=vix).evaluate(context).is_pass


def test_a_rule_with_no_instrument_is_about_the_underlying(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "100")}

    assert PriceBelow(Decimal(200)).evaluate(context).is_pass


def test_a_price_exactly_at_the_level_is_not_above_it(context: FakeContext) -> None:
    """ "Above" excludes the level. A strategy waiting for a break of 25000 has
    not had one when the price is 25000."""
    context.quotes = {UNDERLYING: tick(UNDERLYING, "25000")}

    assert not PriceAbove(Decimal(25000)).evaluate(context).is_pass


def test_a_price_exactly_at_the_level_is_not_below_it(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "25000")}

    assert not PriceBelow(Decimal(25000)).evaluate(context).is_pass


def test_a_price_that_is_not_published_cannot_be_judged(context: FakeContext) -> None:
    outcome = PriceAbove(Decimal(1)).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE
    assert outcome.blocks


# -- a move from a reference ------------------------------------------------


def test_the_rolling_straddle_is_ten_percent_below_its_open(
    context: FakeContext,
) -> None:
    """The condition that used to arrive as an external signal."""
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "270", open="270")]}

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.is_pass


def test_a_move_that_has_not_gone_far_enough(context: FakeContext) -> None:
    context.quotes = {STRADDLE: tick(STRADDLE, "260")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "270", open="270")]}

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.verdict is Verdict.FAIL


def test_a_move_further_than_asked_for_still_counts(context: FakeContext) -> None:
    context.quotes = {STRADDLE: tick(STRADDLE, "200")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "270", open="270")]}

    assert PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context).is_pass


def test_a_positive_percentage_means_above(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "101", open=rupees("100"))}

    assert PercentFromReference(Decimal(1)).evaluate(context).is_pass
    assert not PercentFromReference(Decimal(2)).evaluate(context).is_pass


def test_the_exchange_s_own_open_is_used_when_the_feed_carries_it(
    context: FakeContext,
) -> None:
    """Authoritative, and it saves reading a day of bars."""
    context.quotes = {UNDERLYING: tick(UNDERLYING, "90", open=rupees("100"))}

    outcome = PercentFromReference(Decimal(-10)).evaluate(context)

    assert outcome.is_pass
    assert not any(entry.startswith("candles:") for entry in context.asked)


def test_a_synthetic_falls_back_to_its_bars(context: FakeContext) -> None:
    """A synthetic's feed carries no exchange open, which is the path that
    matters for a rolling straddle."""
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "270", open="270")]}

    PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert any(entry.startswith("candles:") for entry in context.asked)


def test_no_reference_at_all_cannot_be_judged(context: FakeContext) -> None:
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_a_reference_of_zero_is_not_something_to_take_a_percentage_of(
    context: FakeContext,
) -> None:
    context.quotes = {STRADDLE: tick(STRADDLE, "10")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "0", open="0")]}

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_the_previous_close_is_not_in_today_s_bars(context: FakeContext) -> None:
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}
    context.bars = {(STRADDLE, BarInterval.ONE_MINUTE): [bar(STRADDLE, 0, "270", open="270")]}

    outcome = PercentFromReference(
        Decimal(-10), reference=Reference.PREVIOUS_CLOSE, instrument=STRADDLE
    ).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_yesterday_s_bars_are_not_today_s_open(context: FakeContext) -> None:
    """A day's reference is that day's. Measured from yesterday's open of 250
    the move is under 3%; from today's 270 it is the 10% the rule wants."""
    yesterday = replace(bar(STRADDLE, 0, "250", open="250"), start=at(9, 15) - timedelta(days=1))
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}
    context.bars = {
        (STRADDLE, BarInterval.ONE_MINUTE): [yesterday, bar(STRADDLE, 0, "270", open="270")]
    }

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.is_pass


def test_the_open_is_the_first_bar_of_the_day_not_the_latest(
    context: FakeContext,
) -> None:
    """The session's open, not the current minute's."""
    context.quotes = {STRADDLE: tick(STRADDLE, "243")}
    context.bars = {
        (STRADDLE, BarInterval.ONE_MINUTE): [
            bar(STRADDLE, 0, "270", open="270"),
            bar(STRADDLE, 1, "250", open="250"),
        ]
    }

    outcome = PercentFromReference(Decimal(-10), instrument=STRADDLE).evaluate(context)

    assert outcome.is_pass
    assert outcome.detail["reference"] == Decimal(270)


# -- breaking a level -------------------------------------------------------


def test_a_touch_breaks_on_the_latest_tick(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "25010")}

    assert Breakout(Decimal(25000)).evaluate(context).is_pass


def test_a_touch_below_breaks_downwards(context: FakeContext) -> None:
    context.quotes = {UNDERLYING: tick(UNDERLYING, "24990")}

    assert Breakout(Decimal(25000), way=Way.DOWN).evaluate(context).is_pass
    assert not Breakout(Decimal(25000), way=Way.UP).evaluate(context).is_pass


def test_a_close_needs_the_bar_to_have_closed_beyond(context: FakeContext) -> None:
    context.bars = {(UNDERLYING, BarInterval.ONE_MINUTE): [bar(UNDERLYING, 5, "25010")]}

    assert Breakout(Decimal(25000), confirm=Confirm.CLOSE).evaluate(context).is_pass


def test_a_close_inside_the_level_is_no_break(context: FakeContext) -> None:
    context.bars = {(UNDERLYING, BarInterval.ONE_MINUTE): [bar(UNDERLYING, 5, "24990")]}

    assert not Breakout(Decimal(25000), confirm=Confirm.CLOSE).evaluate(context).is_pass


def test_consecutive_needs_every_bar_to_agree(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_MINUTE): [
            bar(UNDERLYING, 4, "25010"),
            bar(UNDERLYING, 5, "24990"),
        ]
    }

    outcome = Breakout(Decimal(25000), confirm=Confirm.CONSECUTIVE, bars=2).evaluate(context)

    assert outcome.verdict is Verdict.FAIL


def test_consecutive_passes_when_they_all_do(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_MINUTE): [
            bar(UNDERLYING, 4, "25010"),
            bar(UNDERLYING, 5, "25020"),
        ]
    }

    assert Breakout(Decimal(25000), confirm=Confirm.CONSECUTIVE, bars=2).evaluate(context).is_pass


def test_consecutive_downwards_needs_every_bar_to_agree(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_MINUTE): [
            bar(UNDERLYING, 4, "24990"),
            bar(UNDERLYING, 5, "25010"),
        ]
    }

    outcome = Breakout(Decimal(25000), way=Way.DOWN, confirm=Confirm.CONSECUTIVE, bars=2).evaluate(
        context
    )

    assert outcome.verdict is Verdict.FAIL


def test_too_little_history_is_not_a_failed_break(context: FakeContext) -> None:
    """Saying "it did not break" when the bars are missing is a lie."""
    context.bars = {(UNDERLYING, BarInterval.ONE_MINUTE): [bar(UNDERLYING, 5, "25010")]}

    outcome = Breakout(Decimal(25000), confirm=Confirm.CONSECUTIVE, bars=3).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_a_break_confirmed_by_no_bars_is_refused() -> None:
    with pytest.raises(DomainError, match="not confirmed"):
        Breakout(Decimal(1), confirm=Confirm.CONSECUTIVE, bars=0)


# -- an indicator -----------------------------------------------------------


def test_an_indicator_above_a_number(context: FakeContext) -> None:
    context.indicators = {"RSI": Decimal(62)}

    outcome = IndicatorCompare("RSI", value=Decimal(60)).evaluate(context)

    assert outcome.is_pass


def test_an_indicator_below_a_number(context: FakeContext) -> None:
    context.indicators = {"RSI": Decimal(62)}

    outcome = IndicatorCompare("RSI", comparator=Comparator.BELOW, value=Decimal(60)).evaluate(
        context
    )

    assert outcome.verdict is Verdict.FAIL


def test_one_indicator_against_another(context: FakeContext) -> None:
    """ATR(20) below ATR(100) — contraction — with no rule of its own."""
    context.indicators = {"ATR": Decimal(5)}

    outcome = IndicatorCompare(
        "ATR",
        comparator=Comparator.BELOW,
        reference="ATR",
        params={"period": 20},
        reference_params={"period": 100},
    ).evaluate(context)

    # The fake answers the same value for both periods, so 5 is not below 5.
    assert outcome.verdict is Verdict.FAIL


def test_an_indicator_exactly_equal_is_not_above(context: FakeContext) -> None:
    context.indicators = {"RSI": Decimal(60)}

    assert not IndicatorCompare("RSI", value=Decimal(60)).evaluate(context).is_pass
    assert (
        IndicatorCompare("RSI", comparator=Comparator.AT_OR_ABOVE, value=Decimal(60))
        .evaluate(context)
        .is_pass
    )


def test_a_reference_indicator_may_use_its_own_interval(context: FakeContext) -> None:
    """A fast average against a slow one is two intervals of the same
    indicator, and reading both at the fast one compares it with itself."""
    context.indicators = {("EMA", "5m"): Decimal(101), ("EMA", "1h"): Decimal(99)}

    outcome = IndicatorCompare(
        "EMA",
        reference="EMA",
        interval=BarInterval.FIVE_MINUTES,
        reference_interval=BarInterval.ONE_HOUR,
    ).evaluate(context)

    assert outcome.is_pass


def test_a_reference_indicator_that_cannot_be_computed_blocks(
    context: FakeContext,
) -> None:
    """Half a comparison is not a comparison."""
    context.indicators = {("ATR", "5m"): Decimal(5)}

    outcome = IndicatorCompare(
        "ATR",
        comparator=Comparator.BELOW,
        reference="ATR",
        reference_interval=BarInterval.ONE_HOUR,
    ).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_an_indicator_that_cannot_be_computed_blocks(context: FakeContext) -> None:
    outcome = IndicatorCompare("RSI", value=Decimal(60)).evaluate(context)

    assert outcome.verdict is Verdict.UNAVAILABLE


def test_comparing_against_both_a_value_and_an_indicator_is_refused() -> None:
    with pytest.raises(DomainError, match="not both and not neither"):
        IndicatorCompare("RSI", value=Decimal(60), reference="EMA")


def test_comparing_against_nothing_is_refused() -> None:
    with pytest.raises(DomainError, match="not both and not neither"):
        IndicatorCompare("RSI")


# -- configured ------------------------------------------------------------


def test_the_whole_first_catalogue_builds_from_configuration(
    context: FakeContext,
) -> None:
    context.now = at(13, 30)
    context.quotes = {UNDERLYING: tick(UNDERLYING, "25100", open=rupees("25000"))}
    context.indicators = {"RSI": Decimal(62)}

    built = build(
        {
            "type": "all",
            "rules": [
                {"type": "at_or_after", "at": "13:00"},
                {"type": "before", "at": "15:00"},
                {"type": "price_above", "value": 25000},
                {"type": "percent_from_reference", "percent": "0.25"},
                {"type": "breakout", "level": 25050, "way": "up"},
                {"type": "indicator", "indicator": "RSI", "comparator": "gt", "value": 60},
            ],
        }
    )

    assert built.evaluate(context).is_pass
