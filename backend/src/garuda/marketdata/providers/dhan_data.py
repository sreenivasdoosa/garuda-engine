"""Dhan as a QuoteSource and a HistorySource.

The seam between :mod:`dhan_rest`, which speaks Dhan's shapes, and the engine's
protocols, which speak :class:`Tick` and :class:`Bar`. Everything
Dhan-specific -- the per-segment quote post, the columnar candles, the derived
`instrument` kind -- stops here.

Partial answers are the rule on both: an instrument the master does not list,
or one Dhan quotes nothing for, is **absent** from the mapping. It is never a
zero price, which the risk gate would happily trade on.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime
from decimal import Decimal

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Currency, Money
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_rest import (
    DhanDataError,
    DhanRest,
    bar_from_row,
    tick_from_quote,
)
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

PROVIDER = "dhan"


class DhanQuotes:
    """Prices on demand from Dhan."""

    def __init__(
        self,
        rest: DhanRest,
        catalogue: Callable[[], DhanCatalogue],
        registry: Callable[[], InstrumentRegistry],
        clock: Clock,
    ) -> None:
        self._rest = rest
        self._catalogue = catalogue
        self._registry = registry
        self._clock = clock

    @property
    def name(self) -> str:
        return PROVIDER

    async def quotes(self, instruments: Sequence[InstrumentId]) -> Mapping[InstrumentId, Tick]:
        answered = await self._raw(instruments)
        registry = self._registry()
        now = self._clock.now()

        ticks: dict[InstrumentId, Tick] = {}
        for instrument, quote in answered.items():
            held = registry.get(instrument)
            if held is None:
                continue
            like = Money(Decimal(1), held.currency)
            try:
                ticks[instrument] = tick_from_quote(instrument, quote, now, like)
            except DhanDataError as error:
                # One instrument Dhan has no price for must not cost the rest
                # of the batch. Absence is the answer for it.
                logger.debug("%s", error)
        return ticks

    async def ohlc(self, instruments: Sequence[InstrumentId]) -> Mapping[InstrumentId, Bar]:
        """Today's bar, from the same quote call.

        Dhan carries the day's open, high, low and close inside the quote, so
        there is no separate endpoint to spend a second rate-gate slot on.
        """
        answered = await self._raw(instruments)
        registry = self._registry()
        today = self._clock.now()

        bars: dict[InstrumentId, Bar] = {}
        for instrument, quote in answered.items():
            held = registry.get(instrument)
            if held is None:
                continue
            raw = quote.get("ohlc")
            if not isinstance(raw, dict):
                continue
            bar = _day_bar(instrument, raw, quote.get("last_price"), today, held.currency)
            if bar is not None:
                bars[instrument] = bar
        return bars

    async def _raw(
        self, instruments: Sequence[InstrumentId]
    ) -> dict[InstrumentId, Mapping[str, object]]:
        """One posted call, unpicked back into instruments.

        Dhan answers a segment map of a security-id map, and the security ids
        come back as strings even though they went out as numbers.
        """
        if not instruments:
            return {}
        catalogue = self._catalogue()
        grouped = catalogue.group_by_segment(instruments)
        if not grouped:
            return {}

        by_id: dict[tuple[str, str], InstrumentId] = {}
        request: dict[str, list[str]] = {}
        for segment, members in grouped.items():
            ids: list[str] = []
            for instrument in members:
                row = catalogue.details_for(instrument)
                if row is None:
                    continue
                ids.append(row.security_id)
                by_id[(segment, str(int(row.security_id)))] = instrument
            if ids:
                request[segment] = ids

        answer = await self._rest.quote(request)

        out: dict[InstrumentId, Mapping[str, object]] = {}
        for segment, rows in answer.items():
            for security_id, quote in rows.items():
                if not isinstance(quote, dict):
                    continue
                quoted = by_id.get((segment, str(security_id).strip()))
                if quoted is None:
                    continue
                out[quoted] = quote
        return out


class DhanHistory:
    """Dhan's candles, as a HistorySource."""

    def __init__(
        self,
        rest: DhanRest,
        catalogue: Callable[[], DhanCatalogue],
        registry: Callable[[], InstrumentRegistry],
    ) -> None:
        self._rest = rest
        self._catalogue = catalogue
        self._registry = registry

    async def fetch(
        self,
        instrument: InstrumentId,
        interval: BarInterval,
        start: datetime,
        end: datetime,
    ) -> Sequence[Bar]:
        """Candles in the range, oldest first.

        An instrument Dhan does not list answers nothing rather than raising:
        it is the same answer as no history, and it is the ordinary state for
        a strike listed after this morning's master was written.
        """
        if start >= end:
            return ()
        catalogue = self._catalogue()
        row = catalogue.details_for(instrument)
        kind = catalogue.history_kind(instrument)
        held = self._registry().get(instrument)
        if row is None or kind is None or held is None:
            logger.warning("%s is not in today's Dhan master; no history for it", instrument)
            return ()

        rows = await self._rest.candles(
            security_id=row.security_id,
            segment=row.segment,
            kind=kind,
            interval=interval,
            start=start,
            end=end,
        )
        like = Money(Decimal(1), held.currency)
        bars = [
            bar
            for candle in rows
            if (bar := bar_from_row(instrument, interval, candle, like)) is not None
        ]
        bars.sort(key=lambda bar: bar.start)
        return bars


def _day_bar(
    instrument: InstrumentId,
    ohlc: Mapping[str, object],
    last_price: object,
    at: datetime,
    currency: Currency,
) -> Bar | None:
    """Today's bar out of a quote's nested OHLC.

    The close is the **last traded price**, not the `close` field: in a quote
    that field is the *previous* day's close, and reading it as today's would
    make every intraday bar close where yesterday did.
    """
    try:
        opened = Money(Decimal(str(ohlc["open"])), currency)
        high = Money(Decimal(str(ohlc["high"])), currency)
        low = Money(Decimal(str(ohlc["low"])), currency)
        close = Money(Decimal(str(last_price)), currency)
    except Exception:
        return None
    if any(value.amount <= 0 for value in (opened, high, low, close)):
        return None
    try:
        return Bar(
            instrument=instrument,
            interval=BarInterval.ONE_DAY,
            start=at,
            open=opened,
            high=high,
            low=low,
            close=close,
        )
    except Exception:
        return None
