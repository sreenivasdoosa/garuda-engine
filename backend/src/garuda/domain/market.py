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
class Tick:
    """A last-traded price with whatever else the feed carried.

    Depth, open interest and volume are optional because feeds differ in what
    they publish; a missing value is ``None`` and never a zero standing in for
    one. RMS treats an absent price as a breach rather than guessing.
    """

    instrument: InstrumentId
    last_price: Money
    timestamp: datetime
    last_quantity: int | None = None
    volume: int | None = None
    open_interest: int | None = None
    bid: Money | None = None
    ask: Money | None = None
    bid_quantity: int | None = None
    ask_quantity: int | None = None

    def __post_init__(self) -> None:
        require_aware(self.timestamp)
        for name, price in (("bid", self.bid), ("ask", self.ask)):
            if price is not None and price.currency is not self.last_price.currency:
                raise DomainError(
                    f"{self.instrument}: {name} is {price.currency}, "
                    f"last price is {self.last_price.currency}"
                )

    @property
    def has_depth(self) -> bool:
        return self.bid is not None and self.ask is not None

    @property
    def spread(self) -> Money | None:
        """Ask minus bid, or None when the feed carried no depth."""
        if self.bid is None or self.ask is None:
            return None
        return self.ask - self.bid

    @property
    def mid(self) -> Money | None:
        if self.bid is None or self.ask is None:
            return None
        return (self.bid + self.ask) / 2


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
