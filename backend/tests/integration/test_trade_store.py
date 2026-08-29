"""Trades surviving a restart, against a real PostgreSQL.

A round trip through memory proves the encoding; only a round trip through the
database proves the trade is actually recoverable.
"""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.alerts.manager import AlertManager
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.trade import Protection, Relationships, Trade, TradeId
from garuda.domain.trade_signal import EntryRules, SignalType, TradeSignal
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.persistence import UnitOfWork
from garuda.persistence.trade_store import TradeStore

pytestmark = pytest.mark.integration

type Sessions = async_sessionmaker[AsyncSession]

NOW = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")
CALL = InstrumentId("NFO:NIFTY26AUG25000CE")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


async def an_account(session_factory: Sessions) -> None:
    from sqlalchemy import text

    async with UnitOfWork(session_factory) as uow:
        await uow.session.execute(
            text(
                "insert into trading_clients (id, display_name, broker, client_id, enabled,"
                " is_pro, websocket_enabled, is_market_data_source, created_at, updated_at)"
                " values (:id, :n, 'zerodha', 'AB1234', true, false, true, false, now(), now())"
                " on conflict (id) do nothing"
            ),
            {"id": CLIENT.value, "n": "Appa"},
        )


def a_store(session_factory: Sessions) -> TradeStore:
    async def sink(alert: Alert) -> None: ...

    alerts = AlertManager(
        clock=ReplayClock(NOW),
        bus=InProcessEventBus(),
        trading_day_for=lambda now: NOW.date(),
        sink=sink,
    )
    return TradeStore(session_factory, alerts, label="Appa (zerodha:AB1234)")


def a_trade(trade_id: str = "t-1") -> Trade:
    trade = Trade(
        id=TradeId(trade_id),
        trading_client=CLIENT,
        instrument=CALL,
        strategy="straddle",
        direction=Direction.SHORT,
        product=ProductType.NRML,
        quantity=75,
        contract_multiplier=Decimal(1),
        signal_id="sig-1",
        protection=Protection(
            stop_loss=rupees("150.55"), initial_stop_loss=rupees("160"), is_trailing=True
        ),
        relationships=Relationships(hedge_correlation_id="h-1", leg_role=LegRole.MAIN),
    )
    return trade.with_entry_fill(75, rupees("120.3333"), NOW)


def a_signal(signal_id: str = "sig-1") -> TradeSignal:
    return TradeSignal(
        id=signal_id,
        trading_client=CLIENT,
        instrument=CALL,
        strategy="straddle",
        signal_type=SignalType.SHORT_ENTRY,
        product=ProductType.NRML,
        quantity=75,
        generated_at=NOW,
        entry=EntryRules(trigger=rupees("120")),
    )


class TestSurvivingARestart:
    async def test_a_live_trade_comes_back(self, session_factory):
        await an_account(session_factory)
        store = a_store(session_factory)
        original = a_trade()
        assert await store.save_trade(original, NOW)

        trades, _ = await store.load(CLIENT)
        assert [t.id for t in trades] == [TradeId("t-1")]
        assert trades[0] == original

    async def test_its_prices_are_exact(self, session_factory):
        """A rounded average entry is a wrong P&L on every report after it."""
        await an_account(session_factory)
        store = a_store(session_factory)
        await store.save_trade(a_trade(), NOW)

        trades, _ = await store.load(CLIENT)
        assert trades[0].entry is not None
        assert trades[0].entry.amount == Decimal("120.3333")

    async def test_a_signal_comes_back_with_its_triggered_flag(self, session_factory):
        """Otherwise the restart places a second order for one decision."""
        await an_account(session_factory)
        store = a_store(session_factory)
        await store.save_signal(a_signal().triggered(), NOW)

        _, signals = await store.load(CLIENT)
        assert [s.id for s in signals] == ["sig-1"]
        assert signals[0].is_triggered

    async def test_saving_again_replaces_rather_than_duplicates(self, session_factory):
        """A trade changes several times a second under a fill burst."""
        await an_account(session_factory)
        store = a_store(session_factory)
        trade = a_trade()
        await store.save_trade(trade, NOW)
        moved = replace(trade, protection=trade.protection.moved_to(rupees("140")))
        await store.save_trade(moved, NOW + timedelta(seconds=1))

        trades, _ = await store.load(CLIENT)
        assert len(trades) == 1
        assert trades[0].protection.stop_loss == rupees("140")
        assert trades[0].protection.initial_stop_loss == rupees("160")

    async def test_a_finished_trade_keeps_its_reason_and_exit(self, session_factory):
        await an_account(session_factory)
        store = a_store(session_factory)
        done = a_trade().closed(rupees("111.11"), TradeExitReason.TRAILING_STOP_LOSS, NOW)
        await store.save_trade(done, NOW)

        trades, _ = await store.load(CLIENT)
        assert trades[0].state is TradeState.COMPLETED
        assert trades[0].exit_reason is TradeExitReason.TRAILING_STOP_LOSS
        assert trades[0].exit == rupees("111.11")

    async def test_an_exit_already_under_way_survives(self, session_factory):
        """A restart mid-square-off must not forget it was getting out."""
        await an_account(session_factory)
        store = a_store(session_factory)
        await store.save_trade(a_trade().exiting(TradeExitReason.DAILY_LOSS_BREACH), NOW)

        trades, _ = await store.load(CLIENT)
        assert trades[0].exiting_for is TradeExitReason.DAILY_LOSS_BREACH
        assert trades[0].is_exiting

    async def test_the_high_water_mark_survives(self, session_factory):
        """A restart that forgot it would trail from the price at restart."""
        await an_account(session_factory)
        store = a_store(session_factory)
        await store.save_trade(a_trade().with_price_seen(rupees("133.75")), NOW)

        trades, _ = await store.load(CLIENT)
        assert trades[0].high_since_entry == rupees("133.75")


class TestArchiving:
    async def test_finished_trades_leave_the_working_set(self, session_factory):
        """The live tables are read whole at every start, so leaving finished
        trades in makes each start slower than the last."""
        await an_account(session_factory)
        store = a_store(session_factory)
        yesterday = NOW - timedelta(days=1)
        done = replace(
            a_trade("t-done").closed(rupees("110"), TradeExitReason.TARGET, yesterday),
            started_at=yesterday,
        )
        await store.save_trade(done, yesterday)
        await store.save_trade(a_trade("t-live"), NOW)

        assert await store.archive_finished(CLIENT, before=NOW) == 1
        trades, _ = await store.load(CLIENT)
        assert [t.id for t in trades] == [TradeId("t-live")]

    async def test_todays_finished_trades_stay_visible(self, session_factory):
        """An operator looking at the Console after the close should still see
        what closed today."""
        await an_account(session_factory)
        store = a_store(session_factory)
        done = a_trade("t-done").closed(rupees("110"), TradeExitReason.TARGET, NOW)
        await store.save_trade(done, NOW)

        assert await store.archive_finished(CLIENT, before=NOW) == 0
        trades, _ = await store.load(CLIENT)
        assert len(trades) == 1


class TestWhenStorageMisbehaves:
    async def test_a_write_that_fails_is_reported_not_raised(self, session_factory):
        """A position that cannot be persisted is still a position, and
        refusing to place its stop turns a database problem into a money one."""
        store = a_store(session_factory)
        # No such account, so the foreign key refuses the row.
        stray = replace(a_trade(), trading_client=TradingClientId("nobody"))
        assert await store.save_trade(stray, NOW) is False

    async def test_an_unreadable_row_does_not_hide_the_others(self, session_factory):
        """One corrupt trade must not cost the engine sight of every other
        position it holds."""
        from sqlalchemy import text

        await an_account(session_factory)
        store = a_store(session_factory)
        await store.save_trade(a_trade("t-good"), NOW)
        await store.save_trade(a_trade("t-bad"), NOW)
        async with UnitOfWork(session_factory) as uow:
            await uow.session.execute(
                text("update live_trades set payload = '{oh dear' where trade_id = 't-bad'")
            )

        trades, _ = await store.load(CLIENT)
        assert [t.id for t in trades] == [TradeId("t-good")]
