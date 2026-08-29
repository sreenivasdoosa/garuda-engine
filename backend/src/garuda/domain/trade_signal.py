"""A trade signal: a strategy's request, waiting for a price.

A signal is not yet a trade. It carries everything needed to place one -- the
instrument, the size, the trigger, the levels it will be protected by -- and
sits until a tick crosses its trigger, at which point a trade is created from
it. Most signals in a day never trigger.

The reference engine's signal is a hundred fields on one class. The split here
follows the same grouping as the trade it becomes, and for the same reason:
the trigger rules, the protection levels and the leg relationships are
different kinds of thing with different rules.

Two fields carry the concurrency lessons. ``is_triggered`` and ``disabled``
were made ``volatile`` in the reference after a signal disabled on one thread
was executed by another reading a stale flag -- which fires the order twice.
Here there is one event loop and no such race, but both remain single points
of truth checked immediately before placing, never cached by a caller.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from garuda.domain.calendar import require_aware
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Money
from garuda.domain.trade import Protection, Relationships


class SignalType(StrEnum):
    """Which way a signal enters.

    Entries only. Exits do not travel as signals -- they name a trade by id,
    because an exit that has to be matched back to a position by symbol and
    direction exits the wrong one when two are open.
    """

    LONG_ENTRY = "LONG_ENTRY"
    SHORT_ENTRY = "SHORT_ENTRY"

    @property
    def direction(self) -> Direction:
        return Direction.LONG if self is SignalType.LONG_ENTRY else Direction.SHORT


class EscalationMode(StrEnum):
    """What to do about a limit entry that will not fill."""

    NONE = "NONE"
    #: Convert to market after a fixed wait.
    MARKET = "MARKET"
    #: Walk through configured steps -- a percentage buffer, a level of the
    #: book, the far touch -- before giving up.
    STEPPED = "STEPPED"


@dataclass(frozen=True, slots=True)
class EntryRules:
    """How the entry order is placed, and what happens if it does not fill."""

    #: The price at which the signal becomes a trade.
    trigger: Money | None = None
    #: For a stop-limit entry, the limit that accompanies the trigger.
    trigger_limit: Money | None = None
    place_market_order: bool = False
    #: Place the limit this far from the trigger, to make it fill.
    limit_buffer_percent: Decimal | None = None
    entry_with_stop_limit_order: bool = False
    escalation_mode: EscalationMode = EscalationMode.NONE
    escalation_seconds: int = 0
    #: The steps, as configured. Parsed where escalation runs, not here.
    escalation_steps: str | None = None
    cancel_unfilled_order_at: datetime | None = None
    #: Do not place before this, whatever the price does. Used to keep an
    #: entry out of the opening auction.
    not_before: datetime | None = None
    #: After this, the signal is stale and will not be acted on at all.
    valid_till: datetime | None = None
    #: Keep flipping between long and short as the market moves, cancelling
    #: and replacing the resting stop-limit entry.
    toggle_long_short: bool = False


@dataclass(frozen=True, slots=True)
class ReEntryRules:
    """Whether the same instrument may be entered again after a stop."""

    #: Total entries allowed for this instrument, counting reversals.
    max_entries: int = 1
    #: Enter the opposite way when the stop is hit, rather than the same way.
    consider_reverse: bool = False
    reverse_correlation_id: str | None = None
    #: How many have happened. 0 on a first signal.
    entries_so_far: int = 0

    @property
    def may_re_enter(self) -> bool:
        return self.entries_so_far < self.max_entries


@dataclass(frozen=True, slots=True)
class TradeSignal:
    """A strategy's request for a position, before it becomes one."""

    id: str
    trading_client: TradingClientId
    instrument: InstrumentId
    strategy: str
    signal_type: SignalType
    product: ProductType
    quantity: int
    generated_at: datetime

    quantity_per_lot: int = 1
    contract_multiplier: Decimal = Decimal(1)
    #: The instrument the *trigger* is watched on, when it differs from the one
    #: traded -- an option entry triggered by the future's price.
    trigger_instrument: InstrumentId | None = None

    entry: EntryRules = field(default_factory=EntryRules)
    protection: Protection = field(default_factory=Protection)
    relationships: Relationships = field(default_factory=Relationships)
    re_entry: ReEntryRules = field(default_factory=ReEntryRules)

    group: str = "DEFAULT"
    tranche: int = 0
    slice: int = 1
    is_paper: bool = False
    no_square_off: bool = False
    #: When the strategy wants the position out, whatever the price is doing.
    square_off_at: datetime | None = None
    #: The contract's expiry, for a derivative leg. Carried because it cannot
    #: be recovered later: a trading symbol has no day component, so nothing
    #: downstream can derive a real date from it.
    expiry: str | None = None
    #: How many legs the combo actually emitted -- what was sent, not what was
    #: planned, because a leg sized to zero is skipped and anything waiting for
    #: it would wait forever.
    combo_leg_count: int = 0
    remarks: str | None = None

    #: Triggered: a trade has been created from this. Checked immediately
    #: before placing, never cached.
    is_triggered: bool = False
    disabled: bool = False
    disabled_reason: str | None = None
    execution_attempts: int = 0
    last_error: str | None = None

    def __post_init__(self) -> None:
        require_aware(self.generated_at)
        if not self.id.strip():
            raise DomainError("a trade signal needs an id")
        if self.quantity < 1:
            raise DomainError(f"{self.id}: a signal for {self.quantity} units is not a signal")
        if self.contract_multiplier <= 0:
            raise DomainError(f"{self.id}: contract multiplier {self.contract_multiplier}")

    @property
    def direction(self) -> Direction:
        return self.signal_type.direction

    @property
    def watched_instrument(self) -> InstrumentId:
        """The instrument whose price decides whether this fires."""
        return self.trigger_instrument or self.instrument

    def is_actionable(self, now: datetime) -> bool:
        """Whether this may become a trade at this moment.

        Every reason not to act is checked in one place, so a caller cannot
        act on a signal by forgetting one of them.
        """
        if self.disabled or self.is_triggered:
            return False
        if self.entry.valid_till is not None and now > self.entry.valid_till:
            return False
        return not (self.entry.not_before is not None and now < self.entry.not_before)

    def has_expired(self, now: datetime) -> bool:
        return self.entry.valid_till is not None and now > self.entry.valid_till

    def triggered(self) -> TradeSignal:
        """Mark this as having produced a trade."""
        if self.is_triggered:
            raise DomainError(f"{self.id}: already triggered; it would place a second order")
        return replace(self, is_triggered=True)

    def disable(self, reason: str) -> TradeSignal:
        return replace(self, disabled=True, disabled_reason=reason)

    def attempted(self, error: str | None = None) -> TradeSignal:
        """Record an execution attempt that did not produce a trade."""
        return replace(self, execution_attempts=self.execution_attempts + 1, last_error=error)

    def __str__(self) -> str:
        return f"{self.instrument} {self.signal_type} x{self.quantity} [{self.strategy}]"
