"""Breakout watches survive a restart, and a fired one is not re-armed."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, OptionType
from garuda.domain.instrument import InstrumentId
from garuda.engine.breakout import Watch, WatchedLeg, watch_key
from garuda.engine.vocabulary import BreakoutDirection, BreakoutTriggerMode, BreakoutWatchType
from garuda.persistence import models
from garuda.persistence.breakout_watch_store import BreakoutWatchStore

pytestmark = pytest.mark.integration

IST = ZoneInfo("Asia/Kolkata")
DAY = dt.date(2026, 10, 15)
NOW = dt.datetime(2026, 10, 15, 13, 0, tzinfo=IST)
APPA = TradingClientId("appa")


@pytest.fixture
async def store(session_factory: async_sessionmaker[AsyncSession]) -> BreakoutWatchStore:
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
    return BreakoutWatchStore(session_factory)


def a_watch() -> Watch:
    return Watch(
        key=watch_key(APPA, "straddle", DAY, 1, "CE"),
        trading_client=APPA,
        strategy="straddle",
        tranche=1,
        kind=BreakoutWatchType.OPTION_SYMBOL,
        watched=InstrumentId("NFO:N25000CE"),
        direction=BreakoutDirection.BELOW,
        mode=BreakoutTriggerMode.PERCENTAGE,
        reference_price=Decimal(120),
        above=Decimal(144),
        below=Decimal(96),
        valid_till=dt.datetime(2026, 10, 15, 15, 15, tzinfo=IST),
        group="Tranch-1|Breakout",
        legs=(
            WatchedLeg(
                InstrumentId("NFO:N25000CE"),
                Direction.SHORT,
                False,
                OptionType.CALL,
                Decimal(25000),
            ),
            WatchedLeg(
                InstrumentId("NFO:N26000CE"), Direction.LONG, True, OptionType.CALL, Decimal(26000)
            ),
        ),
    )


async def test_an_armed_watch_is_read_back_exactly(store: BreakoutWatchStore) -> None:
    await store.save(a_watch(), trigger_value=Decimal(20), now=NOW)
    (back,) = await store.live_on(DAY, IST)
    assert back == a_watch()


async def test_a_fired_watch_is_not_live_after_a_restart(store: BreakoutWatchStore) -> None:
    await store.save(a_watch(), trigger_value=Decimal(20), now=NOW)
    await store.save(a_watch().fired(NOW, Decimal(95)), trigger_value=Decimal(20), now=NOW)
    assert await store.live_on(DAY, IST) == []
    assert await store.live_on(DAY + dt.timedelta(days=1), IST) == []
