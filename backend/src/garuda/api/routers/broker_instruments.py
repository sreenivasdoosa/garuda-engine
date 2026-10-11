"""Broker Instruments: each broker's master, and what is in it.

Ported from the reference's broker instruments servlet: the statistics
per broker, a search by trading symbol, a lookup of one contract by its
parts with the nearest expiry when none is named, the expiries listed for
a symbol, and a forced download.

Everything reads the engine's own registry -- the index the strategies
resolve against -- so what the page finds is what the engine would find.
No table: the master is a file the engine fetches and holds in memory.

Only brokers with a master registered are listed, as the reference lists
only the brokers it built instruments for. Today that is one; the Console
merges the list with the enabled brokers and says so for the rest.

Exchanges are the market's segment codes -- NSE, NFO, BSE, BFO, CDS, MCX --
not the reference's venue alone: an NSE option is found under NFO, which is
where every broker lists it.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Iterable
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from garuda.api.envelope import ok
from garuda.api.routers.ticker import download_wire
from garuda.domain.enums import InstrumentKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, canonical_symbol
from garuda.marketdata.downloads import DownloadStatus, InstrumentDownloads
from garuda.marketdata.loader import InstrumentRegistryHolder
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.tasks import master_name
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: The reference's search rules.
MIN_SEARCH_LENGTH = 2
MAX_SEARCH_LIMIT = 100

#: What the page calls a kind. The reference's vocabulary: CE, PE, FUT, EQ.
TYPE_WORDS = {"CE": "CE", "PE": "PE", "FUT": "FUT", "EQ": "EQ", "INDEX": "INDEX"}


def instrument_type(instrument: Instrument) -> str:
    if instrument.kind is InstrumentKind.OPTION:
        return "CE" if instrument.option_type is OptionType.CALL else "PE"
    if instrument.kind is InstrumentKind.FUTURE:
        return "FUT"
    if instrument.kind is InstrumentKind.INDEX:
        return "INDEX"
    return "EQ"


def instrument_name(instrument: Instrument) -> str:
    """The symbol the page searches by: the underlying for a derivative."""
    source = instrument.underlying if instrument.underlying is not None else instrument.id
    return source.value.split(":", 1)[-1]


def instrument_wire(instrument: Instrument, registry: InstrumentRegistry) -> dict[str, Any]:
    token = registry.token_for(instrument.id)
    return {
        "instrumentToken": token,
        "instrumentId": instrument.id.value,
        "tradingSymbol": instrument.trading_symbol,
        # The market's code for the segment -- NFO, BFO -- not the venue
        # alone: that is how every broker names the contract.
        "exchange": instrument.segment_exchange,
        "venue": instrument.exchange.code,
        "segment": instrument.segment.value,
        "name": instrument_name(instrument),
        "instrumentType": instrument_type(instrument),
        "strike": None if instrument.strike is None else str(instrument.strike),
        "expiry": None if instrument.expiry is None else instrument.expiry.isoformat(),
        "lotSize": instrument.lot_size,
    }


def stats_wire(
    broker: str, status: DownloadStatus | None, holder: InstrumentRegistryHolder
) -> dict[str, Any]:
    loaded = holder.is_loaded(broker)
    count = len(holder.for_broker(broker)) if loaded else 0
    return {
        "brokerName": broker,
        "supported": status is not None,
        "cacheLoaded": loaded,
        "instrumentsCount": count,
        "fileBytes": status.file_bytes if status else None,
        "lastDownloadedTime": status.cached_at.isoformat() if status and status.cached_at else None,
        "download": download_wire(status) if status else None,
    }


def _matches(
    registry: InstrumentRegistry,
    *,
    exchange: str,
    symbol: str,
    kind: str | None,
    expiry: dt.date | None = None,
    strike: Decimal | None = None,
) -> list[Instrument]:
    """The reference's filters, over the whole master.

    ``exchange`` is the segment's code -- NSE for shares and indices, NFO
    for NSE's derivatives, BFO for BSE's -- as the brokers name it and as
    the owner asked for, rather than the venue alone.
    """
    wanted_exchange = exchange.upper()
    # As the master spells it: an index the broker calls "NIFTY 50" is
    # NIFTY_50 here, and a lookup typed the broker's way must still find it.
    try:
        wanted_symbol = canonical_symbol(symbol).upper()
    except DomainError:
        wanted_symbol = symbol.strip().upper()
    wanted_kind = kind.upper() if kind else None
    found: list[Instrument] = []
    for instrument in registry.by_id.values():
        if instrument.segment_exchange != wanted_exchange:
            continue
        if instrument_name(instrument).upper() != wanted_symbol:
            continue
        if wanted_kind and instrument_type(instrument) != wanted_kind:
            continue
        if expiry is not None and instrument.expiry != expiry:
            continue
        if strike is not None and instrument.strike != strike:
            continue
        found.append(instrument)
    return found


def _nearest(matches: Iterable[Instrument], today: dt.date) -> Instrument:
    """The reference's choice when no expiry was named: the soonest on or
    after today, else whatever matched first."""
    dated = [i for i in matches if i.expiry is not None and i.expiry >= today]
    if dated:
        return min(dated, key=lambda i: i.expiry or dt.date.max)
    return next(iter(matches))


def build(clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/broker-instruments", tags=["broker-instruments"])

    def _engine(request: Request) -> Any:
        engine = request.app.state.engine
        if engine is None:
            raise HTTPException(
                status_code=503,
                detail="the API is running without an engine, so no instrument master is loaded",
            )
        return engine

    def _holder(request: Request) -> InstrumentRegistryHolder:
        holder: InstrumentRegistryHolder = _engine(request).parts.instruments
        return holder

    def _downloads(request: Request) -> InstrumentDownloads | None:
        downloads: InstrumentDownloads | None = _engine(request).parts.downloads
        return downloads

    def _status(request: Request, broker: str) -> DownloadStatus | None:
        downloads = _downloads(request)
        name = master_name(broker)
        if downloads is None or name not in downloads.names:
            return None
        return downloads.status_of(name)

    def _brokers(request: Request) -> list[str]:
        downloads = _downloads(request)
        if downloads is None:
            return []
        return sorted(
            name.split(":", 1)[1] for name in downloads.names if name.startswith("master:")
        )

    def _registry(request: Request, broker: str) -> InstrumentRegistry:
        holder = _holder(request)
        if _status(request, broker) is None:
            raise HTTPException(
                status_code=404,
                detail=f"no instrument master is built for {broker!r}; "
                f"one of {', '.join(_brokers(request)) or 'none'}",
            )
        if not holder.is_loaded(broker):
            raise HTTPException(
                status_code=409,
                detail=f"{broker}'s instrument master is not loaded yet; download it first",
            )
        return holder.for_broker(broker)

    def _today(request: Request) -> dt.date:
        exchanges = _engine(request).parts.exchanges
        now = clock.now()
        if exchanges:
            return now.astimezone(exchanges[0].timezone).date()
        return now.date()

    @router.get("")
    async def all_stats(request: Request) -> dict[str, Any]:
        holder = _holder(request)
        return ok(
            [stats_wire(broker, _status(request, broker), holder) for broker in _brokers(request)]
        )

    @router.get("/{broker}")
    async def broker_stats(broker: str, request: Request) -> dict[str, Any]:
        status = _status(request, broker.lower())
        if status is None:
            raise HTTPException(
                status_code=404, detail=f"no instrument master is built for {broker!r}"
            )
        return ok(stats_wire(broker.lower(), status, _holder(request)))

    @router.get("/{broker}/search")
    async def search(
        broker: str,
        request: Request,
        q: str = Query(default=""),
        limit: int = Query(default=MAX_SEARCH_LIMIT, ge=1),
    ) -> dict[str, Any]:
        """Trading symbols containing the text, the first ``limit`` of them."""
        query = q.strip().upper()
        if len(query) < MIN_SEARCH_LENGTH:
            raise HTTPException(
                status_code=400,
                detail=f"the search needs at least {MIN_SEARCH_LENGTH} characters",
            )
        registry = _registry(request, broker.lower())
        cap = min(limit, MAX_SEARCH_LIMIT)
        found: list[dict[str, Any]] = []
        for instrument in registry.by_id.values():
            if query in instrument.trading_symbol.upper():
                found.append(instrument_wire(instrument, registry))
                if len(found) >= cap:
                    break
        return ok(found, count=len(found))

    @router.get("/{broker}/lookup")
    async def lookup(
        broker: str,
        request: Request,
        exchange: str = Query(default=""),
        symbol: str = Query(default=""),
        instrumentType: str | None = None,  # noqa: N803
        expiry: str | None = None,
        strike: str | None = None,
    ) -> dict[str, Any]:
        """Does this contract exist? The nearest expiry when none is named."""
        if not exchange.strip() or not symbol.strip():
            raise HTTPException(status_code=400, detail="exchange and symbol are required")
        registry = _registry(request, broker.lower())
        wanted_expiry: dt.date | None = None
        if expiry:
            try:
                wanted_expiry = dt.date.fromisoformat(expiry)
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"expiry {expiry!r} is not a date (YYYY-MM-DD)"
                ) from None
        wanted_strike: Decimal | None = None
        if strike:
            try:
                wanted_strike = Decimal(strike)
            except InvalidOperation:
                raise HTTPException(
                    status_code=400, detail=f"strike {strike!r} is not a number"
                ) from None
        matches = _matches(
            registry,
            exchange=exchange,
            symbol=symbol,
            kind=instrumentType,
            expiry=wanted_expiry,
            strike=wanted_strike,
        )
        if not matches:
            return ok({"found": False, "instrument": None})
        chosen = (
            matches[0]
            if wanted_expiry is not None or len(matches) == 1
            else _nearest(matches, _today(request))
        )
        return ok({"found": True, "instrument": instrument_wire(chosen, registry)})

    @router.get("/{broker}/expiries")
    async def expiries(
        broker: str,
        request: Request,
        exchange: str = Query(default=""),
        symbol: str = Query(default=""),
        instrumentType: str | None = None,  # noqa: N803
    ) -> dict[str, Any]:
        """Every expiry listed for a symbol, soonest first."""
        if not exchange.strip() or not symbol.strip():
            raise HTTPException(status_code=400, detail="exchange and symbol are required")
        registry = _registry(request, broker.lower())
        matches = _matches(registry, exchange=exchange, symbol=symbol, kind=instrumentType)
        listed = sorted({i.expiry for i in matches if i.expiry is not None})
        return ok(
            {
                "exchange": exchange.upper(),
                "symbol": symbol.upper(),
                "instrumentType": instrumentType.upper() if instrumentType else None,
                "expiries": [day.isoformat() for day in listed],
            }
        )

    @router.post("/{broker}/download")
    async def download(broker: str, request: Request) -> dict[str, Any]:
        """Fetch the master now, whatever the cache says."""
        name = broker.lower()
        downloads = _downloads(request)
        if downloads is None or master_name(name) not in downloads.names:
            raise HTTPException(
                status_code=404,
                detail=f"no instrument master is built for {broker!r}; "
                f"one of {', '.join(_brokers(request)) or 'none'}",
            )
        status = await downloads.refresh(master_name(name), force=True)
        if status.last_error is not None:
            raise HTTPException(status_code=502, detail=f"{name}: {status.last_error}")
        logger.info("%s instrument master downloaded from the Console: %d", name, status.count)
        return ok(
            stats_wire(name, status, _holder(request)),
            message=f"{status.count} instruments downloaded for {name}",
        )

    return router
