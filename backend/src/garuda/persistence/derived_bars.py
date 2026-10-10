"""Keeping the series the engine prices for itself.

A rolling straddle, a put-call ratio, a synthetic future and the two
volatility legs are published as ticks and then gone. A chart needs a past, so
each is also folded to one-minute bars and written here.

Ported from the reference market-data service, including two rules that look
like details and are not:

* **A bar starting before the market opened is not stored.** The reference
  checks this at insert. Pre-open ticks are quote-driven rather than traded,
  and a 09:07 straddle bar built from indicative prices is indistinguishable
  in the table from a real one.

* **A failed write never disturbs the engine.** These bars are a record, not
  part of any decision -- nothing sizes, gates or exits off them. A store that
  is down costs the chart, not the trading. So nothing here raises.

Writes are upserts on `(symbol, bar_start)`. Re-running a minute replaces it,
which is what makes a restart mid-session safe: the bar that was half-written
is simply written again, whole.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from sqlalchemy.dialects.postgresql import insert

from garuda.persistence.models import (
    IvBars1MinRow,
    PcrBars1MinRow,
    StraddleBars1MinRow,
    SyntheticBars1MinRow,
)
from garuda.persistence.uow import UnitOfWork

if TYPE_CHECKING:
    from collections.abc import Sequence
    from datetime import datetime
    from decimal import Decimal

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.domain.market import Bar
    from garuda.marketdata.minute_bars import IVBar

logger = logging.getLogger(__name__)

#: Which table each single-valued series lands in. The series name is the
#: engine's own -- the part of `SYNTH:STRADDLE-NIFTY` between the prefix and
#: the underlying.
_TABLES: dict[str, type[Any]] = {
    "STRADDLE": StraddleBars1MinRow,
    "PCR": PcrBars1MinRow,
    "SYNFUT": SyntheticBars1MinRow,
}

#: Series published as ticks but stored another way, so not looked for above.
#:
#: Implied volatility is the case. Its tick carries the two legs *averaged* --
#: one number, and the wrong one to keep -- while the table carries both legs
#: with their strikes, written from a reading through :meth:`write_iv`. The
#: skew is those same two legs subtracted and is not stored at all.
#:
#: Named rather than quietly ignored: a series that is in neither this set nor
#: the table above is a real mistake and still says so. Before this, every IV
#: minute logged an error for a bar that was already being stored correctly by
#: the other path.
_STORED_ELSEWHERE = frozenset({"IV", "IVSKEW"})


class DerivedBarStore:
    """Writes one-minute derived bars, and never gets in the engine's way."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def write(
        self, series: str, symbol: str, bar: Bar, *, not_before: datetime | None = None
    ) -> bool:
        """Store one bar of a single-valued series. True if it landed."""
        if series in _STORED_ELSEWHERE:
            return False
        table = _TABLES.get(series)
        if table is None:
            logger.error("no table for the %s series; %s bar dropped", series, symbol)
            return False
        if _too_early(bar.start, not_before, symbol, series):
            return False

        values: dict[str, Any] = {
            "symbol": symbol,
            "bar_start": bar.start,
            "open": bar.open.amount,
            "high": bar.high.amount,
            "low": bar.low.amount,
            "close": bar.close.amount,
        }
        return await self._upsert(table, values)

    async def write_iv(
        self, symbol: str, bar: IVBar, *, not_before: datetime | None = None
    ) -> bool:
        """Store one bar of the two-sided volatility series."""
        if _too_early(bar.start, not_before, symbol, "IV"):
            return False
        values: dict[str, Any] = {
            "symbol": symbol,
            "bar_start": bar.start,
            "call_open": bar.call_open,
            "call_high": bar.call_high,
            "call_low": bar.call_low,
            "call_close": bar.call_close,
            "put_open": bar.put_open,
            "put_high": bar.put_high,
            "put_low": bar.put_low,
            "put_close": bar.put_close,
            "call_strike": bar.call_strike,
            "put_strike": bar.put_strike,
            "spot_close": bar.spot_close.amount,
        }
        return await self._upsert(IvBars1MinRow, values)

    async def write_straddle_strike(
        self, symbol: str, bar_start: datetime, strike: Decimal
    ) -> bool:
        """Record which strike a straddle bar sat on, alongside the bar."""
        return await self._upsert(
            StraddleBars1MinRow, {"symbol": symbol, "bar_start": bar_start, "strike": strike}
        )

    async def _upsert(self, table: type[Any], values: dict[str, Any]) -> bool:
        statement = insert(table).values(**values)
        updates = {k: v for k, v in values.items() if k not in ("symbol", "bar_start")}
        statement = statement.on_conflict_do_update(
            index_elements=["symbol", "bar_start"], set_=updates
        )
        try:
            async with UnitOfWork(self._sessions) as uow:
                await uow.session.execute(statement)
            return True
        except Exception:
            # The chart loses a minute. Nothing else changes.
            logger.exception(
                "could not store the %s bar for %s at %s",
                table.__tablename__,
                values.get("symbol"),
                values.get("bar_start"),
            )
            return False


def _too_early(start: datetime, not_before: datetime | None, symbol: str, series: str) -> bool:
    if not_before is None or start >= not_before:
        return False
    logger.debug(
        "%s %s bar at %s is before the open at %s; not stored",
        symbol,
        series,
        start,
        not_before,
    )
    return True


def series_and_symbol(instrument: str) -> tuple[str, str] | None:
    """Split ``SYNTH:STRADDLE-NIFTY`` into its series and its underlying.

    None for anything that is not one of ours -- an ordinary instrument has no
    business in these tables, and quietly writing one would be worse than
    dropping it.
    """
    prefix, _, rest = instrument.partition(":")
    if prefix != "SYNTH" or not rest:
        return None
    series, _, symbol = rest.partition("-")
    if not series or not symbol:
        return None
    return series, symbol


async def store_bars(
    store: DerivedBarStore, bars: Sequence[Bar], *, not_before: datetime | None = None
) -> int:
    """Write every bar that belongs in one of these tables. Returns how many."""
    written = 0
    for bar in bars:
        split = series_and_symbol(bar.instrument.value)
        if split is None:
            continue
        series, symbol = split
        if await store.write(series, symbol, bar, not_before=not_before):
            written += 1
    return written
