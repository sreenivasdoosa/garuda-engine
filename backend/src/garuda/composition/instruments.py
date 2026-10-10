"""Building the instrument loader.

The broker's master says what exists. The ``symbols`` table says what those
things *are* -- which spot carries an underlying's price, how far apart its
strikes sit, how many units a lot is. Neither is enough alone, and the loader
is where they meet.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator, Mapping
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.brokers.zerodha.instruments import download_master
from garuda.domain.exchange import Exchange
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.cache import InstrumentCache
from garuda.marketdata.loader import InstrumentLoader
from garuda.persistence.models import SymbolsRow
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)


class SymbolBook(Mapping[str, SymbolInfo]):
    """The curated symbols, swappable while the engine runs.

    A `Mapping`, so everything that already takes one is unchanged -- the
    engine, the watchlist, the market view. What it adds is
    :meth:`replace`: the contents are swapped in place, so every holder sees
    the new configuration at once rather than the snapshot it was handed at
    startup.

    That is the whole point. Turning a derived series on for CRUDEOIL used to
    write a row and change nothing until a restart, because the symbols were
    read once during build and captured by four different components. A
    version counter lets a consumer that has to *rebuild* something -- the
    synthetic sources, say -- notice that it must.
    """

    def __init__(self, symbols: Mapping[str, SymbolInfo] | None = None) -> None:
        self._symbols: dict[str, SymbolInfo] = dict(symbols or {})
        #: Bumped on every swap. A consumer compares it against what it last
        #: built from; equal means nothing to redo.
        self.version = 0

    def replace(self, symbols: Mapping[str, SymbolInfo]) -> None:
        """Take the new configuration whole. Never merged: a symbol deleted
        from the table has to disappear, and a merge would keep it forever."""
        self._symbols = dict(symbols)
        self.version += 1
        logger.info("symbols reloaded: %d curated (version %d)", len(self._symbols), self.version)

    def __getitem__(self, symbol: str) -> SymbolInfo:
        return self._symbols[symbol]

    def __iter__(self) -> Iterator[str]:
        return iter(self._symbols)

    def __len__(self) -> int:
        return len(self._symbols)


async def load_symbols(sessions: async_sessionmaker[AsyncSession]) -> dict[str, SymbolInfo]:
    """Every curated underlying, keyed by symbol.

    A row the domain refuses -- a zero strike gap, a blank symbol -- is skipped
    with its reason rather than taking the whole load down. One bad row must
    not cost the other four hundred.
    """
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.symbols.all()

    loaded: dict[str, SymbolInfo] = {}
    for row in rows:
        try:
            loaded[row.symbol] = _symbol_from(row)
        except Exception as error:
            logger.warning("symbol %s is not usable: %s", row.symbol, error)
    logger.info("%d underlyings curated", len(loaded))
    return loaded


def _symbol_from(row: SymbolsRow) -> SymbolInfo:
    defaults = SymbolInfo(symbol=row.symbol, exchange_code=row.exchange or "NSE")
    return SymbolInfo(
        symbol=row.symbol,
        exchange_code=row.exchange or "NSE",
        is_index=bool(row.is_index),
        index_symbol=row.index_symbol,
        strike_gap=Decimal(row.strike_gap) if row.strike_gap else defaults.strike_gap,
        freeze_limit_quantity=row.freeze_limit_qty,
        contract_multiplier=(
            Decimal(row.contract_multiplier)
            if row.contract_multiplier
            else defaults.contract_multiplier
        ),
        option_chain_levels=(
            row.max_option_chain_levels
            if row.max_option_chain_levels is not None
            else defaults.option_chain_levels
        ),
        has_weekly_options=bool(row.has_options_weekly_expiry),
        has_monthly_options=(
            bool(row.has_options_monthly_expiry)
            if row.has_options_monthly_expiry is not None
            else defaults.has_monthly_options
        ),
        has_weekly_futures=bool(row.has_futures_weekly_expiry),
        has_monthly_futures=(
            bool(row.has_futures_monthly_expiry)
            if row.has_futures_monthly_expiry is not None
            else defaults.has_monthly_futures
        ),
        hedge_strike_rounding=Decimal(row.hedge_strike_rounding_multiple or 0),
        derives_straddle=bool(row.derives_straddle),
        derives_pcr=bool(row.derives_pcr),
        derives_iv=bool(row.derives_iv),
        derives_synthetic=bool(row.derives_synthetic),
        pcr_strikes_each_side=row.pcr_strikes_each_side,
        display_order=row.display_order,
    )


def build_loader(
    *,
    broker: str,
    directory: Path,
    exchanges: Mapping[str, Exchange],
    symbols: Mapping[str, SymbolInfo],
    timezone: ZoneInfo,
    clock: Clock,
    http: httpx.AsyncClient,
) -> InstrumentLoader:
    """The loader for one broker's master, cached under ``directory``.

    The directory is not created here. Building a loader is something a
    read-only inspection does, and it has no business writing to disk; the
    cache creates the directory when it first writes a master.
    """
    cache = InstrumentCache(directory, clock)

    async def download() -> str:
        return await download_master(http)

    return InstrumentLoader(
        broker=broker,
        cache=cache,
        download=download,
        exchanges=exchanges,
        symbols=symbols,
        timezone=timezone,
    )
