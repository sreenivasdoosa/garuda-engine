"""Folding the series the engine prices into minute bars, and keeping them.

The publisher puts a synthetic on the hub and it is gone; this is what gives
it a past. It sits beside the publisher rather than inside it because they
answer different questions -- one is "what is the straddle worth right now",
which the engine trades off, and the other is "what did it do this morning",
which only a chart asks.

Nothing here is allowed to disturb the engine. A bar that cannot be folded or
cannot be written costs a minute of chart and nothing else, so every path
swallows its failure and says so in the log.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, Tick
from garuda.marketdata.minute_bars import IVMinuteBars, MinuteBars
from garuda.marketdata.synthetics import ChainView, ImpliedVolatility
from garuda.persistence.derived_bars import DerivedBarStore, series_and_symbol

logger = logging.getLogger(__name__)


@dataclass
class DerivedSeriesRecorder:
    """One minute-folder per shape, and somewhere to put what closes."""

    store: DerivedBarStore
    timezone: ZoneInfo
    #: The volatility series to sample, by underlying. Empty when no symbol
    #: has asked for IV, and then nothing walks the chain for it.
    volatility: tuple[tuple[InstrumentId, ImpliedVolatility], ...] = ()
    #: When the underlying's **own** venue opened today, per symbol. Bars from
    #: before it are not stored, which is the reference's rule -- pre-open
    #: prices are indicative rather than traded, and a bar built from them is
    #: indistinguishable in the table from a real one.
    #:
    #: Per symbol because a venue's session is a property of the venue: MCX
    #: trades until half past eleven at night and NSE closes at half past
    #: three. Guarding every series with one venue's window, which is what
    #: this used to do, drops a commodity's whole evening -- silently, because
    #: the rejection is a debug line and an empty chart looks like a quiet
    #: series.
    session_start: Callable[[str], datetime | None] | None = None
    _bars: MinuteBars = field(init=False)
    _iv: IVMinuteBars = field(init=False)

    def __post_init__(self) -> None:
        self._bars = MinuteBars(timezone=self.timezone)
        self._iv = IVMinuteBars(timezone=self.timezone)

    async def record(
        self,
        ticks: tuple[Tick, ...],
        view: ChainView,
        now: datetime,
    ) -> None:
        """Fold this round's synthetics, and store whatever minute they closed.

        The IV series is sampled from the chain rather than from the published
        tick, because the tick carries the average of the two legs and the
        stored series carries both. One walk either way -- the reading is
        taken from the same chain the publisher just used.
        """
        try:
            closed = [bar for tick in ticks if (bar := self._bars.fold(tick)) is not None]
            await self._store(closed)
        except Exception:
            logger.exception("could not fold the derived series into minute bars")

        for underlying, source in self.volatility:
            try:
                reading = source.reading(view)
                if reading is None:
                    continue
                closed_iv = self._iv.fold(underlying, reading, now)
                if closed_iv is not None:
                    symbol = _name(underlying)
                    await self.store.write_iv(symbol, closed_iv, not_before=self._opened(symbol))
            except Exception:
                logger.exception("could not record implied volatility for %s", underlying)

    async def _store(self, closed: list[Bar]) -> None:
        """Write each closed bar, guarded by its own venue's open."""
        for bar in closed:
            split = series_and_symbol(bar.instrument.value)
            if split is None:
                continue
            series, symbol = split
            await self.store.write(series, symbol, bar, not_before=self._opened(symbol))

    def _opened(self, symbol: str) -> datetime | None:
        """When this symbol's venue opened today, or None when unknown.

        None stores the bar. An unknown venue is not a reason to throw away a
        series the operator asked for; the guard exists to keep indicative
        pre-open prices out, not to be the arbiter of what may be kept.
        """
        if self.session_start is None:
            return None
        try:
            return self.session_start(symbol)
        except Exception:
            logger.exception("could not tell when %s opened; storing the bar anyway", symbol)
            return None

    async def close_day(self) -> None:
        """Write the minute still in progress. Run when the session ends.

        Without it the last minute of the day is never stored: nothing arrives
        after it to roll it over.
        """
        try:
            await self._store(self._bars.close_all())
            for bar in self._iv.close_all():
                symbol = _name(bar.underlying)
                await self.store.write_iv(symbol, bar, not_before=self._opened(symbol))
        except Exception:
            logger.exception("could not store the last minute of the derived series")

    def forget_day(self) -> None:
        self._bars.forget_day()
        self._iv.forget_day()


def _name(underlying: InstrumentId) -> str:
    """``NSE:NIFTY`` is stored as ``NIFTY``: the table is keyed by underlying,
    and the exchange is already implied by the symbol row."""
    _, _, symbol = underlying.value.partition(":")
    return symbol or underlying.value
