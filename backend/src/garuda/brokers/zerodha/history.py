"""Candle history from Kite.

One request per interval, chunked when the span exceeds what the broker will
answer in one go. Those limits are the broker's and differ per interval — a
month of one-minute candles is the most it will give, against five years of
daily ones — so a naive single request for a long lookback fails rather than
truncating, which is the sort of thing that looks like missing data.

Prices arrive as JSON numbers and become ``Decimal`` through their text. A
candle that passed through a float would be a defect the whole engine is
arranged to prevent, and it would not look like one.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from garuda.brokers.zerodha.rest import KiteClient
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.domain.money import Currency, Money
from garuda.marketdata.registry import InstrumentRegistry

logger = logging.getLogger(__name__)

#: What Kite calls each interval.
KITE_INTERVALS: Final[dict[BarInterval, str]] = {
    BarInterval.ONE_MINUTE: "minute",
    BarInterval.THREE_MINUTES: "3minute",
    BarInterval.FIVE_MINUTES: "5minute",
    BarInterval.FIFTEEN_MINUTES: "15minute",
    BarInterval.THIRTY_MINUTES: "30minute",
    BarInterval.ONE_HOUR: "60minute",
    BarInterval.ONE_DAY: "day",
}

#: The longest span Kite answers in one request, per interval. Exceeding it is
#: an error rather than a truncation, so a long lookback is chunked.
MAX_SPAN: Final[dict[BarInterval, timedelta]] = {
    BarInterval.ONE_MINUTE: timedelta(days=30),
    BarInterval.THREE_MINUTES: timedelta(days=45),
    BarInterval.FIVE_MINUTES: timedelta(days=60),
    BarInterval.FIFTEEN_MINUTES: timedelta(days=150),
    BarInterval.THIRTY_MINUTES: timedelta(days=175),
    BarInterval.ONE_HOUR: timedelta(days=200),
    BarInterval.ONE_DAY: timedelta(days=1800),
}

#: How Kite wants the range expressed.
_WHEN = "%Y-%m-%d %H:%M:%S"


class ZerodhaHistory:
    """Kite's historical candles, as a HistorySource."""

    def __init__(self, client: KiteClient, registry: Callable[[], InstrumentRegistry]) -> None:
        self._client = client
        self._registry = registry

    async def fetch(
        self,
        instrument: InstrumentId,
        interval: BarInterval,
        start: datetime,
        end: datetime,
    ) -> Sequence[Bar]:
        """Candles in the range, oldest first.

        An instrument the master does not know answers nothing rather than
        raising: it is the same answer as no history, and it is the ordinary
        state for a strike listed after this morning's master was written.
        """
        registry = self._registry()
        held = registry.get(instrument)
        token = registry.token_for(instrument)
        if held is None or token is None:
            logger.warning("%s is not in today's master; no history for it", instrument)
            return ()
        if start >= end:
            return ()

        bars: list[Bar] = []
        for window_start, window_end in _windows(start, end, MAX_SPAN[interval]):
            bars.extend(
                await self._one(
                    instrument, token, interval, window_start, window_end, held.currency
                )
            )
        return bars

    async def _one(
        self,
        instrument: InstrumentId,
        token: str,
        interval: BarInterval,
        start: datetime,
        end: datetime,
        currency: Currency,
    ) -> Sequence[Bar]:
        payload = await self._client.get(
            f"/instruments/historical/{token}/{KITE_INTERVALS[interval]}",
            {"from": start.strftime(_WHEN), "to": end.strftime(_WHEN)},
        )
        rows = (payload or {}).get("candles") or []
        return [
            bar for row in rows if (bar := _bar(instrument, interval, row, currency)) is not None
        ]


def _windows(start: datetime, end: datetime, span: timedelta) -> list[tuple[datetime, datetime]]:
    """The range, split into what the broker will answer."""
    windows: list[tuple[datetime, datetime]] = []
    cursor = start
    while cursor < end:
        stop = min(cursor + span, end)
        windows.append((cursor, stop))
        cursor = stop
    return windows


def _bar(
    instrument: InstrumentId, interval: BarInterval, row: object, currency: Currency
) -> Bar | None:
    """One candle row, or None if it is not one.

    A malformed row is skipped rather than failing the batch. One bad candle
    in a month of them must not cost the month.
    """
    if not isinstance(row, Sequence) or isinstance(row, str) or len(row) < 5:
        logger.warning("%s: unreadable candle %r", instrument, row)
        return None

    try:
        started = _moment(row[0])
        return Bar(
            instrument=instrument,
            interval=interval,
            start=started,
            open=_price(row[1], currency),
            high=_price(row[2], currency),
            low=_price(row[3], currency),
            close=_price(row[4], currency),
            volume=int(row[5]) if len(row) > 5 and row[5] is not None else None,
            open_interest=int(row[6]) if len(row) > 6 and row[6] is not None else None,
        )
    except (DomainError, InvalidOperation, TypeError, ValueError) as error:
        logger.warning("%s: unusable candle %r (%s)", instrument, row, error)
        return None


def _moment(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    parsed = datetime.fromisoformat(str(value))
    if parsed.tzinfo is None:
        raise ValueError(f"candle time {value!r} carries no timezone")
    return parsed


def _price(value: Any, currency: Currency) -> Money:
    """Through the text, always: Decimal(0.1) is not one tenth."""
    return Money(Decimal(str(value)), currency)
