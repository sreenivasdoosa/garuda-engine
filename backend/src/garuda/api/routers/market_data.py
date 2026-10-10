"""What the Live Feed reads.

Two kinds of question, answered from two places:

* **What is it doing now** -- the last tick, straight out of the hub. The hub
  is in this process, which is the whole reason the engine and the API share
  one; a tick is never written anywhere a second process could read in time.
* **What did it do** -- bars. Ordinary instruments come from the broker's
  history through the candle source; the derived series come from the tables
  the engine folds them into, because no broker has a straddle's past.

**A price is sent as a string.** It leaves the engine as an exact decimal and
JSON has only floats, so serialising it as a number is where 123.45 quietly
becomes 123.44999999999999 -- at the last possible moment, in the one place
nobody looks.

**No engine means no prices, and the route says so.** `serve --reload` runs
the API alone. Answering an empty list there would be indistinguishable from a
quiet market.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.reference import (
    named_instrument,
    reference_for,
    underlying_instrument,
)
from garuda.persistence import models
from garuda.persistence.derived_bars import series_and_symbol
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: The Console's interval names, which are Kite's. Kept as the wire vocabulary
#: because the Console already speaks it and the chart library is built on it.
INTERVALS: dict[str, BarInterval] = {
    "minute": BarInterval.ONE_MINUTE,
    "3minute": BarInterval.THREE_MINUTES,
    "5minute": BarInterval.FIVE_MINUTES,
    "15minute": BarInterval.FIFTEEN_MINUTES,
    "30minute": BarInterval.THIRTY_MINUTES,
    "60minute": BarInterval.ONE_HOUR,
    "day": BarInterval.ONE_DAY,
}

#: The engine's own series code, as it appears in `SYNTH:<code>-<symbol>`,
#: to the table key below.
_SERIES_BY_CODE = {"STRADDLE": "straddle", "PCR": "pcr", "SYNFUT": "synthetic"}

#: Which table each derived series is charted from.
_SERIES = {
    "straddle": models.StraddleBars1MinRow,
    "pcr": models.PcrBars1MinRow,
    "synthetic": models.SyntheticBars1MinRow,
}

#: A history request with no explicit window looks back this far.
_DEFAULT_LOOKBACK = timedelta(days=5)


def _number(value: Decimal | None) -> str | None:
    return None if value is None else str(value)


def _price(value: Any) -> str | None:
    """A Money, as an exact string."""
    return None if value is None else str(value.amount)


def tick_wire(tick: Tick) -> dict[str, Any]:
    return {
        "instrument": tick.instrument.value,
        "tradingSymbol": tick.instrument.value.split(":", 1)[-1],
        "lastTradedPrice": _price(tick.last_price),
        "lastTradedTimestamp": tick.timestamp.isoformat(),
        "open": _price(tick.open),
        "high": _price(tick.high),
        "low": _price(tick.low),
        "close": _price(tick.previous_close),
        "volumeTradedToday": tick.volume,
        "averagePrice": _price(tick.average_price),
        "buyQty": tick.total_buy_quantity,
        "sellQty": tick.total_sell_quantity,
        "oi": tick.open_interest,
        "oiDayHigh": tick.open_interest_day_high,
        "oiDayLow": tick.open_interest_day_low,
        "isSynthetic": tick.is_synthetic,
    }


def bar_wire(bar: Bar) -> dict[str, Any]:
    return {
        "tradingSymbol": bar.instrument.value.split(":", 1)[-1],
        "timestamp": bar.start.isoformat(),
        "open": _price(bar.open),
        "high": _price(bar.high),
        "low": _price(bar.low),
        "close": _price(bar.close),
        "volume": bar.volume,
    }


def derived_wire(row: Any) -> dict[str, Any]:
    payload = {
        "tradingSymbol": row.symbol,
        "timestamp": row.bar_start.isoformat(),
        "open": _number(row.open),
        "high": _number(row.high),
        "low": _number(row.low),
        "close": _number(row.close),
    }
    strike = getattr(row, "strike", None)
    if strike is not None:
        payload["strike"] = _number(strike)
    return payload


def iv_wire(row: models.IvBars1MinRow) -> dict[str, Any]:
    return {
        "tradingSymbol": row.symbol,
        "timestamp": row.bar_start.isoformat(),
        "ceIVOpen": _number(row.call_open),
        "ceIVHigh": _number(row.call_high),
        "ceIVLow": _number(row.call_low),
        "ceIVClose": _number(row.call_close),
        "peIVOpen": _number(row.put_open),
        "peIVHigh": _number(row.put_high),
        "peIVLow": _number(row.put_low),
        "peIVClose": _number(row.put_close),
        "ceStrike": _number(row.call_strike),
        "peStrike": _number(row.put_strike),
        "spotClose": _number(row.spot_close),
    }


#: How many minutes each charted interval spans. The derived tables hold only
#: minutes, so anything coarser is folded from them here.
_MINUTES_PER: dict[BarInterval, int] = {
    BarInterval.ONE_MINUTE: 1,
    BarInterval.THREE_MINUTES: 3,
    BarInterval.FIVE_MINUTES: 5,
    BarInterval.FIFTEEN_MINUTES: 15,
    BarInterval.THIRTY_MINUTES: 30,
    BarInterval.ONE_HOUR: 60,
}


def _as_interval(
    minutes: list[tuple[datetime, Decimal, Decimal, Decimal, Decimal]],
    interval: BarInterval,
    symbol: str,
) -> list[dict[str, Any]]:
    """Stored minutes, folded to the interval asked for.

    The engine stores one minute per row -- that is the resolution a derived
    series is computed at -- so a five-minute chart is built here rather than
    stored five ways. Folded the same way any bar is: first open, highest
    high, lowest low, last close.

    A day is its own bucket rather than 1440 minutes, because a session is not
    a day long and bucketing by elapsed minutes would split it at midnight.
    """
    if not minutes:
        return []
    span = _MINUTES_PER.get(interval)

    buckets: dict[Any, list[tuple[datetime, Decimal, Decimal, Decimal, Decimal]]] = {}
    for row in minutes:
        at = row[0]
        if span is None:
            key: Any = at.date()
        else:
            key = at.replace(minute=(at.minute // span) * span, second=0, microsecond=0)
        buckets.setdefault(key, []).append(row)

    folded: list[dict[str, Any]] = []
    for _, rows in sorted(buckets.items(), key=lambda pair: pair[1][0][0]):
        folded.append(
            {
                "tradingSymbol": symbol.split(":", 1)[-1],
                "timestamp": rows[0][0].isoformat(),
                "open": _number(rows[0][1]),
                "high": _number(max(r[2] for r in rows)),
                "low": _number(min(r[3] for r in rows)),
                "close": _number(rows[-1][4]),
                "volume": None,
            }
        )
    return folded


def _interval(name: str) -> BarInterval:
    found = INTERVALS.get(name)
    if found is None:
        raise HTTPException(
            status_code=400,
            detail=f"{name!r} is not an interval; one of {', '.join(INTERVALS)}",
        )
    return found


def _window(start: str | None, end: str | None, now: datetime) -> tuple[datetime, datetime]:
    """The range asked for, or the last few days ending now.

    ``now`` is passed in rather than read: every instant in the engine comes
    through the Clock, which is what lets a recorded session replay to the
    same answers.

    The Console sends wall-clock without a zone -- `2026-08-26 00:00:00` --
    because that is what a person picking a date means. A naive instant is
    read as being in the engine's own zone rather than rejected or quietly
    treated as UTC; treating it as UTC would shift every intraday window by
    five and a half hours and return the wrong bars without failing.
    """
    try:
        to = _aware(datetime.fromisoformat(end), now) if end else now
        since = _aware(datetime.fromisoformat(start), now) if start else to - _DEFAULT_LOOKBACK
    except ValueError as error:
        raise HTTPException(status_code=400, detail=f"unreadable date: {error}") from None
    if since >= to:
        raise HTTPException(status_code=400, detail="`from` must be before `to`")
    return since, to


def _aware(moment: datetime, now: datetime) -> datetime:
    """The same instant, in the engine's zone when it was given without one."""
    return moment if moment.tzinfo is not None else moment.replace(tzinfo=now.tzinfo)


def build(
    sessions: async_sessionmaker[AsyncSession], clock: Clock, *, master_broker: str = "zerodha"
) -> APIRouter:
    """The market-data routes, over whichever engine the app is holding."""
    router = APIRouter(prefix="/api/market-data")

    async def session() -> Any:
        async with UnitOfWork(sessions) as uow:
            yield uow.session

    def live(request: Request) -> Any:
        """The running engine, or a refusal naming why there are no prices."""
        engine = request.app.state.engine
        if engine is None:
            raise HTTPException(
                status_code=503,
                detail="the API is running without an engine, so there are no live prices",
            )
        return engine

    # -- what is happening now ---------------------------------------------

    @router.get("/health")
    async def health(request: Request) -> dict[str, Any]:
        """Whether anything has prices, and how fresh they are."""
        engine = request.app.state.engine
        if engine is None:
            return ok({"status": "no-engine", "connected": False, "subscriptions": 0})
        hub = engine.parts.hub
        # `quoting` against `subscriptions` is the number that matters when a
        # series will not price: a chain can be fully subscribed, every token
        # resolved, and still carry nothing, and only the gap between these two
        # says so.
        quoting = sum(1 for held in hub.subscriptions if hub.latest(held) is not None)
        return ok(
            {
                "status": "ok" if hub.health.is_connected else "disconnected",
                "connected": hub.health.is_connected,
                "subscriptions": len(hub.subscriptions),
                "quoting": quoting,
                "silent": [
                    held.value
                    for held in sorted(hub.subscriptions, key=lambda i: i.value)
                    if hub.latest(held) is None
                ][:50],
                "ticksPublished": hub.health.ticks_published,
                "unresolvedTokens": hub.health.unresolved_tokens,
            }
        )

    @router.get("/indices")
    async def indices(request: Request, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every curated index, and the instrument its level arrives under.

        `referenceSymbol` is what the feed publishes -- "NIFTY 50" -- and
        `symbol` is what everything else calls it. They differ, and a page
        that conflates them subscribes to a symbol that never ticks.
        """
        # The operator's order, with anything unordered after it rather than
        # before: a curated handful should not be pushed down the page by
        # symbols nobody arranged. The symbol breaks ties, so two cards never
        # swap places between loads.
        found = await db.execute(
            select(models.SymbolsRow)
            .where(models.SymbolsRow.is_index.is_(True))
            .order_by(
                models.SymbolsRow.display_order.nulls_last(),
                models.SymbolsRow.symbol,
            )
        )
        # Resolved through the same rule the watchlist subscribes by, so the
        # instrument a card watches for is the instrument that actually ticks.
        # Without the master there is nothing to resolve against, and the
        # symbol's own spelling is the honest best guess.
        engine = request.app.state.engine
        registry = (
            engine.parts.instruments.for_broker(master_broker) if engine is not None else None
        )
        today = clock.now().date()

        listed = []
        for row in found.scalars():
            spot = row.index_symbol or row.symbol
            exchange = row.exchange or "NSE"
            info = SymbolInfo(
                symbol=row.symbol,
                exchange_code=exchange,
                is_index=True,
                index_symbol=row.index_symbol,
            )
            carrier = reference_for(info, registry, today) if registry is not None else None
            named = named_instrument(info)
            keyed_by = underlying_instrument(info)
            resolved = carrier or named

            # The spot and the near-month future, separately from whichever of
            # them is carrying the price. A synthetic-future chart overlays the
            # series on both, and "which is the price" does not answer "what
            # else can I compare it against".
            has_spot = (
                registry is not None and named is not None and registry.get(named) is not None
            )
            future = (
                registry.near_month_future(keyed_by, today)
                if registry is not None and keyed_by is not None
                else None
            )
            listed.append(
                {
                    "exchange": exchange,
                    "symbol": row.symbol,
                    "referenceSymbol": spot,
                    "fullSymbol": resolved.value if resolved else f"{exchange}:{spot}",
                    "straddleSymbol": f"S-{row.symbol}",
                    "fullStraddleSymbol": f"SYNTH:STRADDLE-{row.symbol}",
                    # True when the price comes from a future rather than a
                    # published level, which is every commodity underlying.
                    "isFutures": carrier is not None and carrier != named,
                    # Null where there is none: MCX publishes no cash index, so
                    # a "compare with spot" toggle there would be a control
                    # that can only ever draw nothing.
                    "hasSpot": has_spot,
                    "fullSpotSymbol": named.value if has_spot and named else None,
                    "fullFuturesSymbol": future.id.value if future is not None else None,
                }
            )
        return ok({"status": "ok", "indices": listed})

    @router.get("/quotes")
    async def quotes(request: Request, symbols: str = Query(default="")) -> dict[str, Any]:
        """The last tick for each instrument asked for.

        An instrument with no price is **absent**, never a zero: a zero is a
        number a chart will happily draw.
        """
        hub = live(request).parts.hub
        wanted = [name.strip() for name in symbols.split(",") if name.strip()]
        answered = []
        for name in wanted:
            tick = hub.latest(InstrumentId(name))
            if tick is not None:
                answered.append(tick_wire(tick))
        return ok(answered)

    @router.get("/sticks")
    async def straddle_ticks(request: Request, symbols: str = Query(default="")) -> dict[str, Any]:
        return ok(_synthetic_ticks(live(request), "STRADDLE", symbols))

    @router.get("/ivticks")
    async def iv_ticks(request: Request, symbols: str = Query(default="")) -> dict[str, Any]:
        return ok(_synthetic_ticks(live(request), "IV", symbols))

    @router.get("/pcrticks")
    async def pcr_ticks(request: Request, symbols: str = Query(default="")) -> dict[str, Any]:
        return ok(_synthetic_ticks(live(request), "PCR", symbols))

    # -- what it did -------------------------------------------------------

    @router.get("/history")
    async def history(
        request: Request,
        symbol: str,
        interval: str = "minute",
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        """Candles for one ordinary instrument, from the broker.

        `from` is a Python keyword, hence the alias. Sweeping the window up
        with `**kwargs` instead -- which is what this did -- makes FastAPI
        read a required query parameter named `_`, and every request fails
        with "Field required" before the handler runs.

        A derived series is served from here too, by its own instrument id --
        `SYNTH:STRADDLE-NIFTY`. One route rather than two because the Console's
        chart is one component: giving the straddle a separate endpoint means a
        separate chart, and then the interval buttons, the line toggle and the
        zoom exist on one of them and not the other.

        No broker has a straddle's past, so those come from the engine's own
        tables instead of the history provider.
        """
        since, to = _window(start, end, clock.now())
        wanted = _interval(interval)

        derived = series_and_symbol(symbol)
        if derived is not None:
            series, underlying = derived
            async with UnitOfWork(sessions) as uow:
                minutes = await _derived_minutes(uow.session, series, underlying, since, to)
            return ok(_as_interval(minutes, wanted, symbol))

        engine = live(request)
        candles = engine.parts.candles
        if candles is None:
            raise HTTPException(
                status_code=503, detail="no history provider is configured or logged in"
            )
        bars = await candles.source.fetch(InstrumentId(symbol), wanted, since, to)
        return ok([bar_wire(bar) for bar in bars])

    @router.get("/history/straddle")
    async def straddle_history(
        symbol: str,
        db: AsyncSession = Depends(session),
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        return ok(await _derived_history(db, "straddle", symbol, start, end))

    @router.get("/history/pcr")
    async def pcr_history(
        symbol: str,
        db: AsyncSession = Depends(session),
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        return ok(await _derived_history(db, "pcr", symbol, start, end))

    @router.get("/history/synthetic")
    async def synthetic_history(
        symbol: str,
        db: AsyncSession = Depends(session),
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        return ok(await _derived_history(db, "synthetic", symbol, start, end))

    @router.get("/history/iv")
    async def iv_history(
        symbol: str,
        db: AsyncSession = Depends(session),
        start: str | None = Query(default=None, alias="from"),
        end: str | None = Query(default=None, alias="to"),
    ) -> dict[str, Any]:
        """Both volatility legs, as the reference records them."""
        since, to = _window(start, end, clock.now())
        found = await db.execute(
            select(models.IvBars1MinRow)
            .where(
                models.IvBars1MinRow.symbol == symbol,
                models.IvBars1MinRow.bar_start >= since,
                models.IvBars1MinRow.bar_start <= to,
            )
            .order_by(models.IvBars1MinRow.bar_start)
        )
        return ok([iv_wire(row) for row in found.scalars()])

    async def _derived_minutes(
        db: AsyncSession, series: str, symbol: str, since: datetime, to: datetime
    ) -> list[tuple[datetime, Decimal, Decimal, Decimal, Decimal]]:
        """One derived series' stored minutes, oldest first.

        The volatility series is not here: its row holds two of everything and
        cannot be read as one OHLC. Its chart uses its own route.
        """
        table = _SERIES.get(series.lower()) or _SERIES.get(_SERIES_BY_CODE.get(series, ""))
        if table is None:
            return []
        found = await db.execute(
            select(table)
            .where(table.symbol == symbol, table.bar_start >= since, table.bar_start <= to)
            .order_by(table.bar_start)
        )
        minutes: list[tuple[datetime, Decimal, Decimal, Decimal, Decimal]] = []
        for row in found.scalars():
            # A row with a gap in it cannot be folded into a coarser bar, and a
            # bar with a missing leg is not a bar. Dropped rather than
            # defaulted to zero, which a chart would draw.
            opened, high, low, close = row.open, row.high, row.low, row.close
            if opened is None or high is None or low is None or close is None:
                continue
            minutes.append((row.bar_start, opened, high, low, close))
        return minutes

    async def _derived_history(
        db: AsyncSession, series: str, symbol: str, start: str | None, end: str | None
    ) -> list[dict[str, Any]]:
        table = _SERIES[series]
        since, to = _window(start, end, clock.now())
        found = await db.execute(
            select(table)
            .where(table.symbol == symbol, table.bar_start >= since, table.bar_start <= to)
            .order_by(table.bar_start)
        )
        return [derived_wire(row) for row in found.scalars()]

    return router


def _synthetic_ticks(engine: Any, series: str, symbols: str) -> list[dict[str, Any]]:
    """The latest value of one derived series, per underlying asked for."""
    hub = engine.parts.hub
    wanted = [name.strip() for name in symbols.split(",") if name.strip()]
    answered = []
    for name in wanted:
        tick = hub.latest(InstrumentId(f"SYNTH:{series}-{name}"))
        if tick is not None:
            answered.append({"symbol": name, **tick_wire(tick)})
    return answered
