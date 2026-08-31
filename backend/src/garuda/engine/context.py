"""What an evaluator is allowed to see.

Passed in, never fetched. An evaluator with no I/O is a pure function of its
context, which makes it testable without a broker or a feed and means two
evaluations of the same context cannot disagree about what the market was
doing.

The context also carries no way to place an order. Evaluators emit intents;
the engine sizes, risk-gates and routes them.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.enums import ExpiryKind, OptionType, TradingMode
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

    def spot(self, underlying: InstrumentId) -> Money | None:
        """Selection methods, so a leg selector can be handed this context.

        This context belongs to the phase-one slice, which resolves fixed
        instruments and the underlying itself. It knows nothing of chains or
        expiries, so an option selector handed this one finds nothing and the
        evaluator stands the entry down -- which is the right answer, and is
        why these return None rather than raising.
        """
        quote = self.quote(underlying)
        return quote.last_price if quote is not None else None

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        del underlying
        return None

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        del underlying, kind
        return None

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        del underlying, expiry, strike, option_type
        return None

    def future(self, underlying: InstrumentId, expiry: date) -> InstrumentId | None:
        del underlying, expiry
        return None

    def strikes(self, underlying: InstrumentId, expiry: date) -> Sequence[Decimal]:
        del underlying, expiry
        return ()

    def premium(self, instrument: InstrumentId) -> Money | None:
        quote = self.quote(instrument)
        return quote.last_price if quote is not None else None

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
