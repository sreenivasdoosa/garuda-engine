"""Putting the risk gate in front of entries.

The checks existed and nothing ran them: `RiskGate` was constructed only in
tests, so every entry and every protective order went to the broker unchecked.
This is the wiring that makes them count.

**Everything is gated, and an exit is gated differently.** A breach must stop
an account taking *more* risk and must never stop it leaving the risk it has,
so the checks that would prevent closing stand down for an exit — each check
answers that for itself. What survives on the exit path is what the exchange
would refuse anyway.

The request cannot tell an entry from an exit, so the distinction is made
where it is known: the entry service is wired with one placement and the
protective and square-off services with another. The reference engine draws
the same line from the other side, with `skip_price_validation_for_exit` on
its configuration and an explicit "always allow closing positions" on the
checks it bypasses.

**A refusal is definitive.** Nothing left the engine, so it is raised as an
`OrderRejectedError` — which the entry service already treats as "no order
exists, the attempt record can go, a later attempt may safely send a fresh
one". Any other exception would leave it believing an order might be resting
at the exchange.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from datetime import timedelta
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.domain.order import BrokerOrderId, OrderRequest
from garuda.domain.trade import Trade
from garuda.persistence.models import RmsConfigRow
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.broker import OrderRejectedError
from garuda.protocols.clock import Clock
from garuda.rms.gate import RiskContext, RiskGate
from garuda.rms.limits import RiskLimits

logger = logging.getLogger(__name__)

type PlaceOrder = Callable[[OrderRequest], Awaitable[BrokerOrderId]]
type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type QuoteLookup = Callable[[InstrumentId], Tick | None]

#: What the account has realised today, asked for at the moment it is needed
#: rather than held: a gate reading a number computed at start-up would be
#: reading this morning.
type DayResult = Callable[[], Money | None]


def gated(
    place: PlaceOrder,
    *,
    gate: RiskGate,
    limits: RiskLimits,
    instruments: InstrumentLookup,
    quotes: QuoteLookup,
    clock: Clock,
    label: str,
    realized_today: DayResult | None = None,
    is_exit: bool = False,
) -> PlaceOrder:
    """Wrap a placement so the risk gate sees it first.

    ``is_exit`` is set where it is known — by whoever wires the service, since
    the request itself cannot tell. It does not turn the gate off: it tells the
    gate which checks have any business stopping this order.
    """

    async def place_if_allowed(request: OrderRequest) -> BrokerOrderId:
        instrument = instruments(request.instrument)
        if instrument is None:
            # Nothing can be checked about an instrument the master does not
            # know, and sending it unchecked is the opposite of what a gate is
            # for.
            raise OrderRejectedError(
                f"{request.instrument} is not in today's instrument master, so nothing "
                "about this order can be checked"
            )

        now = clock.now()
        decision = gate.evaluate(
            RiskContext(
                request=request,
                instrument=instrument,
                now=now,
                limits=limits,
                # From the venue's own calendar. Left to its default it reads
                # as "always open", which is how a check can look configured
                # and never once fire.
                market_open=instrument.exchange.is_open(now),
                quote=quotes(request.instrument),
                realized_pnl_today=realized_today() if realized_today is not None else None,
                is_exit=is_exit,
            )
        )
        if not decision.allowed:
            logger.warning("%s: refused %s — %s", label, request.instrument, decision.reason)
            raise OrderRejectedError(decision.reason)

        return await place(request)

    return place_if_allowed


async def load_limits(
    sessions: async_sessionmaker[AsyncSession], *, currency: Currency = Currency.INR
) -> RiskLimits:
    """The account-wide limits, from configuration.

    The global row only. The table is keyed by exchange, symbol and segment as
    well, and resolving those the way strategy configuration resolves its
    scopes is worth doing on its own — with the global row read, a limit set
    there is enforced, which is more than was true before.
    """
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.rms_config.all()

    globals_ = [
        row
        for row in rows
        if row.is_active is not False
        and (row.config_level or "").upper() == "GLOBAL"
        and row.symbol is None
        and row.exchange is None
    ]
    if not globals_:
        logger.warning("no global risk configuration; only the unconfigurable checks apply")
        return RiskLimits()
    return _limits_from(globals_[0], currency)


def _limits_from(row: RmsConfigRow, currency: Currency) -> RiskLimits:
    """Map the columns onto the limits the gate knows how to enforce.

    Deliberately partial. A column with no check behind it is not mapped,
    because a limit that reads as configured and is never enforced is worse
    than one that is plainly absent — which is exactly how the daily loss
    limit came to be silently unenforced.
    """
    return RiskLimits(
        max_order_quantity=row.max_order_qty,
        max_order_value=_money(row.max_order_value, currency),
        max_daily_loss=_money(row.max_daily_loss_amount, currency),
        stale_quote_after=(
            timedelta(seconds=row.stale_price_seconds)
            if row.stale_price_seconds is not None
            else None
        ),
        max_spread_fraction=(
            row.max_bid_ask_spread_pct / Decimal(100)
            if row.max_bid_ask_spread_pct is not None
            else None
        ),
        min_volume=row.min_volume_today,
    )


def _money(value: Decimal | None, currency: Currency) -> Money | None:
    return Money(value, currency) if value is not None else None


def realised_today(trades: Callable[[], Sequence[Trade]]) -> DayResult:
    """The account's realised result so far, for the daily loss limit.

    Closed positions only. An open one has a mark, not a result, and counting
    a mark would have the limit trip on a position that has not lost anything
    yet — and stop the entries that might have hedged it.
    """

    def total() -> Money | None:
        realised = [trade.realised_pnl for trade in trades() if trade.realised_pnl is not None]
        if not realised:
            return None
        return sum(realised[1:], realised[0])

    return total
