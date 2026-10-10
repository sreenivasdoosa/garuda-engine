"""Folding a stream of ticks into one-minute bars.

Ported from the reference market-data service's `StraddleUtility`, which does
this identically for all four derived series. Its rules, and why each one is
not an implementation detail:

* **The bar's minute comes from the tick's own timestamp, never a fresh read
  of the clock.** A tick that arrives late belongs to the minute it happened
  in, not the minute it was processed in -- otherwise a slow consumer quietly
  shifts the whole series forward and the shift is invisible in the data.

* **In the exchange's timezone.** A minute boundary is a wall-clock instant on
  the floor, and the server may be anywhere.

* **The whole minute is compared, not the minute number.** The reference
  carries a comment about this because it was a bug: comparing `.minute` alone
  makes 12:59 and 13:59 the same bar, so an hour of the day merges into the
  one before it once an hour.

* **A minute with no ticks produces no bar.** Nothing is carried forward and
  no empty bar is invented -- a flat bar at the last price is indistinguishable
  from a minute that genuinely traded there, and these series go quiet all the
  time.

* **The next bar opens at the next tick's price**, not at the closed bar's
  close. A roll in a rolling straddle steps the series; pinning the open to
  the previous close would draw a continuous line across a discontinuity that
  no position could have held.

The market-open guard lives with the writer rather than here, which is where
the reference puts it too: whether a bar is worth *storing* is a different
question from whether it closed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.marketdata.synthetics import IVReading

logger = logging.getLogger(__name__)


def minute_start(moment: datetime, timezone: ZoneInfo) -> datetime:
    """The start of the minute this instant falls in, on the exchange's clock."""
    return moment.astimezone(timezone).replace(second=0, microsecond=0)


@dataclass
class MinuteBars:
    """One in-progress bar per instrument, closed when its minute ends.

    Holds no clock. It is driven entirely by the timestamps on the ticks it is
    given, which is what lets a recorded session replay to the same bars.
    """

    timezone: ZoneInfo

    def __post_init__(self) -> None:
        self._open: dict[InstrumentId, Bar] = {}

    def fold(self, tick: Tick) -> Bar | None:
        """Take one tick. Answer the bar it *closed*, if it closed one.

        The returned bar is finished and will not change again. The bar the
        tick itself belongs to is still forming and is readable through
        :meth:`live`.
        """
        start = minute_start(tick.timestamp, self.timezone)
        current = self._open.get(tick.instrument)

        if current is not None and current.start == start:
            self._open[tick.instrument] = _extended(current, tick.last_price)
            return None

        # A different minute -- including, faithfully to the reference, an
        # *earlier* one. Ticks arriving out of order are rare and mean
        # something upstream is wrong; closing the bar makes that visible in
        # the series rather than silently folding the old tick into the new
        # minute.
        self._open[tick.instrument] = _opening(tick, start)
        return current

    def live(self, instrument: InstrumentId) -> Bar | None:
        """The bar still forming, for a chart that shows the current minute.

        The reference exposes the same thing, and for the same reason: a chart
        that only ever draws closed bars is up to fifty-nine seconds stale on
        the candle a trader is actually watching.
        """
        return self._open.get(instrument)

    def close_all(self) -> list[Bar]:
        """Every in-progress bar, closed. Run at the end of the session.

        Without this the last minute of the day is never written: nothing
        arrives after it to roll it over.
        """
        closing = sorted(self._open.values(), key=lambda bar: bar.instrument.value)
        self._open.clear()
        return closing

    def forget_day(self) -> None:
        """Drop everything in progress. Run at day-init."""
        self._open.clear()


def _opening(tick: Tick, start: datetime) -> Bar:
    price = tick.last_price
    return Bar(
        instrument=tick.instrument,
        interval=BarInterval.ONE_MINUTE,
        start=start,
        open=price,
        high=price,
        low=price,
        close=price,
    )


def _extended(bar: Bar, price: Money) -> Bar:
    """The same bar, having seen one more price. The open never moves."""
    return Bar(
        instrument=bar.instrument,
        interval=bar.interval,
        start=bar.start,
        open=bar.open,
        high=max(bar.high, price),
        low=min(bar.low, price),
        close=price,
        volume=bar.volume,
    )


@dataclass(frozen=True, slots=True)
class IVBar:
    """One minute of both volatility legs, as the reference records them.

    Two OHLC sets in one row rather than two rows: they are read together on
    every chart, and they are sampled together -- a minute where only the call
    had a bar would be a chart whose two lines cover different time.

    The strikes and the spot are the *closing* ones. They move only when the
    series rolls, and the value at the close is what the next bar continues
    from.
    """

    underlying: InstrumentId
    start: datetime
    call_open: Decimal
    call_high: Decimal
    call_low: Decimal
    call_close: Decimal
    put_open: Decimal
    put_high: Decimal
    put_low: Decimal
    put_close: Decimal
    call_strike: Decimal
    put_strike: Decimal
    spot_close: Money


@dataclass
class IVMinuteBars:
    """The same folding as :class:`MinuteBars`, over a two-sided reading.

    Kept separate rather than generalised: every rule is identical, but a bar
    with two sets of OHLC is not a :class:`Bar`, and forcing it to be one would
    mean either two half-covered series or a Bar whose fields mean different
    things depending on who reads it.
    """

    timezone: ZoneInfo

    def __post_init__(self) -> None:
        self._open: dict[InstrumentId, IVBar] = {}

    def fold(self, underlying: InstrumentId, reading: IVReading, at: datetime) -> IVBar | None:
        """Take one reading. Answer the bar it closed, if it closed one."""
        start = minute_start(at, self.timezone)
        current = self._open.get(underlying)

        if current is not None and current.start == start:
            self._open[underlying] = _iv_extended(current, reading)
            return None

        self._open[underlying] = _iv_opening(underlying, reading, start)
        return current

    def live(self, underlying: InstrumentId) -> IVBar | None:
        return self._open.get(underlying)

    def close_all(self) -> list[IVBar]:
        closing = sorted(self._open.values(), key=lambda bar: bar.underlying.value)
        self._open.clear()
        return closing

    def forget_day(self) -> None:
        self._open.clear()


def _iv_opening(underlying: InstrumentId, reading: IVReading, start: datetime) -> IVBar:
    return IVBar(
        underlying=underlying,
        start=start,
        call_open=reading.call,
        call_high=reading.call,
        call_low=reading.call,
        call_close=reading.call,
        put_open=reading.put,
        put_high=reading.put,
        put_low=reading.put,
        put_close=reading.put,
        call_strike=reading.call_strike,
        put_strike=reading.put_strike,
        spot_close=reading.spot,
    )


def _iv_extended(bar: IVBar, reading: IVReading) -> IVBar:
    """The same bar, having seen one more reading. Both opens stay put."""
    return IVBar(
        underlying=bar.underlying,
        start=bar.start,
        call_open=bar.call_open,
        call_high=max(bar.call_high, reading.call),
        call_low=min(bar.call_low, reading.call),
        call_close=reading.call,
        put_open=bar.put_open,
        put_high=max(bar.put_high, reading.put),
        put_low=min(bar.put_low, reading.put),
        put_close=reading.put,
        # The closing strike and spot, so a roll inside the minute is recorded
        # where it ended rather than where it began.
        call_strike=reading.call_strike,
        put_strike=reading.put_strike,
        spot_close=reading.spot,
    )
