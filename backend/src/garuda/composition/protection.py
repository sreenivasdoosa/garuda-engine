"""Order protection, from the rows the Broker Config page edits.

`broker_exchange_config` says, per broker and venue, whether raw market
orders may go out at all and how far from the live price a protected order
sits in each segment. :mod:`garuda.ordermgmt.protection` applies those
numbers to an order; this module is where the rows become the lookup it
reads, and where the placement and modification an account's services call
are wrapped so every order passes through it.

**A missing row protects.** That is the reference engine's posture since
its V303 and the safe one: an unconfigured venue converts market orders
rather than sending them raw. The Console shows which (broker, venue)
pairs have no row so the operator can set one, but nothing waits on it.

**A zero in a row means unset**, and the segment's code default applies --
the reference's ``positiveOr``. The page shows the default dimmed where a
value is zero, so what the operator sees is what the engine uses.

**The book is swapped, not rebuilt.** The page writes a row and the engine
re-reads the table into the same book, so the next order carries the new
numbers without a restart.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.instrument import Instrument
from garuda.domain.order import BrokerOrderId, OrderRequest
from garuda.domain.protection import DEFAULT_BUFFERS, ProtectionSegment, SegmentBuffers
from garuda.ordermgmt.protection import ExchangeProtection, MarketProtection
from garuda.persistence.models import BrokerExchangeConfigRow
from garuda.persistence.uow import UnitOfWork
from garuda.protocols.broker import OrderChanges
from garuda.trademgmt.entry import PlaceOrder
from garuda.trademgmt.trailing import ModifyOrder

logger = logging.getLogger(__name__)

type ProtectionKey = tuple[str, str]


def protection_from(row: BrokerExchangeConfigRow) -> ExchangeProtection:
    """One row, as the order path reads it.

    A buffer at or below zero is unset and takes the segment's default; a
    configured one wins. Mixed rows are allowed -- a limit buffer set and a
    stop gap left at zero -- because that is what the page lets an operator
    save.
    """
    configured = {
        ProtectionSegment.EQUITY: (
            row.limit_order_buffer_equity,
            row.sl_trigger_to_limit_gap_equity,
        ),
        ProtectionSegment.FUTURES: (
            row.limit_order_buffer_futures,
            row.sl_trigger_to_limit_gap_futures,
        ),
        ProtectionSegment.OPTIONS: (
            row.limit_order_buffer_options,
            row.sl_trigger_to_limit_gap_options,
        ),
    }
    buffers: dict[ProtectionSegment, SegmentBuffers] = {}
    for segment, (limit, gap) in configured.items():
        default = DEFAULT_BUFFERS[segment]
        buffers[segment] = SegmentBuffers(
            limit_buffer_percent=_positive_or(limit, default.limit_buffer_percent),
            sl_gap_percent=_positive_or(gap, default.sl_gap_percent),
        )
    return ExchangeProtection(
        market_orders_allowed=bool(row.market_orders_allowed), buffers=buffers
    )


def _positive_or(value: Decimal | None, fallback: Decimal) -> Decimal:
    return value if value is not None and value > 0 else fallback


def key_of(broker: str, exchange: str) -> ProtectionKey:
    """Brokers are stored lower-case and exchanges upper; callers vary."""
    return broker.strip().lower(), exchange.strip().upper()


class ProtectionBook:
    """Every configured (broker, venue) pair, swappable while the engine runs."""

    def __init__(self, rows: Mapping[ProtectionKey, ExchangeProtection] | None = None) -> None:
        self._rows: dict[ProtectionKey, ExchangeProtection] = dict(rows or {})
        self.version = 0

    def lookup(self, broker: str, exchange: str) -> ExchangeProtection | None:
        """The row, or None -- which the order path reads as "protect"."""
        return self._rows.get(key_of(broker, exchange))

    def sl_gap_percent(self, broker: str, instrument: Instrument | None) -> Decimal:
        """How far a stop's limit may sit from its trigger, for this instrument.

        What the protective-order service shapes a stop with. Read from the
        row when there is one and from the segment's default when there is
        not, so a stop is shaped by the same gap the clamp would enforce.
        """
        if instrument is None:
            return DEFAULT_BUFFERS[ProtectionSegment.OPTIONS].sl_gap_percent
        segment = ProtectionSegment.of(instrument)
        configured = self.lookup(broker, instrument.exchange.code)
        protection = configured or ExchangeProtection()
        return protection.for_segment(segment).sl_gap_percent

    def replace(self, rows: Mapping[ProtectionKey, ExchangeProtection]) -> None:
        """Take the table whole: a deleted row has to stop applying."""
        self._rows = dict(rows)
        self.version += 1
        logger.info(
            "order protection reloaded: %d (broker, venue) row(s) (version %d)",
            len(self._rows),
            self.version,
        )

    def __len__(self) -> int:
        return len(self._rows)


async def load_protection(
    sessions: async_sessionmaker[AsyncSession],
) -> dict[ProtectionKey, ExchangeProtection]:
    """Every `broker_exchange_config` row, keyed for the book."""
    async with UnitOfWork(sessions) as uow:
        rows = await uow.repositories.broker_exchange_config.all()
    loaded = {key_of(row.broker_name, row.exchange_code): protection_from(row) for row in rows}
    raw = sorted(f"{b}:{e}" for (b, e), p in loaded.items() if p.market_orders_allowed)
    if raw:
        logger.warning("raw market orders are allowed on: %s", ", ".join(raw))
    return loaded


# -- wrapping the account's order path --------------------------------------


def protected_placement(place: PlaceOrder, protection: MarketProtection) -> PlaceOrder:
    """Every order passes through protection on its way to the broker.

    Inside the risk gate, not outside it: the gate judges the order the
    strategy asked for, and protection shapes the one the broker receives.
    That is the reference's order too -- RMS first, protection inside
    ``placeOrder``.
    """

    async def place_protected(request: OrderRequest) -> BrokerOrderId:
        protected = protection.apply(request)
        if protected.was_changed:
            logger.info("%s: %s", request.client_order_id, protected.change)
        return await place(protected.request)

    return place_protected


def protected_modification(
    modify: ModifyOrder,
    protection: MarketProtection,
    instrument_of: Callable[[BrokerOrderId], Instrument | None],
) -> ModifyOrder:
    """The modify-path twin: a moved stop stays inside the permitted band.

    The trailing service moves a stop by sending a new trigger and a new
    limit together. The limit it computes already respects the gap, so this
    changes nothing on an ordinary day -- it exists for the day the two
    disagree, which is the day the exchange would refuse the modify.
    """

    async def modify_protected(order_id: BrokerOrderId, changes: OrderChanges) -> None:
        instrument = instrument_of(order_id)
        if instrument is not None:
            clamped, why = protection.clamp_changes(instrument, changes)
            if why is not None:
                logger.info("%s: %s", order_id, why)
                changes = clamped
        await modify(order_id, changes)

    return modify_protected
