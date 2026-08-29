"""Deterministic replay.

The exit criterion for the vertical slice, and the regression net for
everything after it: a recorded day must replay to the state that produced it,
and two identical runs must produce identical journals.

This is what catches the class of bug where a refactor quietly changes an exit
decision. Not by inspecting the code -- by comparing what the engine did.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.capital import CapitalLotAllocator, Sizer
from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import TradingMode
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.journal import JournalEvent
from garuda.domain.market import DepthLevel, Tick
from garuda.engine import (
    FixedDirection,
    FixedInstrumentSelector,
    LegSpec,
    SideRule,
    StrategySpec,
    Subscription,
)
from garuda.journal import PositionBasis, PositionKey, fold
from garuda.persistence import UnitOfWork
from garuda.rms import RiskGate, RiskLimits, default_checks
from garuda.testing import SessionHarness, comparable

pytestmark = pytest.mark.integration

DAY = date(2026, 8, 27)
OPEN = datetime(2026, 8, 27, 9, 15, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha-paper")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_session(instrument: Instrument, minutes: int = 12) -> list[Tick]:
    """A scripted session: a price that moves, one tick a minute."""
    path = ["120", "121", "123", "122", "119", "117", "118", "121", "125", "124", "126", "130"]
    ticks: list[Tick] = []
    for index in range(minutes):
        last = Decimal(path[index % len(path)])
        ticks.append(
            Tick(
                instrument=instrument.id,
                last_price=Money(last, Currency.INR),
                timestamp=OPEN + timedelta(minutes=index),
                bids=(DepthLevel(Money(last - Decimal("0.10"), Currency.INR), 75),),
                asks=(DepthLevel(Money(last + Decimal("0.10"), Currency.INR), 75),),
                volume=250_000,
            )
        )
    return ticks


def a_spec(instrument: Instrument) -> StrategySpec:
    return StrategySpec(
        name="short-call",
        underlying=InstrumentId("NSE:NIFTY"),
        direction=FixedDirection(Direction.SHORT),
        legs=(
            LegSpec(
                FixedInstrumentSelector(instrument.id),
                SideRule.SAME_AS_SIGNAL,
                product=ProductType.NRML,
            ),
        ),
    )


def a_subscription() -> Subscription:
    return Subscription(
        strategy="short-call",
        trading_client=CLIENT,
        mode=TradingMode.PAPER,
        capital=rupees("500000"),
    )


def build(
    session_factory: async_sessionmaker[AsyncSession], instrument: Instrument
) -> SessionHarness:
    async def journal(events: Sequence[JournalEvent]) -> Sequence[JournalEvent]:
        async with UnitOfWork(session_factory) as uow:
            return await uow.journal.append(events)

    return SessionHarness(
        spec=a_spec(instrument),
        subscription=a_subscription(),
        instruments={instrument.id: instrument},
        journal=journal,
        trading_day=DAY,
        start=OPEN,
        sizer=Sizer(CapitalLotAllocator()),
        gate=RiskGate(default_checks()),
        limits=RiskLimits(stale_quote_after=timedelta(minutes=5)),
    )


async def read_journal(
    session_factory: async_sessionmaker[AsyncSession],
) -> list[JournalEvent]:
    async with UnitOfWork(session_factory) as uow:
        return [event async for event in uow.journal.replay(DAY)]


async def wipe(session_factory: async_sessionmaker[AsyncSession]) -> None:
    async with UnitOfWork(session_factory) as uow:
        await uow.session.execute(text("TRUNCATE event_journal RESTART IDENTITY"))


class TestASessionRuns:
    async def test_the_strategy_actually_trades(self, session_factory, nifty_call):
        outcome = await build(session_factory, nifty_call).run(a_session(nifty_call))
        assert outcome.evaluations == 12
        assert outcome.filled_orders >= 1, "a session that never trades proves nothing"

    async def test_it_enters_once_and_does_not_re_enter_on_every_tick(
        self, session_factory, nifty_call
    ):
        """One entry across twelve ticks, however many orders it takes to place.

        Capital of 5,00,000 buys 55 lots at 120, which the exchange freeze
        limit splits into three orders — one intent, three orders, and no
        second entry on any later tick.
        """
        outcome = await build(session_factory, nifty_call).run(a_session(nifty_call))
        assert len(outcome.outcomes) == 1, "exactly one intent was submitted"
        assert len({o.request.tag for o in outcome.orders.values()}) == 1
        assert len(outcome.orders) == 3

    async def test_everything_it_did_is_in_the_journal(self, session_factory, nifty_call):
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        events = await read_journal(session_factory)
        kinds = [e.event_type.value for e in events]
        assert kinds.count("ORDER_PLACED") == 3
        assert kinds.count("ORDER_ACCEPTED") == 3
        assert kinds.count("ORDER_FILLED") == 3

    async def test_the_slices_add_up_to_the_position(self, session_factory, nifty_call):
        outcome = await build(session_factory, nifty_call).run(a_session(nifty_call))
        placed = sum(o.request.quantity for o in outcome.orders.values())
        assert placed == 4125  # 55 lots of 75
        assert outcome.positions[nifty_call.id].quantity == -4125


class TestReplayReproducesState:
    async def test_folding_the_journal_reproduces_the_position(self, session_factory, nifty_call):
        live = await build(session_factory, nifty_call).run(a_session(nifty_call))
        events = await read_journal(session_factory)

        replayed = fold(events, {nifty_call.id: PositionBasis(Currency.INR, nifty_call.multiplier)})
        position = replayed.position(PositionKey(CLIENT, nifty_call.id))
        live_position = live.positions[nifty_call.id]

        assert position is not None
        assert position.quantity == live_position.quantity
        assert position.average_price == live_position.average_price
        assert position.realized_pnl == live_position.realized_pnl

    async def test_folding_the_journal_reproduces_every_order(self, session_factory, nifty_call):
        live = await build(session_factory, nifty_call).run(a_session(nifty_call))
        events = await read_journal(session_factory)
        replayed = fold(events, {nifty_call.id: PositionBasis(Currency.INR, nifty_call.multiplier)})

        assert set(replayed.orders) == set(live.orders)
        for order_id, order in replayed.orders.items():
            assert order.status is live.orders[order_id].status
            assert order.filled_quantity == live.orders[order_id].filled_quantity
            assert order.average_fill_price == live.orders[order_id].average_fill_price


class TestTwoRunsAreIdentical:
    async def test_the_journals_match_event_for_event(self, session_factory, nifty_call):
        """Same inputs, same journal — including the order events were written."""
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        first = comparable(await read_journal(session_factory))

        await wipe(session_factory)

        await build(session_factory, nifty_call).run(a_session(nifty_call))
        second = comparable(await read_journal(session_factory))

        assert first == second

    async def test_fill_prices_are_identical_not_merely_close(self, session_factory, nifty_call):
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        first = await read_journal(session_factory)
        await wipe(session_factory)
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        second = await read_journal(session_factory)

        def prices(events: Sequence[JournalEvent]) -> list[object]:
            return [e.payload["price"] for e in events if e.event_type.value == "ORDER_FILLED"]

        assert prices(first) == prices(second)
        assert prices(first), "the session must actually have filled something"

    async def test_client_order_ids_are_reproduced(self, session_factory, nifty_call):
        """A random id would differ on every run and defeat the comparison."""
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        first = [e.aggregate_id for e in await read_journal(session_factory)]
        await wipe(session_factory)
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        second = [e.aggregate_id for e in await read_journal(session_factory)]
        assert first == second

    async def test_a_different_market_produces_a_different_journal(
        self, session_factory, nifty_call
    ):
        """The comparison would be worthless if it passed for any two runs."""
        await build(session_factory, nifty_call).run(a_session(nifty_call))
        original = comparable(await read_journal(session_factory))

        await wipe(session_factory)

        cheaper = [
            Tick(
                instrument=tick.instrument,
                last_price=tick.last_price - rupees("20"),
                timestamp=tick.timestamp,
                bids=tuple(
                    DepthLevel(level.price - rupees("20"), level.quantity) for level in tick.bids
                ),
                asks=tuple(
                    DepthLevel(level.price - rupees("20"), level.quantity) for level in tick.asks
                ),
                volume=tick.volume,
            )
            for tick in a_session(nifty_call)
        ]
        await build(session_factory, nifty_call).run(cheaper)
        moved = comparable(await read_journal(session_factory))

        assert original != moved


class TestReplayIsFast:
    async def test_a_full_session_replays_without_waiting_for_the_clock(
        self, session_factory, nifty_call
    ):
        """375 minutes of market time, in test time."""
        started = datetime.now(UTC)
        outcome = await build(session_factory, nifty_call).run(a_session(nifty_call, 375))
        assert outcome.evaluations == 375
        assert datetime.now(UTC) - started < timedelta(seconds=30)
