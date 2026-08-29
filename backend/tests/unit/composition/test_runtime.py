"""Starting a built engine.

The two seams worth testing here carry money: which account's entry service
sees a tick, and which account's book an order update lands in.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal

from garuda.brokers.sessions import Account
from garuda.composition.engine import Engine
from garuda.composition.runtime import _fan_out_ticks, route_updates
from garuda.domain import Currency, Money, OrderStatus, Side
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId
from garuda.domain.session import BrokerSession
from garuda.protocols.account import OrderUpdate
from garuda.protocols.topics import Topic

from .conftest import AMMA, APPA, NOW, EngineBuilder, account, session

STOCK = InstrumentId("NSE:RELIANCE")


def tick(price: str = "2500") -> Tick:
    return Tick(
        instrument=STOCK,
        last_price=Money.of(Decimal(price), Currency.INR),
        timestamp=NOW,
    )


def order_update(broker_client_id: str) -> OrderUpdate:
    return OrderUpdate(
        broker_order_id=BrokerOrderId("250831000001"),
        broker_client_id=broker_client_id,
        client_order_id=None,
        instrument=STOCK,
        side=Side.BUY,
        quantity=10,
        filled_quantity=10,
        status=OrderStatus.FILLED,
    )


@dataclass
class Spy:
    """Stands in for an entry service or a tracker."""

    seen: list[object] = field(default_factory=list)
    explode: bool = False

    async def on_tick(self, value: Tick) -> list[object]:
        if self.explode:
            raise RuntimeError("this strategy is broken")
        self.seen.append(value)
        return []

    async def on_order_update(self, value: OrderUpdate) -> None:
        self.seen.append(value)


def engine_with(
    build_with: EngineBuilder,
    accounts: list[Account],
    sessions_by_client: dict[TradingClientId, BrokerSession],
) -> tuple[Engine, dict[TradingClientId, tuple[Spy, Spy]]]:
    """An engine whose entry services and trackers are replaced by spies."""
    engine = build_with(accounts, sessions_by_client)
    spies: dict[TradingClientId, tuple[Spy, Spy]] = {}
    for client_id, client in engine.parts.clients.items():
        entry, tracker = Spy(), Spy()
        object.__setattr__(client, "entry", entry)
        object.__setattr__(client, "tracker", tracker)
        spies[client_id] = (entry, tracker)
    return engine, spies


# -- ticks ------------------------------------------------------------------


async def test_every_account_sees_the_same_tick(build_with: EngineBuilder) -> None:
    engine, spies = engine_with(
        build_with,
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )
    task = asyncio.create_task(_fan_out_ticks(engine))
    await asyncio.sleep(0)

    await engine.parts.bus.publish(Topic.TICKS, tick())
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    task.cancel()

    assert spies[APPA][0].seen == spies[AMMA][0].seen
    assert len(spies[APPA][0].seen) == 1


async def test_one_broken_strategy_does_not_cost_the_other_accounts(
    build_with: EngineBuilder,
) -> None:
    engine, spies = engine_with(
        build_with,
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )
    spies[APPA][0].explode = True
    task = asyncio.create_task(_fan_out_ticks(engine))
    await asyncio.sleep(0)

    await engine.parts.bus.publish(Topic.TICKS, tick())
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    task.cancel()

    assert len(spies[AMMA][0].seen) == 1


async def test_something_that_is_not_a_tick_is_ignored(build_with: EngineBuilder) -> None:
    engine, spies = engine_with(build_with, [account(APPA, "AB1234")], {APPA: session("AB1234")})
    task = asyncio.create_task(_fan_out_ticks(engine))
    await asyncio.sleep(0)

    await engine.parts.bus.publish(Topic.TICKS, "not a tick")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    task.cancel()

    assert spies[APPA][0].seen == []


# -- order updates ----------------------------------------------------------


async def test_an_update_lands_in_the_book_that_owns_the_order(build_with: EngineBuilder) -> None:
    """Routed by the client id on the payload, not by whose socket it arrived on.

    A dealer session carries several accounts; routing by the socket's owner
    applies one account's fills to another.
    """
    engine, spies = engine_with(
        build_with,
        [account(APPA, "AB1234"), account(AMMA, "CD5678")],
        {APPA: session("AB1234"), AMMA: session("CD5678")},
    )
    handle = route_updates(engine)

    await handle(order_update("CD5678"), AMMA)

    assert spies[AMMA][1].seen != []
    assert spies[APPA][1].seen == []


async def test_an_update_for_an_account_that_is_not_trading_is_dropped(
    build_with: EngineBuilder,
) -> None:
    engine, spies = engine_with(build_with, [account(APPA, "AB1234")], {APPA: session("AB1234")})
    handle = route_updates(engine)

    await handle(order_update("CD5678"), AMMA)

    assert spies[APPA][1].seen == []


async def test_an_event_that_is_not_an_order_update_is_ignored(build_with: EngineBuilder) -> None:
    engine, spies = engine_with(build_with, [account(APPA, "AB1234")], {APPA: session("AB1234")})
    handle = route_updates(engine)

    await handle("not an update", APPA)  # type: ignore[arg-type]

    assert spies[APPA][1].seen == []
