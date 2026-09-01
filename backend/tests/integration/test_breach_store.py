"""The breach log against a real PostgreSQL.

Worth testing against the database rather than in memory because the point of
the table is what an operator can ask it afterwards: how often a breach type
fired, and how short the measurement was each time. That is a query, and a
query is only as good as the columns the write filled in.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.domain.enums import InstrumentKind, Segment
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.persistence import UnitOfWork
from garuda.persistence.breach_store import ORDER_REJECTED, BreachStore
from garuda.persistence.models import RmsBreachLogRow, TradingClientRow
from garuda.rms.breaches import BreachFamily, BreachType
from garuda.rms.gate import Breach

type Sessions = async_sessionmaker[AsyncSession]

pytestmark = pytest.mark.integration

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


async def rows(session_factory: Sessions) -> list[RmsBreachLogRow]:
    async with UnitOfWork(session_factory) as uow:
        found = await uow.session.execute(select(RmsBreachLogRow).order_by(RmsBreachLogRow.id))
        return list(found.scalars())


async def test_a_refusal_becomes_a_row(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    store = BreachStore(session_factory, label="Appa")

    written = await store.record(
        [Breach(BreachType.VOLUME_LOW, "volume 480 is below 10000", current="480", limit="10000")],
        trading_client=client,
        instrument=option,
        strategy="straddle",
        at=T0,
    )

    assert written == 1
    (row,) = await rows(session_factory)
    assert row.breach_type == BreachType.VOLUME_LOW.value
    assert row.breach_category == BreachFamily.LIQUIDITY.value
    assert row.trading_symbol == "NIFTY26SEP25000CE"
    assert row.exchange == "NSE"
    assert row.strategy_name == "straddle"
    assert row.action_taken == ORDER_REJECTED


async def test_what_was_measured_is_kept_apart_from_the_sentence(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """ "Every volume breach under five hundred" is a question the detail
    cannot answer."""
    store = BreachStore(session_factory, label="Appa")

    await store.record(
        [Breach(BreachType.VOLUME_LOW, "volume 480 is below 10000", current="480", limit="10000")],
        trading_client=client,
        instrument=option,
        strategy=None,
        at=T0,
    )

    (row,) = await rows(session_factory)
    assert row.current_value == "480"
    assert row.limit_value == "10000"


async def test_severity_is_recorded_so_a_day_can_be_ranked(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """The reference's own grading: a kill switch is a 5 and a wide spread a
    2, and an operator reading a hundred rows needs the five first."""
    store = BreachStore(session_factory, label="Appa")

    await store.record(
        [
            Breach(BreachType.KILL_SWITCH_ACTIVE, "operator halted trading"),
            Breach(BreachType.SPREAD_WIDE, "spread is 4% of the price"),
            Breach(BreachType.MARKET_CLOSED, "NSE is closed"),
        ],
        trading_client=client,
        instrument=option,
        strategy=None,
        at=T0,
    )

    written = await rows(session_factory)
    assert [row.severity for row in written] == [5, 2, 1]


async def test_a_refusal_with_several_reasons_is_several_rows(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    """ "The spread was wide and the volume was thin" is two facts, and one row
    holding both could not be counted by type."""
    store = BreachStore(session_factory, label="Appa")

    written = await store.record(
        [
            Breach(BreachType.SPREAD_WIDE, "spread is 4% of the price"),
            Breach(BreachType.VOLUME_LOW, "volume 480 is below 10000"),
        ],
        trading_client=client,
        instrument=option,
        strategy=None,
        at=T0,
    )

    assert written == 2
    assert {row.breach_type for row in await rows(session_factory)} == {
        BreachType.SPREAD_WIDE.value,
        BreachType.VOLUME_LOW.value,
    }


async def test_nothing_refused_opens_nothing(client: TradingClientId, option: Instrument) -> None:
    """Not merely writes nothing: the session factory is never reached,
    because there is nothing to put in a transaction. Asserted by counting
    rather than by raising -- this store swallows everything by design, so an
    assertion failing inside it would be caught and reported as zero written,
    which is exactly what a passing test looks like."""

    class Counting:
        def __init__(self) -> None:
            self.opened = 0

        def __call__(self, *args: object, **kwargs: object) -> object:
            self.opened += 1
            raise RuntimeError("no session here")

    sessions = Counting()
    store = BreachStore(sessions, label="Appa")  # type: ignore[arg-type]

    written = await store.record([], trading_client=client, instrument=option, strategy=None, at=T0)

    assert written == 0
    assert sessions.opened == 0


async def test_a_store_that_cannot_write_never_raises(
    client: TradingClientId, option: Instrument
) -> None:
    """The order was already refused and nothing left the engine. A store that
    is down costs the audit trail rather than the refusal."""

    class Broken:
        def __call__(self, *args: object, **kwargs: object) -> object:
            raise RuntimeError("the database is gone")

    store = BreachStore(Broken(), label="Appa")  # type: ignore[arg-type]

    written = await store.record(
        [Breach(BreachType.VOLUME_LOW, "volume 480 is below 10000")],
        trading_client=client,
        instrument=option,
        strategy=None,
        at=T0,
    )

    assert written == 0


async def test_the_breach_can_be_read_back_for_the_client(
    session_factory: Sessions, client: TradingClientId, option: Instrument
) -> None:
    store = BreachStore(session_factory, label="Appa")
    await store.record(
        [Breach(BreachType.VOLUME_LOW, "volume 480 is below 10000")],
        trading_client=client,
        instrument=option,
        strategy=None,
        at=T0,
    )

    async with UnitOfWork(session_factory) as uow:
        found = await uow.repositories.rms_breach_log.for_client(CLIENT.value)

    assert len(found) == 1
