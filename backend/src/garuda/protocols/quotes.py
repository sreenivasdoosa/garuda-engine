"""Asking a provider for a price, rather than waiting for one to arrive.

The feed pushes; this pulls. Both answer in :class:`Tick`, because a quote and
a tick describe the same thing -- what an instrument last traded at, with
whatever else the provider chose to send -- and having two shapes for that
would mean every consumer branching on where the price came from.

A quote is what the engine falls back to when the feed is stalled, what the
Console shows on a page nobody has subscribed from, and what confirms a
restored session still works. The OHLC call is separate because several
providers charge differently for it and answer it from a different endpoint;
it returns today's bar, not a series, which is :class:`HistorySource`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol, runtime_checkable

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, Tick


@runtime_checkable
class QuoteSource(Protocol):
    """Prices on demand, from one provider."""

    @property
    def name(self) -> str: ...

    async def quotes(self, instruments: Sequence[InstrumentId]) -> Mapping[InstrumentId, Tick]:
        """The last traded price for each, as far as the provider knows it.

        A mapping rather than a list so a partial answer is expressible: an
        instrument the provider does not know is **absent**, never a zero or a
        stale price wearing a fresh timestamp. Callers treat absence as "no
        price", which the risk gate already refuses to trade on.
        """
        ...

    async def ohlc(self, instruments: Sequence[InstrumentId]) -> Mapping[InstrumentId, Bar]:
        """Today's open, high, low and last, per instrument.

        The day's bar, not a series. Same partial-answer rule as `quotes`.
        """
        ...
