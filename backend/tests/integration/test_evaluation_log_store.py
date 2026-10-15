"""Every evaluation leaves a row an operator can read back."""

from __future__ import annotations

import datetime as dt

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.persistence import models
from garuda.persistence.evaluation_log_store import EvaluationLogStore

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 10, 15, 7, 30, tzinfo=dt.UTC)


async def test_an_evaluation_is_recorded(session_factory: async_sessionmaker[AsyncSession]) -> None:
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
    store = EvaluationLogStore(session_factory)
    await store.record(
        trading_client=TradingClientId("appa"),
        strategy="straddle",
        event="SCHEDULED",
        at=NOW,
        signals=2,
        took_ms=4,
        summary={"tranche": 1, "entered": True, "lots": 2},
    )
    async with session_factory() as session:
        (row,) = (await session.execute(select(models.StrategyEvaluationLogRow))).scalars()
    assert (row.strategy_name, row.event_type, row.signals_generated) == (
        "straddle",
        "SCHEDULED",
        2,
    )
    assert row.result_summary == {"tranche": 1, "entered": True, "lots": 2}
