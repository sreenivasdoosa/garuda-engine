"""Dhan's REST market data: quotes, the day's OHLC, and candles.

Ported from the reference market-data service's `LiveQuotes.getQuotesFromDhan`
and `DhanHistory`. What is provider-specific and could not be guessed:

* Quotes are **posted**, not fetched, as `{segment: [securityId, ...]}`, and
  come back nested the same way -- a segment map of a security-id map. Both
  headers are required and are `access-token` and `client-id`, not a bearer.
* Candles come from two different endpoints. Daily is `/charts/historical`
  with plain dates; anything intraday is `/charts/intraday` with datetimes,
  and Dhan accepts **only 1, 5, 15, 25 and 60 minutes**, so anything else is
  mapped to the nearest of those rather than silently returning nothing.
* The response is **columnar** -- parallel arrays of timestamp, open, high,
  low, close -- not a list of candles.
* The request carries an `instrument` kind (OPTIDX, FUTSTK, INDEX...) derived
  from the contract, and commodity and currency are decided *before*
  index-ness so a commodity underlying is never mis-tagged as an index.

Two separate rate gates, because Dhan meters quotes and history separately: a
history sweep must not spend the budget a quote needs to size an order.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import httpx

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.marketdata.providers.dhan_master import INDEX_SEGMENT
from garuda.marketdata.throttle import RateGate
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

DHAN_API = "https://api.dhan.co"
MARKET_DATA_PATH = "/v2"

#: Dhan writes and reads its dates in India's zone regardless of the caller's.
DHAN_ZONE = ZoneInfo("Asia/Kolkata")

#: The only intraday intervals Dhan will answer. Anything else is mapped to
#: the nearest rather than returning an empty series that reads as "no data".
SUPPORTED_INTRADAY_MINUTES = (1, 5, 15, 25, 60)

_INTERVAL_MINUTES: dict[BarInterval, int] = {
    BarInterval.ONE_MINUTE: 1,
    BarInterval.THREE_MINUTES: 3,
    BarInterval.FIVE_MINUTES: 5,
    BarInterval.FIFTEEN_MINUTES: 15,
    BarInterval.THIRTY_MINUTES: 30,
    BarInterval.ONE_HOUR: 60,
}


class DhanDataError(DomainError):
    """Dhan refused or answered something unusable."""


def nearest_supported(minutes: int) -> int:
    """The supported interval closest to the one asked for.

    A tie goes to the shorter interval, deliberately: three minutes is equally
    far from one and from five, and one-minute candles can be aggregated into
    three where five-minute candles cannot be split into them. The reference
    iterates an unordered set here, so its tie-break is whatever hash order
    gives it.
    """
    return min(SUPPORTED_INTRADAY_MINUTES, key=lambda candidate: abs(candidate - minutes))


def instrument_kind(*, segment: str, option_type: str, is_future: bool, is_index: bool) -> str:
    """The `instrument` field Dhan wants on a history request.

    Commodity and currency are decided before index-ness, so a commodity
    underlying is never mis-tagged as an index.
    """
    segment = segment.upper()
    is_mcx = segment.startswith("MCX")
    is_currency = "CURRENCY" in segment
    index = segment == INDEX_SEGMENT or is_index

    if option_type in ("CE", "PE"):
        if is_currency:
            return "OPTCUR"
        if is_mcx:
            return "OPTFUT"
        return "OPTIDX" if index else "OPTSTK"
    if is_future:
        if is_currency:
            return "FUTCUR"
        if is_mcx:
            return "FUTCOM"
        return "FUTIDX" if index else "FUTSTK"
    return "INDEX" if index else "EQUITY"


def _money(value: Any, like: Money) -> Money | None:
    try:
        number = Decimal(str(value))
    except Exception:
        return None
    if number <= 0:
        return None
    return Money(number, like.currency)


def _int(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


class DhanRest:
    """One authenticated conversation with Dhan's market-data API."""

    def __init__(
        self,
        access_token: str,
        client_id: str,
        client: httpx.AsyncClient,
        clock: Clock,
        *,
        quote_gate: RateGate,
        history_gate: RateGate,
        base_url: str = DHAN_API,
        market_data_path: str = MARKET_DATA_PATH,
    ) -> None:
        self._token = access_token
        self._client_id = client_id
        self._http = client
        self._clock = clock
        self._quote_gate = quote_gate
        self._history_gate = history_gate
        self._base = f"{base_url.rstrip('/')}{market_data_path}"

    @property
    def headers(self) -> dict[str, str]:
        # Two headers, and neither is a bearer. A request missing `client-id`
        # is refused in a way that reads like a bad token.
        return {"access-token": self._token, "client-id": self._client_id}

    async def quote(
        self, by_segment: Mapping[str, Sequence[str]]
    ) -> Mapping[str, Mapping[str, Any]]:
        """Raw quotes, keyed segment then security id, as Dhan nests them."""
        body = {segment: [int(sid) for sid in ids] for segment, ids in by_segment.items() if ids}
        if not body:
            return {}

        await self._quote_gate.acquire()
        payload = await self._post("/marketfeed/quote", body)
        data = payload.get("data")
        if not isinstance(data, dict):
            return {}
        return {segment: rows for segment, rows in data.items() if isinstance(rows, dict)}

    async def candles(
        self,
        *,
        security_id: str,
        segment: str,
        kind: str,
        interval: BarInterval,
        start: datetime,
        end: datetime,
    ) -> list[dict[str, Any]]:
        """Candles, already turned from Dhan's columnar arrays into rows."""
        body: dict[str, Any] = {
            "securityId": security_id,
            "exchangeSegment": segment,
            "instrument": kind,
            "oi": False,
        }
        local_start = start.astimezone(DHAN_ZONE)
        local_end = end.astimezone(DHAN_ZONE)

        if interval is BarInterval.ONE_DAY:
            path = "/charts/historical"
            body["fromDate"] = local_start.strftime("%Y-%m-%d")
            body["toDate"] = local_end.strftime("%Y-%m-%d")
        else:
            path = "/charts/intraday"
            minutes = _INTERVAL_MINUTES.get(interval, 1)
            if minutes not in SUPPORTED_INTRADAY_MINUTES:
                mapped = nearest_supported(minutes)
                logger.warning(
                    "Dhan answers only %s minute candles; asking for %d instead of %d",
                    ", ".join(str(m) for m in SUPPORTED_INTRADAY_MINUTES),
                    mapped,
                    minutes,
                )
                minutes = mapped
            if (local_end - local_start).days > 90:
                logger.warning(
                    "Dhan's intraday history is limited to 90 days; %s to %s may be refused",
                    local_start.date(),
                    local_end.date(),
                )
            body["interval"] = str(minutes)
            body["fromDate"] = local_start.strftime("%Y-%m-%d %H:%M:%S")
            body["toDate"] = local_end.strftime("%Y-%m-%d %H:%M:%S")

        await self._history_gate.acquire()
        return rows_from_columns(await self._post(path, body))

    async def _post(self, path: str, body: dict[str, Any]) -> dict[str, Any]:
        url = f"{self._base}{path}"
        try:
            response = await self._http.post(url, json=body, headers=self.headers)
        except httpx.HTTPError as error:
            raise DhanDataError(f"Dhan: could not reach {path} ({error})") from None
        if response.status_code != 200:
            raise DhanDataError(
                f"Dhan: {path} answered {response.status_code} -- {response.text[:200]}"
            )
        try:
            payload = response.json()
        except ValueError:
            raise DhanDataError(f"Dhan: {path} answered something that is not JSON") from None
        if not isinstance(payload, dict):
            raise DhanDataError(f"Dhan: {path} answered an unexpected shape")
        return payload


def rows_from_columns(payload: Mapping[str, Any]) -> list[dict[str, Any]]:
    """Dhan answers candles as parallel arrays, not as a list of candles.

    Only as many rows as the shortest column: a response with five timestamps
    and four closes is truncated, and pairing them by index past that point
    would attach one candle's close to another's time.
    """
    columns = ("timestamp", "open", "high", "low", "close")
    arrays: dict[str, list[Any]] = {}
    for name in columns:
        value = payload.get(name)
        if not isinstance(value, list):
            return []
        arrays[name] = value

    volumes = payload.get("volume")
    length = min(len(value) for value in arrays.values())

    rows: list[dict[str, Any]] = []
    for index in range(length):
        row: dict[str, Any] = {name: arrays[name][index] for name in columns}
        if isinstance(volumes, list) and index < len(volumes):
            row["volume"] = volumes[index]
        rows.append(row)
    return rows


def tick_from_quote(
    instrument: InstrumentId, quote: Mapping[str, Any], now: datetime, like: Money
) -> Tick:
    """One of Dhan's quote objects, as a tick.

    The day's OHLC is nested under `ohlc`, which is easy to miss: read at the
    top level those four fields are simply absent and the tick loses its day
    range without anything looking wrong.
    """
    last = _money(quote.get("last_price"), like)
    if last is None:
        raise DhanDataError(f"{instrument}: Dhan quoted no last price")

    raw_ohlc = quote.get("ohlc")
    ohlc: Mapping[str, Any] = raw_ohlc if isinstance(raw_ohlc, dict) else {}

    timestamp = now
    raw_time = quote.get("last_trade_time")
    if isinstance(raw_time, str) and raw_time:
        try:
            timestamp = datetime.strptime(raw_time, "%Y-%m-%d %H:%M:%S").replace(tzinfo=DHAN_ZONE)
        except ValueError:
            timestamp = now

    return Tick(
        instrument=instrument,
        last_price=last,
        timestamp=timestamp,
        last_quantity=_int(quote.get("last_quantity")),
        average_price=_money(quote.get("average_price"), like),
        volume=_int(quote.get("volume")),
        total_buy_quantity=_int(quote.get("buy_quantity")),
        total_sell_quantity=_int(quote.get("sell_quantity")),
        open=_money(ohlc.get("open"), like),
        high=_money(ohlc.get("high"), like),
        low=_money(ohlc.get("low"), like),
        previous_close=_money(ohlc.get("close"), like),
        open_interest=_int(quote.get("oi")),
        open_interest_day_high=_int(quote.get("oi_day_high")),
        open_interest_day_low=_int(quote.get("oi_day_low")),
    )


def bar_from_row(
    instrument: InstrumentId, interval: BarInterval, row: Mapping[str, Any], like: Money
) -> Bar | None:
    """One candle.

    None when a field is missing or the bar is not coherent -- dropped rather
    than raised, because one bad candle at a session edge must not cost the
    month around it.
    """
    try:
        opened = Money(Decimal(str(row["open"])), like.currency)
        high = Money(Decimal(str(row["high"])), like.currency)
        low = Money(Decimal(str(row["low"])), like.currency)
        close = Money(Decimal(str(row["close"])), like.currency)
        start = datetime.fromtimestamp(int(row["timestamp"]), DHAN_ZONE)
    except Exception:
        return None
    try:
        return Bar(
            instrument=instrument,
            interval=interval,
            start=start,
            open=opened,
            high=high,
            low=low,
            close=close,
            volume=_int(row.get("volume")),
        )
    except DomainError:
        return None
