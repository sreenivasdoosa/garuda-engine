"""The journal store against a real PostgreSQL."""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import text

from garuda.domain import Currency, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.journal import decode_fill, order_filled, order_placed
from garuda.domain.order import ClientOrderId, Fill, OrderRequest, Side
from garuda.journal import PositionBasis, PositionKey, fold
from garuda.persistence import UnitOfWork

pytestmark = pytest.mark.integration

DAY = date(2026, 8, 27)
NEXT_DAY = date(2026, 8, 28)
T0 = datetime(2026, 8, 27, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")
INSTRUMENT = InstrumentId("NSE:NIFTY26AUG25000CE")
BASES = {INSTRUMENT: PositionBasis(Currency.INR, Decimal(1))}


def request(order_id: str = "gar-1") -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId(order_id),
        trading_client=CLIENT,
        instrument=INSTRUMENT,
        side=Side.SELL,
        quantity=75,
        order_type=OrderType.LIMIT,
        product=ProductType.NRML,
        price=Money.of("120.50", Currency.INR),
    )


def a_fill(order_id: str = "gar-1", price: str = "120.55") -> Fill:
    return Fill(
        client_order_id=ClientOrderId(order_id),
        instrument=INSTRUMENT,
        side=Side.SELL,
        quantity=75,
        price=Money.of(price, Currency.INR),
        timestamp=T0,
    )


class TestAppendAndReplay:
    async def test_appending_assigns_increasing_sequences(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            written = await uow.journal.append(
                [
                    order_placed(request("gar-1"), occurred_at=T0, trading_day=DAY),
                    order_placed(request("gar-2"), occurred_at=T0, trading_day=DAY),
                ]
            )
        assert [event.sequence for event in written] == [1, 2]

    async def test_replay_returns_events_in_append_order(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append(
                [
                    order_placed(request(f"gar-{i}"), occurred_at=T0, trading_day=DAY)
                    for i in range(5)
                ]
            )
        async with UnitOfWork(session_factory) as uow:
            replayed = [event async for event in uow.journal.replay(DAY)]
        assert [event.aggregate_id for event in replayed] == [f"gar-{i}" for i in range(5)]
        assert [event.sequence for event in replayed] == [1, 2, 3, 4, 5]

    async def test_replay_can_resume_from_a_sequence(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append(
                [
                    order_placed(request(f"gar-{i}"), occurred_at=T0, trading_day=DAY)
                    for i in range(5)
                ]
            )
        async with UnitOfWork(session_factory) as uow:
            resumed = [event async for event in uow.journal.replay(DAY, after_sequence=3)]
        assert [event.sequence for event in resumed] == [4, 5]

    async def test_last_sequence_reports_the_high_water_mark(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            assert await uow.journal.last_sequence(DAY) == 0
            await uow.journal.append(
                [order_placed(request("gar-1"), occurred_at=T0, trading_day=DAY)]
            )
        async with UnitOfWork(session_factory) as uow:
            assert await uow.journal.last_sequence(DAY) == 1

    async def test_appending_nothing_is_not_an_error(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            assert await uow.journal.append([]) == []


class TestExactness:
    async def test_a_price_survives_a_round_trip_through_the_database(self, session_factory):
        """The journal is worthless if storage rounds what it stored."""
        original = a_fill(price="120.5555")
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append([order_filled(original, trading_day=DAY)])

        async with UnitOfWork(session_factory) as uow:
            (event,) = [e async for e in uow.journal.replay(DAY)]
        assert decode_fill(event.payload) == original
        assert decode_fill(event.payload).price.amount == Decimal("120.5555")

    async def test_a_replayed_journal_folds_to_the_same_state(self, session_factory):
        events = [
            order_placed(request(), occurred_at=T0, trading_day=DAY),
            order_filled(a_fill(), trading_day=DAY),
        ]
        async with UnitOfWork(session_factory) as uow:
            written = await uow.journal.append(events)

        async with UnitOfWork(session_factory) as uow:
            replayed = [event async for event in uow.journal.replay(DAY)]

        assert fold(replayed, BASES) == fold(written, BASES)
        position = fold(replayed, BASES).position(PositionKey(CLIENT, INSTRUMENT))
        assert position is not None
        assert position.quantity == -75


class TestAtomicity:
    """The reason the store takes a session rather than an engine."""

    async def test_a_failure_after_the_append_rolls_the_journal_back(self, session_factory):
        async def append_then_fail() -> None:
            async with UnitOfWork(session_factory) as uow:
                await uow.journal.append([order_placed(request(), occurred_at=T0, trading_day=DAY)])
                raise RuntimeError("the state change failed")

        with pytest.raises(RuntimeError, match="the state change failed"):
            await append_then_fail()

        async with UnitOfWork(session_factory) as uow:
            assert [e async for e in uow.journal.replay(DAY)] == []

    async def test_the_journal_and_the_state_change_commit_together(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append([order_placed(request(), occurred_at=T0, trading_day=DAY)])
            await uow.session.execute(
                text("INSERT INTO app_config (key, value) VALUES ('probe', 'written')")
            )

        async with UnitOfWork(session_factory) as uow:
            journalled = [e async for e in uow.journal.replay(DAY)]
            probe = (
                await uow.session.execute(text("SELECT value FROM app_config WHERE key = 'probe'"))
            ).scalar_one_or_none()
        assert len(journalled) == 1
        assert probe == "written"

    async def test_neither_survives_when_the_state_change_fails(self, session_factory):
        async def write_both_then_fail() -> None:
            async with UnitOfWork(session_factory) as uow:
                await uow.journal.append([order_placed(request(), occurred_at=T0, trading_day=DAY)])
                await uow.session.execute(
                    text("INSERT INTO app_config (key, value) VALUES ('probe', 'written')")
                )
                raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await write_both_then_fail()

        async with UnitOfWork(session_factory) as uow:
            journalled = [e async for e in uow.journal.replay(DAY)]
            probe = (
                await uow.session.execute(text("SELECT value FROM app_config WHERE key = 'probe'"))
            ).scalar_one_or_none()
        assert journalled == []
        assert probe is None, "the state change must not outlive its journal entry"


class TestPartitioning:
    async def test_days_are_stored_separately_and_replayed_separately(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append(
                [
                    order_placed(request("today"), occurred_at=T0, trading_day=DAY),
                    order_placed(request("tomorrow"), occurred_at=T0, trading_day=NEXT_DAY),
                ]
            )

        async with UnitOfWork(session_factory) as uow:
            today = [e.aggregate_id async for e in uow.journal.replay(DAY)]
            tomorrow = [e.aggregate_id async for e in uow.journal.replay(NEXT_DAY)]
        assert today == ["today"]
        assert tomorrow == ["tomorrow"]

    async def test_the_default_partition_accepts_any_day(self, session_factory):
        """Nothing ever fails to insert because a dated partition was missing."""
        far_future = date(2035, 1, 2)
        async with UnitOfWork(session_factory) as uow:
            await uow.journal.append(
                [order_placed(request(), occurred_at=T0, trading_day=far_future)]
            )
        async with UnitOfWork(session_factory) as uow:
            assert len([e async for e in uow.journal.replay(far_future)]) == 1


class TestUnitOfWorkGuards:
    async def test_using_it_outside_its_block_is_refused(self, session_factory):
        from garuda.persistence import UnitOfWorkError

        uow = UnitOfWork(session_factory)
        with pytest.raises(UnitOfWorkError, match="not open"):
            _ = uow.journal
