"""Applying market protection to an order on its way out.

The arithmetic is in :mod:`garuda.domain.protection`. This is the part that
needs the world: the per-broker, per-exchange configuration that decides
whether raw market orders are allowed at all, and a live price to protect
against.

It sits in the order path rather than in each adapter. The reference engine
put it in every broker's ``placeOrder`` and had to keep six copies honest;
here every order goes through one manager, so it happens once and an adapter
stays a translator.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, replace

from garuda.domain.enums import OrderType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.money import Money
from garuda.domain.order import OrderRequest
from garuda.domain.protection import (
    DEFAULT_BUFFERS,
    ProtectionSegment,
    SegmentBuffers,
    clamp_sl_limit,
    marketable_limit_price,
    sl_limit_from_trigger,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ExchangeProtection:
    """One broker_exchange_config row, as protection sees it."""

    market_orders_allowed: bool = False
    buffers: dict[ProtectionSegment, SegmentBuffers] | None = None

    def for_segment(self, segment: ProtectionSegment) -> SegmentBuffers:
        configured = (self.buffers or {}).get(segment)
        return configured or DEFAULT_BUFFERS[segment]


#: Looks up the row for a broker and an exchange. **A missing row means market
#: orders are not allowed**, which is the reference engine's posture and the
#: safe one: an unconfigured venue protects rather than sends raw.
type ProtectionLookup = Callable[[str, str], ExchangeProtection | None]

#: The last traded price, or None when nothing has ticked.
type LastPriceLookup = Callable[[InstrumentId], Money | None]

type InstrumentLookup = Callable[[InstrumentId], Instrument | None]


@dataclass(frozen=True, slots=True)
class Protected:
    """An order request after protection, and what protection did to it."""

    request: OrderRequest
    #: None when nothing changed. A sentence, for the log and the journal.
    change: str | None = None

    @property
    def was_changed(self) -> bool:
        return self.change is not None


class MarketProtection:
    """Turns orders a broker will refuse into ones it will accept."""

    def __init__(
        self,
        broker: str,
        config: ProtectionLookup,
        last_price: LastPriceLookup,
        instruments: InstrumentLookup,
    ) -> None:
        self._broker = broker
        self._config = config
        self._last_price = last_price
        self._instruments = instruments

    def apply(self, request: OrderRequest) -> Protected:
        instrument = self._instruments(request.instrument)
        if instrument is None:
            # Nothing can be computed without a tick size. The order goes out
            # as it stands and the broker's own answer is the honest one.
            return Protected(request)

        configured = self._config(self._broker, instrument.exchange.code)
        if configured is not None and configured.market_orders_allowed:
            return Protected(request)

        protection = configured or ExchangeProtection()
        segment = ProtectionSegment.of(instrument)
        buffers = protection.for_segment(segment)

        if request.order_type is OrderType.MARKET:
            return self._as_marketable_limit(request, instrument, segment, buffers)
        if request.order_type is OrderType.SL_MARKET:
            return self._as_stop_limit(request, instrument, segment, buffers)
        if request.order_type is OrderType.SL_LIMIT:
            return self._clamped(request, instrument, segment, buffers)
        return Protected(request)

    def _as_marketable_limit(
        self,
        request: OrderRequest,
        instrument: Instrument,
        segment: ProtectionSegment,
        buffers: SegmentBuffers,
    ) -> Protected:
        last = self._last_price(request.instrument)
        if last is None or last.amount <= 0:
            # No price to protect against. Left as MARKET on purpose, so the
            # broker's rejection is what the operator sees rather than a
            # limit price the engine invented out of nothing.
            logger.warning(
                "%s: no live price for %s; sending MARKET unprotected",
                request.client_order_id,
                request.instrument,
            )
            return Protected(request)

        price = marketable_limit_price(last, instrument, segment, buffers, request.side)
        return Protected(
            replace(request, order_type=OrderType.LIMIT, price=price),
            f"MARKET became LIMIT at {price} against a last price of {last}",
        )

    def _as_stop_limit(
        self,
        request: OrderRequest,
        instrument: Instrument,
        segment: ProtectionSegment,
        buffers: SegmentBuffers,
    ) -> Protected:
        trigger = request.trigger_price
        if trigger is None or trigger.amount <= 0:  # pragma: no cover - the request refuses this
            return Protected(request)

        price = sl_limit_from_trigger(trigger, instrument, segment, buffers, request.side)
        return Protected(
            replace(request, order_type=OrderType.SL_LIMIT, price=price),
            f"SL-M became SL with a limit of {price} against a trigger of {trigger}",
        )

    def _clamped(
        self,
        request: OrderRequest,
        instrument: Instrument,
        segment: ProtectionSegment,
        buffers: SegmentBuffers,
    ) -> Protected:
        price, trigger = request.price, request.trigger_price
        if price is None or trigger is None:  # pragma: no cover - the request refuses this
            return Protected(request)

        clamped = clamp_sl_limit(price, trigger, instrument, segment, buffers)
        if clamped == price:
            return Protected(request)
        return Protected(
            replace(request, price=clamped),
            f"SL limit pulled from {price} to {clamped}, inside the band around {trigger}",
        )
