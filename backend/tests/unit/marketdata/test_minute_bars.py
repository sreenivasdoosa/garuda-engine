"""Folding ticks into one-minute bars.

Each test here pins a rule the reference market-data service learned the hard
way; the docstrings say which. Behavioural throughout: what bars came out for
what ticks, never how the folder holds them.
"""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, Tick
from garuda.domain.money import Currency, Money
from garuda.marketdata.minute_bars import IVMinuteBars, MinuteBars
from garuda.marketdata.synthetics import IVReading

IST = ZoneInfo("Asia/Kolkata")
STRADDLE = InstrumentId("SYNTH:STRADDLE-NIFTY")
OTHER = InstrumentId("SYNTH:PCR-NIFTY")


def rupees(amount: str) -> Money:
    return Money(Decimal(amount), Currency.INR)


def at(hour: int, minute: int, second: int = 0) -> datetime:
    return datetime(2026, 9, 2, hour, minute, second, tzinfo=IST)


def tick(price: str, when: datetime, instrument: InstrumentId = STRADDLE) -> Tick:
    return Tick(instrument=instrument, last_price=rupees(price), timestamp=when)


def folder() -> MinuteBars:
    return MinuteBars(timezone=IST)


class TestFormingABar:
    def test_the_first_tick_closes_nothing(self) -> None:
        assert folder().fold(tick("100", at(9, 20))) is None

    def test_the_bar_opens_high_low_and_close_at_the_first_price(self) -> None:
        bars = folder()
        bars.fold(tick("100", at(9, 20)))

        live = bars.live(STRADDLE)

        assert live is not None
        assert (live.open, live.high, live.low, live.close) == (
            rupees("100"),
            rupees("100"),
            rupees("100"),
            rupees("100"),
        )

    def test_later_ticks_in_the_minute_move_high_low_and_close_only(self) -> None:
        bars = folder()
        for price, second in (("100", 1), ("140", 20), ("80", 40), ("110", 59)):
            bars.fold(tick(price, at(9, 20, second)))

        live = bars.live(STRADDLE)

        assert live is not None
        assert live.open == rupees("100")
        assert live.high == rupees("140")
        assert live.low == rupees("80")
        assert live.close == rupees("110")

    def test_the_bar_is_stamped_with_the_start_of_its_minute(self) -> None:
        """Not the tick's own instant: two bars a minute apart must be a
        minute apart, not fifty-nine seconds."""
        bars = folder()
        bars.fold(tick("100", at(9, 20, 37)))

        live = bars.live(STRADDLE)

        assert live is not None
        assert live.start == at(9, 20, 0)


class TestClosingABar:
    def test_a_new_minute_closes_the_previous_bar(self) -> None:
        bars = folder()
        bars.fold(tick("100", at(9, 20, 10)))
        bars.fold(tick("120", at(9, 20, 50)))

        closed = bars.fold(tick("130", at(9, 21, 1)))

        assert closed is not None
        assert closed.start == at(9, 20)
        assert closed.close == rupees("120")

    def test_the_next_bar_opens_at_the_next_tick_not_the_last_close(self) -> None:
        """A rolling straddle steps when it rolls. Opening at the previous
        close would draw a continuous line across a discontinuity no position
        could have held."""
        bars = folder()
        bars.fold(tick("100", at(9, 20)))
        bars.fold(tick("500", at(9, 21)))

        live = bars.live(STRADDLE)

        assert live is not None
        assert live.open == rupees("500")

    def test_an_hour_boundary_closes_the_bar(self) -> None:
        """The reference compares the whole minute rather than the minute
        number, because comparing the number alone makes 12:59 and 13:59 the
        same bar and merges an hour into the one before it."""
        bars = folder()
        bars.fold(tick("100", at(12, 59, 30)))

        closed = bars.fold(tick("110", at(13, 59, 30)))

        assert closed is not None
        assert closed.start == at(12, 59)

    def test_a_quiet_minute_produces_no_bar_at_all(self) -> None:
        """Nothing is carried forward and no flat bar is invented: a bar at
        the last price cannot be told apart from a minute that genuinely
        traded there, and these series go quiet often."""
        bars = folder()
        bars.fold(tick("100", at(9, 20)))

        closed = bars.fold(tick("130", at(9, 25)))

        assert closed is not None
        assert closed.start == at(9, 20)
        # 9:21 through 9:24 simply do not exist.
        assert bars.live(STRADDLE) is not None
        assert bars.live(STRADDLE).start == at(9, 25)  # type: ignore[union-attr]


class TestSeveralSeriesAtOnce:
    def test_each_instrument_folds_independently(self) -> None:
        bars = folder()
        bars.fold(tick("100", at(9, 20), STRADDLE))
        bars.fold(tick("1.5", at(9, 20), OTHER))

        closed = bars.fold(tick("110", at(9, 21), STRADDLE))

        assert closed is not None
        assert closed.instrument == STRADDLE
        # The other series has not moved on and is still forming.
        other = bars.live(OTHER)
        assert other is not None
        assert other.start == at(9, 20)


class TestEndOfDay:
    def test_closing_up_yields_the_last_bar_of_each_series(self) -> None:
        """Without this the final minute is never written -- nothing arrives
        after it to roll it over."""
        bars = folder()
        bars.fold(tick("100", at(15, 29), STRADDLE))
        bars.fold(tick("1.5", at(15, 29), OTHER))

        closing = bars.close_all()

        assert [bar.instrument for bar in closing] == [OTHER, STRADDLE]

    def test_closing_up_twice_yields_nothing_the_second_time(self) -> None:
        bars = folder()
        bars.fold(tick("100", at(15, 29)))
        bars.close_all()

        assert bars.close_all() == []

    def test_a_new_day_starts_empty(self) -> None:
        bars = folder()
        bars.fold(tick("100", at(15, 29)))

        bars.forget_day()

        assert bars.live(STRADDLE) is None


def test_the_minute_is_the_exchanges_not_the_servers() -> None:
    """A minute boundary is a wall-clock instant on the floor. The same
    instant expressed in UTC must land in the same IST bar."""
    bars = folder()
    utc = ZoneInfo("UTC")
    # 09:20:30 IST is 03:50:30 UTC -- a different minute number entirely.
    bars.fold(tick("100", at(9, 20, 30).astimezone(utc)))

    live = bars.live(STRADDLE)

    assert live is not None
    assert live.start == at(9, 20)


def test_a_closed_bar_is_a_coherent_bar() -> None:
    """High is the highest seen and low the lowest, whatever order they came
    in -- the domain refuses a bar where that is not true."""
    bars = folder()
    for price in ("100", "60", "180", "90"):
        bars.fold(tick(price, at(9, 20)))

    closed = bars.fold(tick("95", at(9, 21)))

    assert isinstance(closed, Bar)
    assert closed.high == rupees("180")
    assert closed.low == rupees("60")


# -- the two-sided volatility bar -------------------------------------------

NIFTY = InstrumentId("NSE:NIFTY")


def reading(call: str, put: str, *, strike: str = "25000", spot: str = "25010") -> IVReading:
    return IVReading(
        call=Decimal(call),
        put=Decimal(put),
        call_strike=Decimal(strike),
        put_strike=Decimal(strike),
        spot=rupees(spot),
    )


class TestTheVolatilityBar:
    def test_both_legs_open_at_their_own_first_value(self) -> None:
        bars = IVMinuteBars(timezone=IST)
        bars.fold(NIFTY, reading("12", "14"), at(9, 20))

        live = bars.live(NIFTY)

        assert live is not None
        assert (live.call_open, live.put_open) == (Decimal("12"), Decimal("14"))

    def test_each_leg_tracks_its_own_high_and_low(self) -> None:
        """One row, two independent series. A call spiking must not drag the
        put's high with it."""
        bars = IVMinuteBars(timezone=IST)
        bars.fold(NIFTY, reading("12", "14"), at(9, 20, 1))
        bars.fold(NIFTY, reading("18", "13"), at(9, 20, 30))
        bars.fold(NIFTY, reading("15", "16"), at(9, 20, 50))

        live = bars.live(NIFTY)

        assert live is not None
        assert (live.call_high, live.call_low, live.call_close) == (
            Decimal("18"),
            Decimal("12"),
            Decimal("15"),
        )
        assert (live.put_high, live.put_low, live.put_close) == (
            Decimal("16"),
            Decimal("13"),
            Decimal("16"),
        )

    def test_a_new_minute_closes_the_bar(self) -> None:
        bars = IVMinuteBars(timezone=IST)
        bars.fold(NIFTY, reading("12", "14"), at(9, 20))

        closed = bars.fold(NIFTY, reading("13", "15"), at(9, 21))

        assert closed is not None
        assert closed.start == at(9, 20)
        assert closed.call_close == Decimal("12")

    def test_the_strike_and_spot_recorded_are_the_closing_ones(self) -> None:
        """They move only when the series rolls, and the next bar continues
        from where this one ended."""
        bars = IVMinuteBars(timezone=IST)
        bars.fold(NIFTY, reading("12", "14", strike="25000", spot="25010"), at(9, 20, 1))
        bars.fold(NIFTY, reading("12", "14", strike="25100", spot="25105"), at(9, 20, 50))

        closed = bars.fold(NIFTY, reading("12", "14"), at(9, 21))

        assert closed is not None
        assert closed.call_strike == Decimal("25100")
        assert closed.spot_close == rupees("25105")

    def test_the_last_bar_of_the_day_is_closed_up(self) -> None:
        bars = IVMinuteBars(timezone=IST)
        bars.fold(NIFTY, reading("12", "14"), at(15, 29))

        assert [bar.underlying for bar in bars.close_all()] == [NIFTY]
        assert bars.close_all() == []
