"""Loading the kill switches an operator set.

Against a real PostgreSQL because what is loaded is a query with four
conditions on it -- active, not removed, today, source not switched off -- and
each one is a way for a stop to silently not apply.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.composition.risk import load_kill_switches
from garuda.domain.client import TradingClientId
from garuda.domain.enums import InstrumentKind, Segment
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.persistence import UnitOfWork
from garuda.persistence.models import KillSwitchesRow, KillSwitchTypesRow, TradingClientRow
from garuda.rms.killswitch import MANUAL

pytestmark = pytest.mark.integration

type Sessions = async_sessionmaker[AsyncSession]

TODAY = date(2026, 9, 1)
YESTERDAY = date(2026, 8, 31)
T0 = datetime(2026, 9, 1, 10, 15, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")


@pytest.fixture
async def client(session_factory: Sessions) -> TradingClientId:
    async with UnitOfWork(session_factory) as uow:
        uow.repositories.trading_clients.add(
            TradingClientRow(
                id=CLIENT.value,
                display_name="Appa",
                broker="ZERODHA",
                client_id="AB1234",
                enabled=True,
                created_at=T0,
                updated_at=T0,
            )
        )
    return CLIENT


@pytest.fixture
def option(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NFO:NIFTY26SEP25000CE"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.EQUITY,
        trading_symbol="NIFTY26SEP25000CE",
        lot_size=75,
        tick_size=Decimal("0.05"),
    )


async def given(session_factory: Sessions, **fields: object) -> None:
    row = KillSwitchesRow(
        created_date=fields.pop("created_date", TODAY),
        key_name=str(fields.pop("key_name", "GLOBAL")),
        level=str(fields.pop("level", "GLOBAL")),
        active=bool(fields.pop("active", True)),
        source=str(fields.pop("source", MANUAL)),
        created_at=T0,
        updated_at=T0,
        **fields,
    )
    async with UnitOfWork(session_factory) as uow:
        uow.session.add(row)


async def test_a_switch_set_today_is_in_force(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    await given(session_factory, reason="market-wide halt")

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is not None


async def test_yesterdays_switch_does_not_stop_today(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """A stop is a decision about a session. One left behind from a bad
    Tuesday must not still be stopping Wednesday."""
    await given(session_factory, created_date=YESTERDAY, reason="yesterday was bad")

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is None


async def test_a_removed_switch_does_not_stop_anything(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """Removing is a timestamp rather than a delete, so the record of what was
    stopped survives the day it applied to."""
    await given(session_factory, reason="lifted at ten", removed_at=T0)

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is None


async def test_an_inactive_switch_does_not_stop_anything(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    await given(session_factory, active=False, reason="stood down")

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is None


async def test_a_switch_from_a_disabled_source_does_not_apply(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """What makes them typed: a class of switch can be turned off without
    losing the switches."""
    await given(session_factory, source="VOLATILITY", reason="the index gapped")
    async with UnitOfWork(session_factory) as uow:
        uow.session.add(KillSwitchTypesRow(source="VOLATILITY", enabled=False, updated_at=T0))

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is None


async def test_a_switch_from_an_enabled_source_still_applies(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    await given(session_factory, source="VOLATILITY", reason="the index gapped")
    async with UnitOfWork(session_factory) as uow:
        uow.session.add(KillSwitchTypesRow(source="VOLATILITY", enabled=True, updated_at=T0))

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is not None


async def test_a_source_nobody_configured_is_enabled(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """A missing row is not a disabled one. An operator's own switch must not
    need a type row to exist before it stops anything."""
    await given(session_factory, source="SOMETHING_NEW", reason="stop")

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is not None


async def test_an_account_scoped_switch_reaches_only_that_account(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    await given(
        session_factory,
        key_name=f"CLIENT|{CLIENT.value}",
        level="CLIENT",
        trading_client_id=CLIENT.value,
        reason="this account only",
    )

    switch = await load_kill_switches(session_factory, today=TODAY)

    assert switch.reason_for(option, client) is not None
    assert switch.reason_for(option, TradingClientId("someone-else")) is None


async def test_nothing_set_is_the_ordinary_state(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    switch = await load_kill_switches(session_factory, today=TODAY)

    assert not switch.is_active
    assert switch.reason_for(option, client) is None
