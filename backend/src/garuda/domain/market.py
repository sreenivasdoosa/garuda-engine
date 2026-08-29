"""Market data: ticks, quotes and bars.

Prices are :class:`Money`, not bare Decimals, so a price can never be added to
one from another currency -- the mistake a multi-venue engine makes exactly
once.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from enum import StrEnum

from garuda.domain.calendar import require_aware
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Money


class BarInterval(StrEnum):
    ONE_MINUTE = "1m"
    THREE_MINUTES = "3m"
    FIVE_MINUTES = "5m"
    FIFTEEN_MINUTES = "15m"
    THIRTY_MINUTES = "30m"
    ONE_HOUR = "1h"
    ONE_DAY = "1d"

    @property
    def duration(self) -> timedelta:
        return _INTERVAL_DURATIONS[self]


_INTERVAL_DURATIONS: dict[BarInterval, timedelta] = {
    BarInterval.ONE_MINUTE: timedelta(minutes=1),
    BarInterval.THREE_MINUTES: timedelta(minutes=3),
    BarInterval.FIVE_MINUTES: timedelta(minutes=5),
    BarInterval.FIFTEEN_MINUTES: timedelta(minutes=15),
    BarInterval.THIRTY_MINUTES: timedelta(minutes=30),
    BarInterval.ONE_HOUR: timedelta(hours=1),
    BarInterval.ONE_DAY: timedelta(days=1),
}


@dataclass(frozen=True, slots=True)
class DepthLevel:
    """One rung of the order book ladder."""

    price: Money
    quantity: int
    orders: int = 0

    def __post_init__(self) -> None:
        if self.quantity < 0 or self.orders < 0:
            raise DomainError(f"a depth level cannot have {self.quantity} at {self.price}")


@dataclass(frozen=True, slots=True)
class Tick:
    """A last-traded price with whatever else the feed carried.

    Depth, open interest and volume are optional because feeds differ in what
    they publish; a missing value is ``None`` and never a zero standing in for
    one. RMS treats an absent price as a breach rather than guessing.

    The day's open, high and low are the *exchange's* running values, carried
    on the tick rather than accumulated here -- a restart at eleven has no way
    to recompute a day high it did not watch, and a breakout strategy that
    thinks the day opened at eleven is worse than one that waits.

    ``previous_close`` is yesterday's close, not today's. The feed calls this
    field "close" and it is the single most confusable value on a tick: today
    has no close until the session ends.

    Depth is the full ladder, best price first, because a liquidity check sums
    across levels rather than reading only the touch. ``bid`` and ``ask`` are
    the top of that ladder by definition, not a second copy of it.
    """

    instrument: InstrumentId
    last_price: Money
    timestamp: datetime
    last_quantity: int | None = None
    average_price: Money | None = None
    volume: int | None = None
    total_buy_quantity: int | None = None
    total_sell_quantity: int | None = None
    open: Money | None = None
    high: Money | None = None
    low: Money | None = None
    previous_close: Money | None = None
    open_interest: int | None = None
    open_interest_day_high: int | None = None
    open_interest_day_low: int | None = None
    bids: tuple[DepthLevel, ...] = ()
    asks: tuple[DepthLevel, ...] = ()
    #: True for a tick built from a REST quote while the feed was stalled.
    #: Anything holding time-series state -- candle builders, indicator
    #: smoothers -- must skip these: they arrive at the poll cadence, not the
    #: tick cadence, and would corrupt the series. Trigger evaluation and
    #: trade tracking consume them, which is the point of the fallback.
    is_synthetic: bool = False

    def __post_init__(self) -> None:
        require_aware(self.timestamp)
        currency = self.last_price.currency
        for name, price in (
            ("average price", self.average_price),
            ("open", self.open),
            ("high", self.high),
            ("low", self.low),
            ("previous close", self.previous_close),
        ):
            if price is not None and price.currency is not currency:
                raise DomainError(
                    f"{self.instrument}: {name} is {price.currency}, last price is {currency}"
                )
        for side, levels in (("bid", self.bids), ("ask", self.asks)):
            for level in levels:
                if level.price.currency is not currency:
                    raise DomainError(
                        f"{self.instrument}: a {side} is {level.price.currency}, "
                        f"last price is {currency}"
                    )

    @property
    def bid(self) -> Money | None:
        return self.bids[0].price if self.bids else None

    @property
    def ask(self) -> Money | None:
        return self.asks[0].price if self.asks else None

    @property
    def bid_quantity(self) -> int | None:
        return self.bids[0].quantity if self.bids else None

    @property
    def ask_quantity(self) -> int | None:
        return self.asks[0].quantity if self.asks else None

    @property
    def has_depth(self) -> bool:
        return bool(self.bids) and bool(self.asks)

    @property
    def spread(self) -> Money | None:
        """Ask minus bid, or None when the feed carried no depth."""
        if not self.bids or not self.asks:
            return None
        return self.asks[0].price - self.bids[0].price

    @property
    def mid(self) -> Money | None:
        if not self.bids or not self.asks:
            return None
        return (self.bids[0].price + self.asks[0].price) / 2

    @property
    def change_percent(self) -> Decimal | None:
        """Move from yesterday's close, or None when the feed carried none.

        Computed rather than carried: feeds disagree about whether their
        "change" field is absolute or a percentage, and one that means the
        other is a silent factor-of-a-hundred error in a strategy filter.
        """
        if self.previous_close is None or self.previous_close.amount == 0:
            return None
        move = self.last_price.amount - self.previous_close.amount
        return move / self.previous_close.amount * Decimal(100)


@dataclass(frozen=True, slots=True)
class Bar:
    """One OHLC candle.

    ``start`` is the instant the bar opened; the bar covers
    ``[start, start + interval)``.
    """

    instrument: InstrumentId
    interval: BarInterval
    start: datetime
    open: Money
    high: Money
    low: Money
    close: Money
    volume: int | None = None
    open_interest: int | None = None

    def __post_init__(self) -> None:
        require_aware(self.start)
        currencies = {p.currency for p in (self.open, self.high, self.low, self.close)}
        if len(currencies) != 1:
            raise DomainError(f"{self.instrument}: a bar mixes currencies {currencies}")
        if self.high < self.open or self.high < self.close or self.high < self.low:
            raise DomainError(f"{self.instrument}: bar high {self.high} is not the highest price")
        if self.low > self.open or self.low > self.close:
            raise DomainError(f"{self.instrument}: bar low {self.low} is not the lowest price")

    @property
    def end(self) -> datetime:
        return self.start + self.interval.duration

    @property
    def range(self) -> Money:
        return self.high - self.low

    @property
    def is_bullish(self) -> bool:
        return self.close > self.open

    @property
    def typical_price(self) -> Money:
        """(high + low + close) / 3 — the usual basis for VWAP and CCI."""
        return (self.high + self.low + self.close) / Decimal(3)
