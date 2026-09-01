"""Market-data providers: who supplies ticks, quotes and candles.

One module per provider, all behind the same three contracts —
:class:`MarketDataFeed` for ticks, :class:`QuoteSource` for prices on demand,
:class:`HistorySource` for candles. What differs between them is authentication
and wire format, and both stop at this boundary.
"""
