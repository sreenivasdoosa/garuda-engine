"""What an evaluator is allowed to see.

Passed in, never fetched. An evaluator with no I/O is a pure function of its
context, which makes it testable without a broker or a feed and means two
evaluations of the same context cannot disagree about what the market was
doing.

The context also carries no way to place an order. Evaluators emit intents;
the engine sizes, risk-gates and routes them.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime

from garuda.domain.client import TradingClientId
from garuda.domain.enums import TradingMode
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import Intent
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.position import Position


@dataclass(frozen=True, slots=True)
class Subscription:
    """A strategy assigned to a trading client.

    ``mode`` is the reason paper and live can run side by side: it belongs to
    this pairing, not to the system and not to the client. The same strategy
    definition is paper here and live there, off the same signals.
    """

    strategy: str
    trading_client: TradingClientId
    mode: TradingMode
    capital: Money
    enabled: bool = True


@dataclass(frozen=True)
class EvaluationContext:
    """Everything an evaluator may read."""

    subscription: Subscription
    now: datetime
    #: Correlation id for whatever this evaluation produces, so an intent, its
    #: orders, its fills and its exit all carry the same thread.
    correlation_id: str
    quotes: Mapping[InstrumentId, Tick] = field(default_factory=dict)
    positions: Mapping[InstrumentId, Position] = field(default_factory=dict)

    def quote(self, instrument: InstrumentId) -> Tick | None:
        return self.quotes.get(instrument)

    def position(self, instrument: InstrumentId) -> Position | None:
        return self.positions.get(instrument)

    def has_open_position(self, instrument: InstrumentId) -> bool:
        position = self.positions.get(instrument)
        return position is not None and not position.is_flat


@dataclass(frozen=True)
class EvaluationResult:
    """What an evaluation produced, and why it produced nothing when it did."""

    intents: tuple[Intent, ...] = field(default_factory=tuple)
    #: Recorded with the evaluation so a quiet strategy can be explained
    #: without attaching a debugger at 09:20.
    stood_aside_because: str | None = None

    @property
    def acted(self) -> bool:
        return bool(self.intents)
