"""The Zerodha broker adapter.

A translator and nothing more. It does not decide what to place, when to
retry, or whether an order is protected -- those are the order manager's, and
keeping them there is what stops six adapters drifting apart, which is what
happened to the engine this one is a rewrite of.

Two things it refuses to do, both ported from that engine:

**It never regresses a fill.** Broker frames arrive out of order, and a stale
one reporting less filled than the engine already saw would un-fill a real
position.

**It never overwrites a status with silence.** A response carrying no status
means no news; the order keeps the state it had.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from decimal import Decimal
from typing import Any

from garuda.brokers.zerodha.mapping import (
    VALIDITY_DAY,
    order_type_to_kite,
    product_from_kite,
    product_to_kite,
    side_from_kite,
    side_to_kite,
    status_from_kite,
    variety_for,
)
from garuda.brokers.zerodha.rest import KiteClient
from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus, ProductType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.broker import (
    BrokerEvent,
    BrokerOrder,
    BrokerPosition,
    Funds,
    LoginStyle,
    OrderChanges,
    OrderRejectedError,
)

logger = logging.getLogger(__name__)

#: Kite truncates a longer tag silently, and a truncated tag no longer matches
#: the order it belongs to, so the engine refuses rather than sends one.
MAX_TAG_LENGTH = 20


class ZerodhaBroker:
    """Kite Connect, behind the engine's broker contract."""

    def __init__(
        self,
        trading_client: TradingClientId,
        client: KiteClient,
        registry: Callable[[], InstrumentRegistry],
    ) -> None:
        self._trading_client = trading_client
        self._client = client
        self._registry = registry

    @property
    def trading_client(self) -> TradingClientId:
        return self._trading_client

    @property
    def login_style(self) -> LoginStyle:
        return LoginStyle.BROWSER_OAUTH

    # -- placing ------------------------------------------------------------

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        instrument = self._require(request.instrument)
        tag = str(request.client_order_id)
        if len(tag) > MAX_TAG_LENGTH:
            # Refused rather than truncated: the tag is how an order coming
            # back from the broker is matched to the one the engine sent, and
            # a silently shortened one matches nothing.
            raise OrderRejectedError(
                f"{tag!r} is {len(tag)} characters; Kite tags are at most {MAX_TAG_LENGTH}"
            )

        form: dict[str, Any] = {
            "tradingsymbol": instrument.trading_symbol,
            "exchange": self._segment_exchange(instrument),
            "transaction_type": side_to_kite(request.side),
            "order_type": order_type_to_kite(request.order_type),
            "quantity": request.quantity,
            "product": product_to_kite(request.product),
            "validity": VALIDITY_DAY,
            "tag": tag,
        }
        if request.price is not None:
            form["price"] = _plain(request.price)
        if request.trigger_price is not None:
            form["trigger_price"] = _plain(request.trigger_price)

        variety = variety_for(request.product)
        data = await self._client.post(f"/orders/{variety}", form)
        order_id = _text(data, "order_id")
        if not order_id:
            raise OrderRejectedError(f"{tag}: Kite accepted the order but returned no order id")
        return BrokerOrderId(order_id)

    async def modify(self, broker_order_id: BrokerOrderId, changes: OrderChanges) -> None:
        form: dict[str, Any] = {}
        if changes.quantity is not None:
            form["quantity"] = changes.quantity
        if changes.price is not None:
            form["price"] = _plain(changes.price)
        if changes.trigger_price is not None:
            form["trigger_price"] = _plain(changes.trigger_price)
        if not form:
            raise OrderRejectedError(f"{broker_order_id}: a modification that changes nothing")
        await self._client.put(f"/orders/regular/{broker_order_id}", form)

    async def cancel(self, broker_order_id: BrokerOrderId) -> None:
        await self._client.delete(f"/orders/regular/{broker_order_id}")

    # -- reading ------------------------------------------------------------

    async def fetch_orders(self) -> Sequence[BrokerOrder]:
        rows = await self._client.get("/orders")
        orders: list[BrokerOrder] = []
        for row in rows or []:
            order = self._to_order(row)
            if order is not None:
                orders.append(order)
        return orders

    async def fetch_positions(self) -> Sequence[BrokerPosition]:
        """The **net** book, not the day book.

        Kite reports both. Day counts only what was traded today, so a
        carry-forward position opened yesterday is absent from it entirely --
        and a square-off driven by the day book would leave that position open
        while reporting success.
        """
        data = await self._client.get("/portfolio/positions")
        rows = (data or {}).get("net", []) if isinstance(data, dict) else []
        positions: list[BrokerPosition] = []
        for row in rows:
            position = self._to_position(row)
            if position is not None:
                positions.append(position)
        return positions

    async def fetch_funds(self) -> Funds:
        data = await self._client.get("/user/margins")
        equity = (data or {}).get("equity") if isinstance(data, dict) else None
        if not isinstance(equity, dict):
            raise OrderRejectedError("Kite returned no equity margin segment")

        available = _money((equity.get("available") or {}).get("live_balance"))
        used = _money((equity.get("utilised") or {}).get("debits"))
        total = _money(equity.get("net"))
        return Funds(available=available, used=used, total=total)

    async def fetch_instruments(self) -> Sequence[Instrument]:
        """Served from today's registry rather than re-downloaded.

        The master is a several-megabyte CSV fetched once at day-init; an
        adapter pulling it again per call would spend the account's rate limit
        on something it already has.
        """
        return list(self._registry().by_id.values())

    async def events(self) -> AsyncIterator[BrokerEvent]:
        """Nothing here. Order updates arrive on the account stream.

        Kite pushes them over the same WebSocket the ticks come on, so this
        adapter has no event source of its own; polling fetch_orders is the
        backstop the reconciler uses.
        """
        empty: tuple[BrokerEvent, ...] = ()
        for event in empty:
            yield event

    # -- translation --------------------------------------------------------

    def _to_order(self, row: Mapping[str, Any]) -> BrokerOrder | None:
        instrument = self._by_symbol(row)
        if instrument is None:
            logger.warning(
                "kite order %s is for %s on %s, which is not in today's master",
                row.get("order_id"),
                row.get("tradingsymbol"),
                row.get("exchange"),
            )
            return None

        filled = _int(row.get("filled_quantity"))
        status = status_from_kite(row.get("status"), filled)
        tag = _text(row, "tag")
        return BrokerOrder(
            broker_order_id=BrokerOrderId(_text(row, "order_id")),
            client_order_id=ClientOrderId(tag) if tag else None,
            instrument=instrument.id,
            side=side_from_kite(row.get("transaction_type")),
            quantity=_int(row.get("quantity")),
            filled_quantity=filled,
            status=status or OrderStatus.UNKNOWN,
            product=product_from_kite(row.get("product")) or ProductType.NRML,
            average_price=_money(row.get("average_price")) if row.get("average_price") else None,
        )

    def _to_position(self, row: Mapping[str, Any]) -> BrokerPosition | None:
        instrument = self._by_symbol(row)
        if instrument is None:
            logger.warning(
                "kite position in %s on %s is not in today's master",
                row.get("tradingsymbol"),
                row.get("exchange"),
            )
            return None
        return BrokerPosition(
            instrument=instrument.id,
            quantity=_int(row.get("quantity")),
            average_price=_money(row.get("average_price")),
            product=product_from_kite(row.get("product")) or ProductType.NRML,
            multiplier=instrument.multiplier,
        )

    def _by_symbol(self, row: Mapping[str, Any]) -> Instrument | None:
        exchange = str(row.get("exchange") or "")
        symbol = str(row.get("tradingsymbol") or "")
        found = self._registry().by_trading_symbol(exchange, symbol)
        if found is not None:
            return found
        # Kite reports derivatives under their segment exchange (NFO, BFO,
        # MCX) while the engine keys them by the venue that lists them.
        for candidate in ("NSE", "BSE", "MCX"):
            found = self._registry().by_trading_symbol(candidate, symbol)
            if found is not None:
                return found
        return None

    def _segment_exchange(self, instrument: Instrument) -> str:
        """The exchange string Kite wants, which is the segment for derivatives."""
        return _KITE_EXCHANGES.get(
            (instrument.exchange.code, instrument.segment.value), instrument.exchange.code
        )

    def _require(self, instrument_id: InstrumentId) -> Instrument:
        return self._registry().require(instrument_id)


#: Kite routes derivatives through a separate exchange code from the venue
#: that lists them.
_KITE_EXCHANGES: dict[tuple[str, str], str] = {
    ("NSE", "FNO"): "NFO",
    ("BSE", "FNO"): "BFO",
    ("NSE", "CURRENCY"): "CDS",
    ("BSE", "CURRENCY"): "BCD",
    ("MCX", "COMMODITY"): "MCX",
    ("MCX", "FNO"): "MCX",
}


def _plain(price: Money) -> str:
    """A price as Kite wants it: a plain decimal, never scientific notation."""
    return format(price.amount.normalize(), "f")


def _money(value: Any) -> Money:
    return Money(Decimal(str(value if value is not None else 0)), Currency.INR)


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _text(row: Mapping[str, Any], key: str) -> str:
    value = row.get(key)
    return str(value) if value is not None else ""
