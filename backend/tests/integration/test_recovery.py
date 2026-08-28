"""Surviving a restart.

The process is destroyed and rebuilt from the journal alone. Nothing is carried
over in memory -- a fresh order manager, a fresh id sequence, a fresh paper
broker -- so anything that comes back came back from the database.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import TYPE_CHECKING

import pytest
from sqlalchemy import text

from garuda.brokers.paper import PaperBroker
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money, OrderStatus, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.market import Tick
from garuda.domain.order import ClientOrderId, OrderRequest, Side
from garuda.journal import PositionBasis, PositionKey
from garuda.ordermgmt import ClientOrderIdSequence, OrderManager, recover
from garuda.persistence import UnitOfWork

if TYPE_CHECKING:
    from collections.abc import Sequence

    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

    from garuda.domain.instrument import Instrument, InstrumentId
    from garuda.domain.journal import JournalEvent

pytestmark = pytest.mark.integration

T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
DAY = date(2026, 8, 27)
CLIENT = TradingClientId("appa-zerodha-paper")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_request(
    instrument_id: InstrumentId, order_id: ClientOrderId, side: Side = Side.SELL
) -> OrderRequest:
    return OrderRequest(
        client_order_id=order_id,
        trading_client=CLIENT,
        instrument=instrument_id,
        side=side,
        quantity=75,
        order_type=OrderType.MARKET,
        product=ProductType.NRML,
    )


class Session:
    """One run of the engine. Deliberately owns nothing across a restart."""

    def __init__(
        self,
        session_factory: async_sessionmaker[AsyncSession],
        nifty_call: Instrument,
    ) -> None:
        self.clock = ReplayClock(T0)
        self.bus = InProcessEventBus()
        self.broker = PaperBroker(CLIENT, self.clock, {nifty_call.id: nifty_call})
        self.session_factory = session_factory
        self.manager = OrderManager(
            adapter=self.broker,
            clock=self.clock,
            bus=self.bus,
            journal=self._append,
            trading_day_for=lambda _: DAY,
        )

    async def _append(self, events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        async with UnitOfWork(self.session_factory) as uow:
            return await uow.journal.append(events)

    async def quote(self, nifty_call: Instrument, last: str) -> None:
        await self.broker.on_tick(
            Tick(
                nifty_call.id,
                rupees(last),
                T0,
                bid=rupees(str(Decimal(last) - Decimal("0.10"))),
                ask=rupees(str(Decimal(last) + Decimal("0.10"))),
            )
        )

    async def trade(self, nifty_call: Instrument, order_id: str, side: Side = Side.SELL) -> None:
        await self.manager.place(a_request(nifty_call.id, ClientOrderId(order_id), side))
        for event in self.broker.drain_events():
            await self.manager.handle(event)


@pytest.fixture
def bases(nifty_call: Instrument) -> dict[InstrumentId, PositionBasis]:
    return {nifty_call.id: PositionBasis(Currency.INR, nifty_call.multiplier)}


class TestRestart:
    async def test_the_order_book_comes_back(self, session_factory, nifty_call, bases):
        before = Session(session_factory, nifty_call)
        await before.quote(nifty_call, "120.00")
        await before.trade(nifty_call, "gar-1")
        await before.trade(nifty_call, "gar-2")

        # The process dies here. Nothing below touches `before`.
        after = Session(session_factory, nifty_call)
        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)
        after.manager.restore(recovered.state.orders)

        assert set(after.manager.orders) == {ClientOrderId("gar-1"), ClientOrderId("gar-2")}
        assert all(o.status is OrderStatus.FILLED for o in after.manager.orders.values())

    async def test_fill_prices_and_quantities_come_back_exactly(
        self, session_factory, nifty_call, bases
    ):
        before = Session(session_factory, nifty_call)
        await before.quote(nifty_call, "120.00")
        await before.trade(nifty_call, "gar-1")
        original = before.manager.order(ClientOrderId("gar-1"))

        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)

        restored = recovered.state.orders[ClientOrderId("gar-1")]
        assert original is not None
        assert restored.filled_quantity == original.filled_quantity
        assert restored.average_fill_price == original.average_fill_price

    async def test_the_position_comes_back(self, session_factory, nifty_call, bases):
        before = Session(session_factory, nifty_call)
        await before.quote(nifty_call, "120.00")
        await before.trade(nifty_call, "gar-1", Side.SELL)

        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)

        position = recovered.state.position(PositionKey(CLIENT, nifty_call.id))
        assert position is not None
        assert position.quantity == -75

    async def test_the_id_counter_resumes_past_what_was_issued(
        self, session_factory, nifty_call, bases
    ):
        """Otherwise the first order after a restart reuses a live id."""
        sequence = ClientOrderIdSequence(DAY)
        before = Session(session_factory, nifty_call)
        await before.quote(nifty_call, "120.00")
        for _ in range(3):
            await before.trade(nifty_call, str(sequence.next()))

        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)

        assert str(recovered.ids.next()) == "gar-20260827-000004"

    async def test_an_order_journalled_but_never_sent_comes_back_unconfirmed(
        self, session_factory, nifty_call, bases
    ):
        """The dangerous case: the process died between journalling and sending."""
        before = Session(session_factory, nifty_call)
        async with UnitOfWork(session_factory) as uow:
            from garuda.domain.journal import order_placed

            await uow.journal.append(
                [
                    order_placed(
                        a_request(nifty_call.id, ClientOrderId("gar-orphan")),
                        occurred_at=T0,
                        trading_day=DAY,
                    )
                ]
            )

        after = Session(session_factory, nifty_call)
        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)
        after.manager.restore(recovered.state.orders)

        assert ClientOrderId("gar-orphan") in after.manager.unconfirmed_orders
        assert before is not after

    async def test_a_halt_survives_the_restart(self, session_factory, nifty_call, bases):
        """A halted engine must not come back up trading."""
        from garuda.domain.journal import trading_halted

        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append(
                [trading_halted("reconciliation mismatch", occurred_at=T0, trading_day=DAY)]
            )

        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)

        assert recovered.is_halted
        assert recovered.state.halt_reason == "reconciliation mismatch"

    async def test_restoring_twice_is_refused(self, session_factory, nifty_call, bases):
        after = Session(session_factory, nifty_call)
        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)
        after.manager.restore(recovered.state.orders)

        await after.quote(nifty_call, "120.00")
        await after.trade(nifty_call, "gar-1")
        with pytest.raises(Exception, match="restore runs once"):
            after.manager.restore(recovered.state.orders)

    async def test_nothing_is_journalled_by_recovery_itself(
        self, session_factory, nifty_call, bases
    ):
        """Recovery reads history; it does not add to it."""
        before = Session(session_factory, nifty_call)
        await before.quote(nifty_call, "120.00")
        await before.trade(nifty_call, "gar-1")

        async with UnitOfWork(session_factory) as uow:
            before_count = (
                await uow.session.execute(text("SELECT count(*) FROM event_journal"))
            ).scalar_one()

        after = Session(session_factory, nifty_call)
        async with UnitOfWork(session_factory) as uow:
            recovered = await recover(uow.journal, DAY, bases)
        after.manager.restore(recovered.state.orders)

        async with UnitOfWork(session_factory) as uow:
            after_count = (
                await uow.session.execute(text("SELECT count(*) FROM event_journal"))
            ).scalar_one()
        assert after_count == before_count
