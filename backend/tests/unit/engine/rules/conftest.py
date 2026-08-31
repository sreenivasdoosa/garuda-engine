"""Builders for the rule tests.

A fake context and a handful of rules that answer whatever a test needs. None
of the real rules are used here: these tests are about the machinery.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.trade import Trade
from garuda.engine.config import ResolvedConfig
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome, failed, passed, unavailable

NOW = datetime(2026, 8, 31, 10, 30, tzinfo=UTC)
TODAY = NOW.date()
CLIENT = TradingClientId("appa")
UNDERLYING = InstrumentId("NSE:NIFTY")


@dataclass
class FakeContext:
    """A context that answers from dictionaries."""

    now: datetime = NOW
    trading_day: date = TODAY
    strategy: str = "straddle"
    trading_client: TradingClientId = CLIENT
    tranche: int = 0
    config: ResolvedConfig = field(default_factory=lambda: ResolvedConfig(strategy="straddle"))
    underlying: InstrumentId = UNDERLYING
    trade: Trade | None = None

    quotes: dict[InstrumentId, Tick] = field(default_factory=dict)
    bars: dict[tuple[InstrumentId, BarInterval], list[Bar]] = field(default_factory=dict)
    indicators: dict[str, Decimal] = field(default_factory=dict)
    held: list[Trade] = field(default_factory=list)
    #: What was asked for, so a test can prove laziness.
    asked: list[str] = field(default_factory=list)

    def quote(self, instrument: InstrumentId) -> Tick | None:
        self.asked.append(f"quote:{instrument.value}")
        return self.quotes.get(instrument)

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        self.asked.append(f"candles:{instrument.value}:{interval.value}")
        return self.bars.get((instrument, interval), [])[-count:]

    def indicator(
        self, name: str, instrument: InstrumentId, interval: BarInterval, **params: object
    ) -> Decimal | None:
        self.asked.append(f"indicator:{name}")
        return self.indicators.get(name)

    def positions(self) -> Sequence[Trade]:
        return list(self.held)


@dataclass(frozen=True)
class Always:
    """Passes, and records that it ran."""

    ran: list[str] = field(default_factory=list)
    label: str = "always"

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        self.ran.append(self.label)
        return passed(f"{self.label} passes")


@dataclass(frozen=True)
class Never:
    ran: list[str] = field(default_factory=list)
    label: str = "never"

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        self.ran.append(self.label)
        return failed(f"{self.label} does not hold")


@dataclass(frozen=True)
class Unreadable:
    ran: list[str] = field(default_factory=list)
    label: str = "unreadable"

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        self.ran.append(self.label)
        return unavailable(f"{self.label} has no data")


@dataclass(frozen=True)
class Explodes:
    error: type[Exception] = RuntimeError

    def evaluate(self, context: RuleContext) -> RuleOutcome:
        raise self.error("this rule is broken")


@pytest.fixture
def context() -> FakeContext:
    return FakeContext()
