"""Shared venue fixtures.

Three venues, chosen because each breaks a different naive assumption:

* **NSE** — the ordinary case, one daytime session.
* **MCX** — an evening session running past 23:00 IST, which breaks "a trading
  day ends in the afternoon".
* **CME** — a session opening the previous calendar evening in Chicago, which
  breaks "the trading day is the calendar date", and observes US daylight
  saving, which breaks "the session is always the same number of hours".
"""

from __future__ import annotations

from datetime import date, time
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.domain import (
    Currency,
    Exchange,
    ExerciseStyle,
    Instrument,
    InstrumentId,
    InstrumentKind,
    OptionType,
    Segment,
    Session,
    SettlementCycle,
    SettlementType,
    TradingCalendar,
)

IST = ZoneInfo("Asia/Kolkata")
CHICAGO = ZoneInfo("America/Chicago")

WEEKDAYS = range(5)  # Monday..Friday

#: Republic Day 2026 falls on a Monday — a weekday holiday, not a weekend.
NSE_HOLIDAY = date(2026, 1, 26)
#: Diwali muhurat: a one-hour evening session on a day that is otherwise closed.
MUHURAT_DAY = date(2026, 11, 8)


@pytest.fixture(scope="session")
def nse_calendar() -> TradingCalendar:
    return TradingCalendar(
        name="NSE",
        timezone=IST,
        weekly={d: (Session(time(9, 15), time(15, 30)),) for d in WEEKDAYS},
        holidays=frozenset({NSE_HOLIDAY, MUHURAT_DAY}),
        special_sessions={MUHURAT_DAY: (Session(time(18, 15), time(19, 15)),)},
    )


@pytest.fixture(scope="session")
def mcx_calendar() -> TradingCalendar:
    return TradingCalendar(
        name="MCX",
        timezone=IST,
        weekly={d: (Session(time(9, 0), time(23, 30)),) for d in WEEKDAYS},
    )


@pytest.fixture(scope="session")
def cme_calendar() -> TradingCalendar:
    """Each trading day opens 17:00 the previous calendar evening in Chicago."""
    return TradingCalendar(
        name="CME",
        timezone=CHICAGO,
        weekly={d: (Session(time(17, 0), time(16, 0), opens_previous_day=True),) for d in WEEKDAYS},
    )


@pytest.fixture(scope="session")
def nse(nse_calendar: TradingCalendar) -> Exchange:
    return Exchange(
        code="NSE",
        name="National Stock Exchange of India",
        currency=Currency.INR,
        calendar=nse_calendar,
        settlement=SettlementCycle.T1,
        segments=frozenset({Segment.EQUITY, Segment.FNO}),
    )


@pytest.fixture(scope="session")
def mcx(mcx_calendar: TradingCalendar) -> Exchange:
    return Exchange(
        code="MCX",
        name="Multi Commodity Exchange",
        currency=Currency.INR,
        calendar=mcx_calendar,
        settlement=SettlementCycle.T1,
        segments=frozenset({Segment.COMMODITY}),
    )


@pytest.fixture(scope="session")
def cme(cme_calendar: TradingCalendar) -> Exchange:
    return Exchange(
        code="CME",
        name="Chicago Mercantile Exchange",
        currency=Currency.USD,
        calendar=cme_calendar,
        settlement=SettlementCycle.T1,
        segments=frozenset({Segment.FNO}),
    )


# Instruments are frozen and never mutated, so one per session is safe -- and
# session scope is what lets Hypothesis reuse them across generated inputs.
@pytest.fixture(scope="session")
def nifty_index(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NSE:NIFTY"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.INDEX,
        trading_symbol="NIFTY 50",
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


@pytest.fixture(scope="session")
def nifty_call(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NSE:NIFTY26AUG25000CE"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol="NIFTY26AUG25000CE",
        lot_size=75,
        tick_size=Decimal("0.05"),
        freeze_quantity=1800,
        underlying=InstrumentId("NSE:NIFTY"),
        expiry=date(2026, 8, 27),
        strike=Decimal(25000),
        option_type=OptionType.CALL,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


@pytest.fixture(scope="session")
def reliance(nse: Exchange) -> Instrument:
    return Instrument(
        id=InstrumentId("NSE:RELIANCE"),
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.EQUITY,
        trading_symbol="RELIANCE",
        lot_size=1,
        tick_size=Decimal("0.05"),
    )
