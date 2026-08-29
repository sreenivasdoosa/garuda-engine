"""Shared builders for the trade management tests."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from garuda.alerts.manager import AlertManager
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money, OptionType, ProductType
from garuda.domain.alert import Alert
from garuda.domain.client import TradingClientId
from garuda.domain.enums import InstrumentKind
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.trade import Relationships, Trade, TradeId
from garuda.domain.trade_signal import EntryRules, SignalType, TradeSignal
from garuda.trademgmt.dedup import InstrumentLookup

TODAY = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
YESTERDAY = datetime(2026, 8, 28, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")
LABEL = "Appa (zerodha:AB1234)"

NIFTY = InstrumentId("NSE:NIFTY")
CALL = InstrumentId("NFO:NIFTY26AUG25000CE")
FAR_CALL = InstrumentId("NFO:NIFTY26AUG25500CE")
PUT = InstrumentId("NFO:NIFTY26AUG25000PE")
STOCK = InstrumentId("NSE:RELIANCE")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def option(
    instrument_id: InstrumentId, option_type: OptionType, nse: Exchange, strike: str
) -> Instrument:
    from garuda.domain.enums import ExerciseStyle, Segment, SettlementType

    return Instrument(
        id=instrument_id,
        exchange=nse,
        trading_symbol=instrument_id.value.split(":")[1],
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=TODAY.date(),
        strike=Decimal(strike),
        option_type=option_type,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


@pytest.fixture
def instruments(nse: Exchange, reliance: Instrument) -> InstrumentLookup:
    catalogue = {
        CALL: option(CALL, OptionType.CALL, nse, "25000"),
        FAR_CALL: option(FAR_CALL, OptionType.CALL, nse, "25500"),
        PUT: option(PUT, OptionType.PUT, nse, "25000"),
        STOCK: reliance,
    }
    return catalogue.get


@pytest.fixture
def alerts() -> AlertManager:
    async def sink(alert: Alert) -> None: ...

    return AlertManager(
        clock=ReplayClock(TODAY),
        bus=InProcessEventBus(),
        trading_day_for=lambda now: TODAY.date(),
        sink=sink,
    )


def a_signal(
    signal_id: str = "sig-1",
    *,
    instrument: InstrumentId = CALL,
    strategy: str = "straddle",
    group: str = "DEFAULT",
    tranche: int = 0,
    slice_: int = 1,
    quantity: int = 75,
    signal_type: SignalType = SignalType.SHORT_ENTRY,
    generated_at: datetime = TODAY,
    relationships: Relationships | None = None,
    triggered: bool = False,
    disabled: bool = False,
) -> TradeSignal:
    return TradeSignal(
        id=signal_id,
        trading_client=CLIENT,
        instrument=instrument,
        strategy=strategy,
        signal_type=signal_type,
        product=ProductType.NRML,
        quantity=quantity,
        generated_at=generated_at,
        group=group,
        tranche=tranche,
        slice=slice_,
        entry=EntryRules(trigger=rupees("120")),
        relationships=relationships or Relationships(),
        is_triggered=triggered,
        disabled=disabled,
    )


def a_trade(
    trade_id: str = "t-1",
    *,
    instrument: InstrumentId = CALL,
    strategy: str = "straddle",
    group: str = "DEFAULT",
    direction: Direction = Direction.SHORT,
    quantity: int = 75,
    signal_id: str | None = "sig-1",
    relationships: Relationships | None = None,
    started_at: datetime | None = TODAY,
) -> Trade:
    return Trade(
        id=TradeId(trade_id),
        trading_client=CLIENT,
        instrument=instrument,
        strategy=strategy,
        direction=direction,
        product=ProductType.NRML,
        quantity=quantity,
        group=group,
        signal_id=signal_id,
        relationships=relationships or Relationships(),
        started_at=started_at,
    )


def hedge_of(correlation: str, *, role: LegRole, sequence: int = 0) -> Relationships:
    return Relationships(hedge_correlation_id=correlation, leg_role=role, entry_sequence=sequence)
