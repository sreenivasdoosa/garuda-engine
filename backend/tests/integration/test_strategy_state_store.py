"""Strategy state survives a restart, one row per subscription per day."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.engine.strategy_state import StrategyState
from garuda.persistence import models
from garuda.persistence.strategy_state_store import StrategyStateStore

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 15, 7, 30, tzinfo=dt.UTC)
DAY = dt.date(2026, 10, 15)
APPA = TradingClientId("appa")


@pytest.fixture
async def store(session_factory: async_sessionmaker[AsyncSession]) -> StrategyStateStore:
    async with session_factory() as session:
        session.add(
            models.TradingClientRow(
                id="appa",
                display_name="Appa",
                broker="ZERODHA",
                client_id="AB1234",
                created_at=NOW,
                updated_at=NOW,
            )
        )
        await session.commit()
    return StrategyStateStore(session_factory)


async def test_a_signalled_tranche_is_read_back_for_its_day(store: StrategyStateStore) -> None:
    state = StrategyState(APPA, "straddle", DAY).tranche_signalled(1, NOW, signals=4, lots=2)
    await store.save(state, now=NOW)

    (back,) = await store.load_day(DAY)
    assert back.has_signalled(1)
    assert back.signalled[1] == NOW
    assert (back.signals_generated_today, back.allocated_lots_today) == (4, 2)
    assert await store.load_day(DAY + dt.timedelta(days=1)) == []


async def test_saving_again_updates_the_one_row(store: StrategyStateStore) -> None:
    first = StrategyState(APPA, "straddle", DAY).tranche_signalled(1, NOW, signals=2, lots=1)
    await store.save(first, now=NOW)
    later = NOW + dt.timedelta(hours=1)
    second = first.tranche_signalled(2, later, signals=2, lots=1)
    second = StrategyState(**{**second.__dict__, "used_risk": Decimal("750.25")})
    await store.save(second, now=later)

    (back,) = await store.load_day(DAY)
    assert set(back.signalled) == {1, 2}
    assert back.used_risk == Decimal("750.25")
    assert back.signal_count == 2
