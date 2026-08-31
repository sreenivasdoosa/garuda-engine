"""Which way to trade.

The first rule with an opinion wins, so "use the skew, and if it is flat fall
back to the candle" is a list — which in the reference engine needs a new
provider class.
"""

from __future__ import annotations

from datetime import UTC, datetime, time, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Direction, Money
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.engine.direction import (
    CandleDirection,
    CandleReference,
    Compare,
    Fixed,
    IndicatorDirection,
    LongWhen,
    NBarsBreakout,
    PriceDirection,
    PriceType,
    ReferenceTime,
    SuperTrendDirection,
    build,
    first_answer,
)
from garuda.engine.direction.registry import DirectionRule

from .conftest import IST, UNDERLYING, FakeContext

NOW = datetime(2026, 8, 31, 10, 30, tzinfo=IST).astimezone(UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def day(offset: int, *, open_: str, close: str, high: str = "", low: str = "") -> Bar:
    start = datetime(2026, 8, 31, 9, 15, tzinfo=IST) + timedelta(days=offset)
    prices = sorted([Decimal(open_), Decimal(close)])
    return Bar(
        instrument=UNDERLYING,
        interval=BarInterval.ONE_DAY,
        start=start.astimezone(UTC),
        open=rupees(open_),
        high=rupees(high) if high else Money(prices[1], Currency.INR),
        low=rupees(low) if low else Money(prices[0], Currency.INR),
        close=rupees(close),
    )


def minute(at: time, *, offset: int, close: str) -> Bar:
    start = datetime.combine(
        datetime(2026, 8, 31, tzinfo=IST).date() + timedelta(days=offset), at, tzinfo=IST
    )
    return Bar(
        instrument=UNDERLYING,
        interval=BarInterval.ONE_MINUTE,
        start=start.astimezone(UTC),
        open=rupees(close),
        high=rupees(close),
        low=rupees(close),
        close=rupees(close),
    )


def quoting(context: FakeContext, price: str) -> None:
    context.quotes = {
        UNDERLYING: Tick(instrument=UNDERLYING, last_price=rupees(price), timestamp=NOW)
    }


# -- fixed ------------------------------------------------------------------


def test_a_fixed_direction_is_always_the_same(context: FakeContext) -> None:
    assert Fixed(Direction.SHORT).resolve(context) is Direction.SHORT


# -- first answer wins ------------------------------------------------------


def test_the_first_rule_with_an_opinion_wins(context: FakeContext) -> None:
    answered = first_answer([Fixed(Direction.LONG), Fixed(Direction.SHORT)], context)

    assert answered is Direction.LONG


def test_a_rule_with_no_opinion_defers_to_the_next(context: FakeContext) -> None:
    """ "Use the breakout, and if nothing has broken use this" is a list."""
    undecided = NBarsBreakout(bars=3)

    assert first_answer([undecided, Fixed(Direction.SHORT)], context) is Direction.SHORT


def test_nobody_having_an_opinion_stands_the_strategy_aside(
    context: FakeContext,
) -> None:
    assert first_answer([NBarsBreakout(bars=3)], context) is None


def test_a_rule_that_raises_lets_the_fallback_answer(context: FakeContext) -> None:
    """A broken provider must not stand a strategy down for the day when a
    perfectly good fallback was configured behind it."""

    class Broken:
        def resolve(self, ctx: object) -> Direction | None:
            raise RuntimeError("this provider is broken")

    rules: list[DirectionRule] = [Broken(), Fixed(Direction.LONG)]

    assert first_answer(rules, context) is Direction.LONG


# -- price against a reference ----------------------------------------------


def test_above_yesterday_s_close_is_long(context: FakeContext) -> None:
    quoting(context, "101")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-1, open_="99", close="100"),
            day(0, open_="100", close="101"),
        ]
    }
    rule = CandleDirection(reference=CandleReference(day_offset=-1))

    assert rule.resolve(context) is Direction.LONG


def test_below_yesterday_s_close_is_short(context: FakeContext) -> None:
    quoting(context, "98")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-1, open_="99", close="100"),
            day(0, open_="100", close="98"),
        ]
    }
    rule = CandleDirection(reference=CandleReference(day_offset=-1))

    assert rule.resolve(context) is Direction.SHORT


def test_long_when_less_inverts_the_comparison(context: FakeContext) -> None:
    """A mean-reversion strategy is the same rule the other way up."""
    quoting(context, "98")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-1, open_="99", close="100"),
            day(0, open_="100", close="98"),
        ]
    }
    rule = CandleDirection(reference=CandleReference(day_offset=-1), long_when=LongWhen.LESS)

    assert rule.resolve(context) is Direction.LONG


def test_the_price_type_selects_which_of_the_day_s_prices(context: FakeContext) -> None:
    """The day's high is the same reference with a different price, which the
    reference engine's spelling could not express at all."""
    quoting(context, "104")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-1, open_="99", close="100", high="105", low="98"),
            day(0, open_="100", close="104"),
        ]
    }
    rule = CandleDirection(reference=CandleReference(day_offset=-1, price=PriceType.HIGH))

    assert rule.resolve(context) is Direction.SHORT  # 104 is below yesterday's 105


def test_no_price_means_no_direction(context: FakeContext) -> None:
    context.bars = {(UNDERLYING, BarInterval.ONE_DAY): [day(0, open_="99", close="100")]}

    assert CandleDirection().resolve(context) is None


def test_history_that_does_not_reach_back_means_no_direction(
    context: FakeContext,
) -> None:
    quoting(context, "101")
    context.bars = {(UNDERLYING, BarInterval.ONE_DAY): [day(0, open_="99", close="100")]}

    rule = CandleDirection(reference=CandleReference(day_offset=-5))

    assert rule.resolve(context) is None


# -- one reference against another ------------------------------------------


def test_a_gap_up_is_long(context: FakeContext) -> None:
    """Yesterday's open against the day before's close."""
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-2, open_="95", close="100"),
            day(-1, open_="103", close="104"),
            day(0, open_="104", close="105"),
        ]
    }
    rule = CandleDirection(
        mode=Compare.REFERENCE_VS_REFERENCE,
        other=CandleReference(day_offset=-1, price=PriceType.OPEN),
        reference=CandleReference(day_offset=-2, price=PriceType.CLOSE),
    )

    assert rule.resolve(context) is Direction.LONG


def test_a_gap_down_is_short(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-2, open_="95", close="100"),
            day(-1, open_="97", close="98"),
            day(0, open_="98", close="99"),
        ]
    }
    rule = CandleDirection(
        mode=Compare.REFERENCE_VS_REFERENCE,
        other=CandleReference(day_offset=-1, price=PriceType.OPEN),
        reference=CandleReference(day_offset=-2, price=PriceType.CLOSE),
    )

    assert rule.resolve(context) is Direction.SHORT


def test_comparing_two_references_needs_a_second_one() -> None:
    with pytest.raises(DomainError, match="needs a second one"):
        CandleDirection(mode=Compare.REFERENCE_VS_REFERENCE)


# -- a reference at a time of day -------------------------------------------


def test_a_reference_at_a_particular_time_reads_a_minute_candle(
    context: FakeContext,
) -> None:
    quoting(context, "102")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_MINUTE): [
            minute(time(15, 27), offset=-1, close="100"),
            minute(time(15, 28), offset=-1, close="101"),
            minute(time(9, 16), offset=0, close="102"),
        ]
    }
    rule = CandleDirection(
        reference=CandleReference(when=ReferenceTime.AT, at=time(15, 27), day_offset=-1)
    )

    assert rule.resolve(context) is Direction.LONG


def test_a_time_nobody_traded_at_means_no_direction(context: FakeContext) -> None:
    quoting(context, "102")
    context.bars = {
        (UNDERLYING, BarInterval.ONE_MINUTE): [minute(time(9, 16), offset=0, close="102")]
    }
    rule = CandleDirection(
        reference=CandleReference(when=ReferenceTime.AT, at=time(3, 0), day_offset=0)
    )

    assert rule.resolve(context) is None


def test_a_reference_at_a_time_must_say_which_time() -> None:
    with pytest.raises(DomainError, match="must say which time"):
        CandleReference(when=ReferenceTime.AT)


def test_a_reference_in_the_future_is_not_history() -> None:
    with pytest.raises(DomainError, match="not history"):
        CandleReference(day_offset=1)


def test_a_reference_further_back_than_the_history_kept_is_refused() -> None:
    with pytest.raises(DomainError, match="further than"):
        CandleReference(day_offset=-100)


# -- breaking a range -------------------------------------------------------


def test_breaking_the_range_high_is_long(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-3, open_="99", close="100"),
            day(-2, open_="100", close="101"),
            day(-1, open_="101", close="100"),
            day(0, open_="100", close="105"),
        ]
    }

    assert NBarsBreakout(bars=3).resolve(context) is Direction.LONG


def test_breaking_the_range_low_is_short(context: FakeContext) -> None:
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-3, open_="99", close="100"),
            day(-2, open_="100", close="101"),
            day(-1, open_="101", close="100"),
            day(0, open_="100", close="90"),
        ]
    }

    assert NBarsBreakout(bars=3).resolve(context) is Direction.SHORT


def test_inside_the_range_there_is_no_opinion(context: FakeContext) -> None:
    """A breakout provider that guesses when nothing has broken is not one."""
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-3, open_="99", close="100"),
            day(-2, open_="100", close="105"),
            day(-1, open_="101", close="100"),
            day(0, open_="100", close="102"),
        ]
    }

    assert NBarsBreakout(bars=3).resolve(context) is None


def test_the_range_low_is_the_lowest_of_them_all_not_the_highest(
    context: FakeContext,
) -> None:
    """Below one bar's low is not a break of the range. A close at 99.5 is
    under the highest of the lows and above the lowest, and the range has not
    broken."""
    context.bars = {
        (UNDERLYING, BarInterval.ONE_DAY): [
            day(-3, open_="99", close="103", low="98"),
            day(-2, open_="100", close="101", low="100"),
            day(-1, open_="101", close="102", low="101"),
            day(0, open_="100", close="99.5"),
        ]
    }

    assert NBarsBreakout(bars=3).resolve(context) is None


def test_too_little_history_means_no_opinion(context: FakeContext) -> None:
    context.bars = {(UNDERLYING, BarInterval.ONE_DAY): [day(0, open_="100", close="105")]}

    assert NBarsBreakout(bars=3).resolve(context) is None


def test_a_breakout_of_no_bars_has_no_range() -> None:
    with pytest.raises(DomainError, match="no range to break"):
        NBarsBreakout(bars=0)


# -- configured -------------------------------------------------------------


def test_a_direction_rule_builds_from_configuration(context: FakeContext) -> None:
    built = build({"type": "fixed", "way": "SHORT"})

    assert built.resolve(context) is Direction.SHORT


def test_a_candle_rule_builds_with_its_references(context: FakeContext) -> None:
    built = build(
        {
            "type": "candle",
            "mode": "REF_VS_REF",
            "reference": {"day_offset": -2, "price": "CLOSE"},
            "other": {"day_offset": -1, "price": "OPEN"},
        }
    )

    assert isinstance(built, CandleDirection)
    assert built.reference.day_offset == -2


# -- from an indicator ------------------------------------------------------


def test_momentum_above_its_midpoint_is_long(context: FakeContext) -> None:
    context.indicators = {"RSI": Decimal(62)}

    assert IndicatorDirection().resolve(context) is Direction.LONG


def test_momentum_below_its_midpoint_is_short(context: FakeContext) -> None:
    context.indicators = {"RSI": Decimal(38)}

    assert IndicatorDirection().resolve(context) is Direction.SHORT


def test_an_indicator_exactly_on_the_level_still_answers(
    context: FakeContext,
) -> None:
    """Something has to break the tie, and having no opinion at the one value
    a configured level is most likely to be tested at is worse."""
    context.indicators = {"RSI": Decimal(50)}

    assert IndicatorDirection().resolve(context) is Direction.SHORT


def test_the_reading_can_be_inverted(context: FakeContext) -> None:
    """A mean-reversion strategy fades momentum rather than following it."""
    context.indicators = {"RSI": Decimal(62)}

    inverted = IndicatorDirection(long_when=LongWhen.LESS)

    assert inverted.resolve(context) is Direction.SHORT


def test_an_indicator_that_cannot_be_computed_has_no_opinion(
    context: FakeContext,
) -> None:
    assert IndicatorDirection().resolve(context) is None


def test_the_level_and_the_indicator_are_both_configurable(
    context: FakeContext,
) -> None:
    context.indicators = {"CCI": Decimal(120)}

    rule = IndicatorDirection(indicator="CCI", level=Decimal(100))

    assert rule.resolve(context) is Direction.LONG


# -- supertrend -------------------------------------------------------------


def test_price_above_the_supertrend_line_is_an_uptrend(context: FakeContext) -> None:
    context.indicators = {"supertrend": Decimal(95)}
    quoting(context, "100")

    assert SuperTrendDirection().resolve(context) is Direction.LONG


def test_price_below_the_supertrend_line_is_a_downtrend(context: FakeContext) -> None:
    context.indicators = {"supertrend": Decimal(105)}
    quoting(context, "100")

    assert SuperTrendDirection().resolve(context) is Direction.SHORT


def test_no_line_means_no_opinion(context: FakeContext) -> None:
    quoting(context, "100")

    assert SuperTrendDirection().resolve(context) is None


def test_no_price_means_no_opinion_either(context: FakeContext) -> None:
    """The reading is a side of the line, and without a price there is no
    side."""
    context.indicators = {"supertrend": Decimal(95)}

    assert SuperTrendDirection().resolve(context) is None


def test_an_indicator_direction_builds_from_configuration(
    context: FakeContext,
) -> None:
    context.indicators = {"RSI": Decimal(70)}

    built = build({"type": "indicator", "indicator": "RSI", "level": 60, "interval": "15m"})

    assert built.resolve(context) is Direction.LONG


# -- from a published series ------------------------------------------------

SKEW = InstrumentId("SYNTH:IVSKEW-NIFTY")
PCR = InstrumentId("SYNTH:PCR-NIFTY")


def publishing(context: FakeContext, instrument: InstrumentId, value: str) -> None:
    context.quotes = dict(context.quotes) | {
        instrument: Tick(instrument=instrument, last_price=rupees(value), timestamp=NOW)
    }


def test_a_positive_volatility_skew_is_long(context: FakeContext) -> None:
    """Calls dearer than puts: the market paying up for upside."""
    publishing(context, SKEW, "1.5")

    assert PriceDirection(instrument=SKEW).resolve(context) is Direction.LONG


def test_a_negative_volatility_skew_is_short(context: FakeContext) -> None:
    publishing(context, SKEW, "-1.5")

    assert PriceDirection(instrument=SKEW).resolve(context) is Direction.SHORT


def test_a_put_call_ratio_reads_against_its_own_level(context: FakeContext) -> None:
    """The same rule as the skew, against one rather than zero — which is what
    publishing both as instruments bought."""
    publishing(context, PCR, "1.4")

    rule = PriceDirection(instrument=PCR, level=Decimal(1))

    assert rule.resolve(context) is Direction.LONG


def test_a_low_put_call_ratio_is_short(context: FakeContext) -> None:
    publishing(context, PCR, "0.7")

    assert PriceDirection(instrument=PCR, level=Decimal(1)).resolve(context) is Direction.SHORT


def test_a_series_exactly_on_its_level_still_answers(context: FakeContext) -> None:
    publishing(context, SKEW, "0")

    assert PriceDirection(instrument=SKEW).resolve(context) is Direction.SHORT


def test_the_reading_can_be_inverted_for_a_contrarian(context: FakeContext) -> None:
    """A high put-call ratio read as capitulation rather than as fear."""
    publishing(context, PCR, "1.4")

    rule = PriceDirection(instrument=PCR, level=Decimal(1), long_when=LongWhen.LESS)

    assert rule.resolve(context) is Direction.SHORT


def test_a_series_nobody_is_publishing_has_no_opinion(context: FakeContext) -> None:
    assert PriceDirection(instrument=SKEW).resolve(context) is None


def test_a_price_direction_builds_from_configuration(context: FakeContext) -> None:
    publishing(context, PCR, "1.4")

    built = build({"type": "price", "instrument": "SYNTH:PCR-NIFTY", "level": 1})

    assert built.resolve(context) is Direction.LONG
