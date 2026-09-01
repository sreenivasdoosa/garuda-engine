"""The closed-bar history trade management reads.

Trailing by ATR or SuperTrend needs an indicator over closed bars, and trade
management sits below market data: it cannot reach for a cache, only take a
narrow view of one. This is that view, satisfying `trademgmt.trailing.CandleView`.

The same `CandleCache` the rules read, so a strategy trailing by SuperTrend
and a rule testing SuperTrend see the same bars. **Not** the same cached
indicator values -- a rule's cache lasts one evaluation and exists to stop ten
rules computing one indicator ten times, while this is asked once per trade
every fifteen seconds and would keep a value past the bar that changed it.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING

from garuda.domain.errors import DomainError
from garuda.domain.money import Currency, Money
from garuda.engine.indicators import build as build_indicator

if TYPE_CHECKING:
    from garuda.domain.instrument import InstrumentId
    from garuda.domain.market import BarInterval
    from garuda.marketdata.history import CandleCache

logger = logging.getLogger(__name__)


class CachedCandles:
    """Indicators and closes over whatever history has been fetched."""

    def __init__(self, candles: CandleCache, *, currency: Currency = Currency.INR) -> None:
        self._candles = candles
        self._currency = currency

    def indicator(
        self,
        instrument: InstrumentId,
        interval: BarInterval,
        name: str,
        params: Mapping[str, object],
    ) -> Money | None:
        """One indicator over closed bars, as a price.

        None when the history is too short, which is a morning rather than a
        fault. An indicator or parameter nobody knows is a configuration
        error and is refused when the strategy is read, so reaching here with
        one is a defect worth a line in the log rather than a stop to
        trailing.
        """
        try:
            built = build_indicator(name, **dict(params))
        except DomainError:
            logger.exception("%s is not an indicator this engine has", name)
            return None

        bars = self._candles.get(instrument, interval, built.bars_needed)
        value = built.compute(bars)
        return Money(value, self._currency) if value is not None else None

    def last_close(self, instrument: InstrumentId, interval: BarInterval) -> Money | None:
        """The close of the last bar that finished.

        Never the bar still forming: a stop placed off a half-formed bar moves
        as the bar fills, which is the repainting the whole candle path avoids.
        """
        bars = self._candles.get(instrument, interval, 1)
        return bars[-1].close if bars else None
