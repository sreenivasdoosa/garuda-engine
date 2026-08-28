"""From intent to order.

The one path an intent can take:

    Intent -> Sizer -> RiskGate -> OrderManager -> adapter

There is no way around the gate, which is what makes it a safety component
rather than a feature. Every refusal is reported with its reason: an operator
looking at a strategy that did nothing today needs to know whether it saw no
signal, could not afford a lot, or was vetoed.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from garuda.capital.sizing import Sizer, Sizing
from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import Intent
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.order import Order, OrderRequest, Side
from garuda.domain.position import opening_side
from garuda.ordermgmt.ids import ClientOrderIdSequence
from garuda.ordermgmt.manager import OrderManager
from garuda.rms.gate import RiskContext, RiskDecision, RiskGate
from garuda.rms.limits import RiskLimits


@dataclass(frozen=True)
class IntentOutcome:
    """What became of one intent."""

    intent: Intent
    sizing: Sizing | None = None
    decision: RiskDecision | None = None
    orders: tuple[Order, ...] = field(default_factory=tuple)
    refusal: str | None = None

    @property
    def placed(self) -> bool:
        return bool(self.orders)


class TradingPipeline:
    """Sizes, gates and routes intents."""

    def __init__(
        self,
        sizer: Sizer,
        gate: RiskGate,
        order_manager: OrderManager,
        ids: ClientOrderIdSequence,
        instruments: Mapping[InstrumentId, Instrument],
        *,
        limits: RiskLimits | None = None,
    ) -> None:
        self._sizer = sizer
        self._gate = gate
        self._orders = order_manager
        self._ids = ids
        self._instruments = instruments
        self._limits = limits or RiskLimits()

    async def submit(
        self,
        intents: Sequence[Intent],
        *,
        quotes: Mapping[InstrumentId, Tick],
        capital: Money,
        market_open: bool = True,
        kill_switch_reason: str | None = None,
    ) -> tuple[IntentOutcome, ...]:
        outcomes: list[IntentOutcome] = []
        for intent in intents:
            outcomes.append(
                await self._submit_one(
                    intent,
                    quotes=quotes,
                    capital=capital,
                    market_open=market_open,
                    kill_switch_reason=kill_switch_reason,
                )
            )
        return tuple(outcomes)

    async def _submit_one(
        self,
        intent: Intent,
        *,
        quotes: Mapping[InstrumentId, Tick],
        capital: Money,
        market_open: bool,
        kill_switch_reason: str | None,
    ) -> IntentOutcome:
        instrument = self._instruments.get(intent.instrument)
        if instrument is None:
            return IntentOutcome(intent=intent, refusal=f"{intent.instrument} is unknown")

        quote = quotes.get(intent.instrument)
        if quote is None:
            return IntentOutcome(intent=intent, refusal=f"no quote for {intent.instrument}")

        sizing = self._sizer.size(intent, instrument, quote.last_price, capital)
        if not sizing.is_tradable:
            return IntentOutcome(intent=intent, sizing=sizing, refusal=sizing.refusal)

        side = _side_for(intent.direction)
        orders: list[Order] = []
        for slice_quantity in sizing.slices:
            request = OrderRequest(
                client_order_id=self._ids.next(),
                trading_client=intent.trading_client,
                instrument=intent.instrument,
                side=side,
                quantity=slice_quantity,
                order_type=intent.order_type,
                product=intent.product,
                price=intent.limit_price,
                tag=intent.correlation_id,
            )

            decision = self._gate.evaluate(
                RiskContext(
                    request=request,
                    instrument=instrument,
                    now=quote.timestamp,
                    limits=self._limits,
                    quote=quote,
                    market_open=market_open,
                    kill_switch_reason=kill_switch_reason,
                )
            )
            if not decision.allowed:
                # Refuse the whole intent, not just this slice. A half-placed
                # entry is a position nobody asked for.
                return IntentOutcome(
                    intent=intent,
                    sizing=sizing,
                    decision=decision,
                    orders=tuple(orders),
                    refusal=decision.reason,
                )

            result = await self._orders.place(request)
            orders.append(result.order)

        return IntentOutcome(intent=intent, sizing=sizing, orders=tuple(orders))


def _side_for(direction: Direction) -> Side:
    if direction not in (Direction.LONG, Direction.SHORT):  # pragma: no cover
        raise DomainError(f"{direction} is not a tradable direction")
    return opening_side(direction)
