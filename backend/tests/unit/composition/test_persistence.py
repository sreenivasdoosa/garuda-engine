"""Mirroring a book into the database.

Two promises: a restart finds the positions it was holding, and a book that
has not changed is not rewritten every second.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal

import pytest

from garuda.alerts.manager import AlertManager
from garuda.composition.persistence import TradePersistence
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_signal import EntryRules, SignalType, TradeSignal
from garuda.domain.trade_state import TradeState
from garuda.trademgmt.client import TradingClientManager

from .conftest import APPA, NOW

STOCK = InstrumentId("NSE:RELIANCE")


@dataclass
class FakeStore:
    """A store that counts writes instead of making them."""

    trades: list[Trade] = field(default_factory=list)
    signals: list[TradeSignal] = field(default_factory=list)
    saved_trades: list[str] = field(default_factory=list)
    saved_signals: list[str] = field(default_factory=list)
    archived: int = 0

    async def load(
        self, trading_client: TradingClientId
    ) -> tuple[Sequence[Trade], Sequence[TradeSignal]]:
        return list(self.trades), list(self.signals)

    async def save_trade(self, trade: Trade, now: datetime) -> bool:
        self.saved_trades.append(trade.id.value)
        return True

    async def save_signal(self, signal: TradeSignal, now: datetime) -> bool:
        self.saved_signals.append(signal.id)
        return True

    async def archive_finished(self, trading_client: TradingClientId, before: datetime) -> int:
        self.archived += 1
        return 3


def signal(identity: str = "s1") -> TradeSignal:
    return TradeSignal(
        id=identity,
        trading_client=APPA,
        instrument=STOCK,
        strategy="breakout",
        signal_type=SignalType.LONG_ENTRY,
        product=ProductType.MIS,
        quantity=10,
        generated_at=NOW,
        entry=EntryRules(trigger=Money.of(Decimal("2500"), Currency.INR)),
    )


def held(book: TradingClientManager, identity: str) -> Trade:
    """The trade the book is holding. Absent means the test set itself up wrong."""
    found = book.trade(TradeId(identity))
    assert found is not None
    return found


def trade(identity: str = "t1", **overrides: object) -> Trade:
    defaults: dict[str, object] = {
        "id": TradeId(identity),
        "trading_client": APPA,
        "instrument": STOCK,
        "strategy": "breakout",
        "direction": Direction.LONG,
        "product": ProductType.MIS,
        "quantity": 10,
    }
    return Trade(**{**defaults, **overrides})  # type: ignore[arg-type]


@pytest.fixture
def alerts(clock: ReplayClock) -> AlertManager:
    async def sink(alert: Alert) -> None: ...

    return AlertManager(
        clock=clock,
        bus=InProcessEventBus(),
        trading_day_for=lambda now: NOW.date(),
        sink=sink,
    )


@pytest.fixture
def book(alerts: AlertManager, reliance: Instrument) -> TradingClientManager:
    return TradingClientManager(
        APPA, "Appa (zerodha:AB1234)", lambda i: reliance if i == STOCK else None, alerts
    )


@pytest.fixture
def store() -> FakeStore:
    return FakeStore()


@pytest.fixture
def keeper(book: TradingClientManager, store: FakeStore, clock: ReplayClock) -> TradePersistence:
    return TradePersistence(book, store, clock)  # type: ignore[arg-type]


async def test_a_restart_finds_the_positions_it_was_holding(
    keeper: TradePersistence, store: FakeStore, book: TradingClientManager
) -> None:
    store.trades = [
        trade(
            "t1",
            state=TradeState.ACTIVE,
            filled_quantity=10,
            entry=Money.of(Decimal("2400"), Currency.INR),
        )
    ]

    restored_trades, _ = await keeper.restore()

    assert restored_trades == 1
    assert book.trade(TradeId("t1")) is not None


async def test_what_was_just_read_is_not_written_straight_back(
    keeper: TradePersistence, store: FakeStore
) -> None:
    """Otherwise the first sweep after a restart rewrites the entire book."""
    store.trades = [
        trade(
            "t1",
            state=TradeState.ACTIVE,
            filled_quantity=10,
            entry=Money.of(Decimal("2400"), Currency.INR),
        )
    ]
    await keeper.restore()

    written = await keeper.flush()

    assert written == 0
    assert store.saved_trades == []


async def test_a_new_trade_is_written_once(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    book.add_trade(trade("t1"))

    first = await keeper.flush()
    second = await keeper.flush()

    assert first == 1
    assert second == 0
    assert store.saved_trades == ["t1"]


async def test_a_changed_trade_is_written_again(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    book.add_trade(trade("t1"))
    await keeper.flush()

    book.replace_trade(replace(held(book, "t1"), entry=Money.of(Decimal("2500"), Currency.INR)))
    await keeper.flush()

    assert store.saved_trades == ["t1", "t1"]


async def test_an_untouched_book_writes_nothing_however_often_it_is_swept(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    """A cycle a second must not be a write a second saying the same thing."""
    book.add_trade(trade("t1"))
    await keeper.flush()

    for _ in range(20):
        await keeper.flush()

    assert store.saved_trades == ["t1"]


async def test_several_trades_are_tracked_separately(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    book.add_trade(trade("t1"))
    book.add_trade(trade("t2"))
    await keeper.flush()
    store.saved_trades.clear()

    book.replace_trade(replace(held(book, "t2"), entry=Money.of(Decimal("2500"), Currency.INR)))
    await keeper.flush()

    assert store.saved_trades == ["t2"]


async def test_a_failing_sweep_does_not_stop_the_next_one(
    book: TradingClientManager, clock: ReplayClock, store: FakeStore
) -> None:
    """Trading continues whether or not the book reached disk."""
    failures = {"count": 0}

    async def explode(trade_to_save: Trade, now: datetime) -> bool:
        failures["count"] += 1
        raise RuntimeError("the database went away")

    store.save_trade = explode  # type: ignore[assignment]
    keeper = TradePersistence(book, store, clock)  # type: ignore[arg-type]
    book.add_trade(trade("t1"))

    with pytest.raises(RuntimeError):
        await keeper.flush()
    with pytest.raises(RuntimeError):
        await keeper.flush()

    assert failures["count"] == 2


async def test_archiving_moves_finished_trades_out_of_the_way(
    keeper: TradePersistence, store: FakeStore
) -> None:
    assert await keeper.archive() == 3
    assert store.archived == 1


async def test_stopping_ends_the_sweep(keeper: TradePersistence) -> None:
    running = asyncio.create_task(keeper.run_forever())
    await asyncio.sleep(0)

    keeper.stop()
    await asyncio.wait_for(running, timeout=1)

    assert running.done()


async def test_a_failed_sweep_is_retried_rather_than_ending_the_loop(
    book: TradingClientManager, clock: ReplayClock, store: FakeStore
) -> None:
    """A database blip must not silently stop the book being written out."""
    attempts = {"count": 0}

    async def sometimes(trade_to_save: Trade, now: datetime) -> bool:
        attempts["count"] += 1
        if attempts["count"] < 3:
            raise RuntimeError("the database went away")
        store.saved_trades.append(trade_to_save.id.value)
        return True

    store.save_trade = sometimes  # type: ignore[assignment]
    keeper = TradePersistence(book, store, clock)  # type: ignore[arg-type]
    book.add_trade(trade("t1"))

    running = asyncio.create_task(keeper.run_forever())
    while attempts["count"] < 3:
        await asyncio.sleep(0)
    keeper.stop()
    await asyncio.wait_for(running, timeout=1)

    assert attempts["count"] >= 3
    assert store.saved_trades == ["t1"]


async def test_a_new_signal_is_written_once(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    await book.add_signal(signal("s1"))

    first = await keeper.flush()
    second = await keeper.flush()

    assert first == 1
    assert second == 0
    assert store.saved_signals == ["s1"]


async def test_a_changed_signal_is_written_again(
    keeper: TradePersistence, book: TradingClientManager, store: FakeStore
) -> None:
    """A signal that has been triggered is not the signal that was stored."""
    await book.add_signal(signal("s1"))
    await keeper.flush()

    stored = book.signal("s1")
    assert stored is not None
    book.replace_signal(replace(stored, is_triggered=True))
    await keeper.flush()

    assert store.saved_signals == ["s1", "s1"]


async def test_a_restored_signal_is_not_written_straight_back(
    keeper: TradePersistence, store: FakeStore
) -> None:
    store.signals = [signal("s1")]
    await keeper.restore()

    assert await keeper.flush() == 0
    assert store.saved_signals == []
