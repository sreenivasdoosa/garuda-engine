"""The paper broker.

Simulated fills, modelled explicitly. **A fill at mid is a lie and is not the
default**: a buy crosses the spread to the ask and then pays slippage on top,
a sell does the mirror image. A strategy validated against mid-price fills
looks profitable and is not.

Everything here is deterministic. There is no randomness anywhere -- not for
slippage, not for rejection -- because a paper session has to replay to the
same result as the run that recorded it. Rejection is rule-based: no quote
means no fill, which is the same fail-closed stance the risk gate takes.

Paper is a property of a *subscription*, so this broker runs alongside real
ones in the same process, on the same signals, for different accounts.
"""

from __future__ import annotations

import asyncio
import itertools
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass
from decimal import ROUND_DOWN, ROUND_UP, Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.enums import OrderStatus, OrderType, ProductType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.order import BrokerOrderId, ClientOrderId, Fill, OrderRequest, Side
from garuda.domain.position import Position
from garuda.protocols.broker import (
    BrokerEvent,
    BrokerOrder,
    BrokerPosition,
    Funds,
    OrderAccepted,
    OrderCancelled,
    OrderChanges,
    OrderFilled,
    OrderRejected,
    OrderRejectedError,
)
from garuda.protocols.clock import Clock


@dataclass(frozen=True, slots=True)
class PaperFillPolicy:
    """The assumptions this broker trades on, stated rather than implied."""

    #: Ticks of adverse slippage applied after crossing the spread.
    slippage_ticks: int = 1
    #: Spread assumed when the feed carries no depth, in ticks. Applied as
    #: half either side of the last traded price.
    assumed_spread_ticks: int = 2
    #: With no quote at all, refuse rather than invent a price.
    reject_without_quote: bool = True

    def describe(self) -> str:
        return (
            f"crosses the spread, {self.slippage_ticks} tick(s) slippage, "
            f"{self.assumed_spread_ticks}-tick assumed spread when depth is absent"
        )


@dataclass(frozen=True, slots=True)
class _Working:
    """An order resting in the simulated book."""

    broker_order_id: BrokerOrderId
    request: OrderRequest
    triggered: bool = False


class PaperBroker:
    """A broker adapter that fills orders in process."""

    def __init__(
        self,
        trading_client: TradingClientId,
        clock: Clock,
        instruments: Mapping[InstrumentId, Instrument],
        policy: PaperFillPolicy | None = None,
        starting_funds: Money | None = None,
    ) -> None:
        self._trading_client = trading_client
        self._clock = clock
        self._instruments = instruments
        self.policy = policy or PaperFillPolicy()
        self._events: asyncio.Queue[BrokerEvent] = asyncio.Queue()
        self._working: dict[BrokerOrderId, _Working] = {}
        self._quotes: dict[InstrumentId, Tick] = {}
        self._positions: dict[InstrumentId, Position] = {}
        #: The product each position was opened under. A broker reports this,
        #: and MIS versus NRML changes both margin and square-off behaviour, so
        #: it is remembered rather than assumed.
        self._products: dict[InstrumentId, ProductType] = {}
        self._filled: dict[ClientOrderId, tuple[int, Money]] = {}
        self._ids = itertools.count(1)
        self._funds = starting_funds

    @property
    def trading_client(self) -> TradingClientId:
        return self._trading_client

    # -- market data --------------------------------------------------------

    def observe(self, tick: Tick) -> None:
        """Record a quote without acting on it."""
        self._quotes[tick.instrument] = tick

    async def on_tick(self, tick: Tick) -> None:
        """Take a quote and work the resting book against it."""
        self.observe(tick)
        for working in list(self._working.values()):
            if working.request.instrument != tick.instrument:
                continue
            await self._try_fill(working, tick)

    # -- the contract -------------------------------------------------------

    async def place(self, request: OrderRequest) -> BrokerOrderId:
        instrument = self._instrument(request.instrument)
        broker_order_id = BrokerOrderId(f"paper-{next(self._ids):06d}")
        now = self._clock.now()

        quote = self._quotes.get(request.instrument)
        if quote is None and self.policy.reject_without_quote:
            await self._events.put(
                OrderRejected(
                    client_order_id=request.client_order_id,
                    reason="no quote available; the paper broker does not invent a price",
                    at=now,
                )
            )
            raise OrderRejectedError(f"{request.client_order_id}: no quote for {instrument}")

        await self._events.put(
            OrderAccepted(
                client_order_id=request.client_order_id,
                broker_order_id=broker_order_id,
                at=now,
            )
        )
        working = _Working(broker_order_id=broker_order_id, request=request)
        self._working[broker_order_id] = working
        if quote is not None:
            await self._try_fill(working, quote)
        return broker_order_id

    async def cancel(self, broker_order_id: BrokerOrderId) -> None:
        working = self._working.pop(broker_order_id, None)
        if working is None:
            return
        await self._events.put(
            OrderCancelled(client_order_id=working.request.client_order_id, at=self._clock.now())
        )

    async def modify(self, broker_order_id: BrokerOrderId, changes: OrderChanges) -> None:
        working = self._working.get(broker_order_id)
        if working is None:
            raise OrderRejectedError(f"{broker_order_id}: not working")
        request = working.request
        self._working[broker_order_id] = _Working(
            broker_order_id=broker_order_id,
            request=OrderRequest(
                client_order_id=request.client_order_id,
                trading_client=request.trading_client,
                instrument=request.instrument,
                side=request.side,
                quantity=changes.quantity or request.quantity,
                order_type=request.order_type,
                product=request.product,
                price=changes.price or request.price,
                trigger_price=changes.trigger_price or request.trigger_price,
                tag=request.tag,
            ),
            triggered=working.triggered,
        )

    async def fetch_orders(self) -> Sequence[BrokerOrder]:
        return [
            BrokerOrder(
                broker_order_id=working.broker_order_id,
                client_order_id=working.request.client_order_id,
                instrument=working.request.instrument,
                side=working.request.side,
                quantity=working.request.quantity,
                filled_quantity=0,
                status=OrderStatus.NEW,
                product=working.request.product,
            )
            for working in self._working.values()
        ]

    async def fetch_positions(self) -> Sequence[BrokerPosition]:
        return [
            BrokerPosition(
                instrument=position.instrument,
                quantity=position.quantity,
                average_price=position.average_price,
                product=self._products.get(position.instrument, ProductType.NRML),
                multiplier=position.multiplier,
            )
            for position in self._positions.values()
            if not position.is_flat
        ]

    async def fetch_funds(self) -> Funds:
        if self._funds is None:
            raise OrderRejectedError("the paper broker was given no starting funds")
        zero = Money.zero(self._funds.currency)
        return Funds(available=self._funds, used=zero, total=self._funds)

    async def fetch_instruments(self) -> Sequence[Instrument]:
        return list(self._instruments.values())

    async def events(self) -> AsyncIterator[BrokerEvent]:
        while True:
            yield await self._events.get()

    def drain_events(self) -> list[BrokerEvent]:
        """Every event emitted so far. For tests and for synchronous drivers."""
        drained: list[BrokerEvent] = []
        while not self._events.empty():
            drained.append(self._events.get_nowait())
        return drained

    # -- the fill model -----------------------------------------------------

    async def _try_fill(self, working: _Working, quote: Tick) -> None:
        request = working.request
        instrument = self._instrument(request.instrument)

        if request.order_type in (OrderType.SL_MARKET, OrderType.SL_LIMIT):
            if not working.triggered and not self._is_triggered(request, quote):
                return
            working = _Working(working.broker_order_id, request, triggered=True)
            self._working[working.broker_order_id] = working

        price = self._fill_price(request, quote, instrument, working.triggered)
        if price is None:
            return

        fill = Fill(
            client_order_id=request.client_order_id,
            instrument=request.instrument,
            side=request.side,
            quantity=request.quantity,
            price=price,
            timestamp=self._clock.now(),
            broker_fill_id=f"{working.broker_order_id}-1",
        )
        self._working.pop(working.broker_order_id, None)
        self._products[request.instrument] = request.product
        self._apply(fill, instrument)
        await self._events.put(OrderFilled(fill=fill))

    def _is_triggered(self, request: OrderRequest, quote: Tick) -> bool:
        trigger = request.trigger_price
        if trigger is None:  # pragma: no cover - the request refuses this
            return False
        if request.side is Side.BUY:
            return quote.last_price >= trigger
        return quote.last_price <= trigger

    def _fill_price(
        self,
        request: OrderRequest,
        quote: Tick,
        instrument: Instrument,
        triggered: bool,
    ) -> Money | None:
        touch = self._touch(request.side, quote, instrument)

        is_limit = request.order_type is OrderType.LIMIT or (
            request.order_type is OrderType.SL_LIMIT and triggered
        )
        if not is_limit:
            return touch

        limit = request.price
        if limit is None:  # pragma: no cover - the request refuses this
            return None
        if request.side is Side.BUY:
            return min(touch, limit) if touch <= limit else None
        return max(touch, limit) if touch >= limit else None

    def _touch(self, side: Side, quote: Tick, instrument: Instrument) -> Money:
        """The price paid when crossing the spread, plus adverse slippage.

        Where the feed carries depth, that is the far touch. Where it does not,
        half the assumed spread either side of the last traded price -- never
        the last price itself, which would be a fill at mid by another name.
        """
        currency = quote.last_price.currency
        tick_size = instrument.tick_size
        half_spread = Money(
            tick_size * Decimal(self.policy.assumed_spread_ticks) / Decimal(2), currency
        )
        slippage = Money(tick_size * Decimal(self.policy.slippage_ticks), currency)

        if side is Side.BUY:
            base = quote.ask if quote.ask is not None else quote.last_price + half_spread
            return instrument.quantize_price(base + slippage, rounding=ROUND_UP)
        base = quote.bid if quote.bid is not None else quote.last_price - half_spread
        return instrument.quantize_price(base - slippage, rounding=ROUND_DOWN)

    def _apply(self, fill: Fill, instrument: Instrument) -> None:
        current = self._positions.get(fill.instrument) or Position.flat(
            fill.instrument, instrument.exchange.currency, instrument.multiplier
        )
        self._positions[fill.instrument] = current.apply(fill)

    def _instrument(self, instrument_id: InstrumentId) -> Instrument:
        instrument = self._instruments.get(instrument_id)
        if instrument is None:
            raise OrderRejectedError(f"{instrument_id}: unknown to the paper broker")
        return instrument

    def position(self, instrument: InstrumentId) -> Position | None:
        return self._positions.get(instrument)
