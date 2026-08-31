"""A trade: one position, from the signal that asked for it to the exit.

The reference engine's trade carries about a hundred and fifty fields on one
class. They are not all the same kind of thing, and grouping them is what makes
the state machine readable: identity and size sit here, while protection
levels, leg relationships, escalation and corporate-action history are each
their own value with their own rules.

Quantities are in *units*, not lots, and every money calculation multiplies by
the contract multiplier. A commodity contract is a hundred grams or a hundred
barrels, and P&L that forgets it is wrong by two orders of magnitude -- which
looks plausible enough on a screen to be acted on.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime
from decimal import Decimal

from garuda.domain.calendar import require_aware
from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.money import Money
from garuda.domain.trade_state import (
    CANCELLING_REASONS,
    TRADE_TRANSITIONS,
    TradeExitReason,
    TradeState,
    more_urgent,
)
from garuda.domain.trailing import TrailConfig


class IllegalTradeTransitionError(DomainError):
    """A trade was asked to become something it cannot be."""


@dataclass(frozen=True, slots=True)
class TradeId:
    value: str

    def __post_init__(self) -> None:
        if not self.value or self.value.strip() != self.value:
            raise DomainError(f"trade id {self.value!r} is empty or padded")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class Protection:
    """Where a trade gets out, and whether those levels move.

    The combined levels belong to a group rather than to this leg: a straddle
    is stopped on what the two legs are worth together, and stopping each leg
    on its own premium exits the winning side of a position that is net fine.
    They are carried as percentages because the price they mean cannot be
    known until every leg has filled -- see `trademgmt/combined_rules.py`.
    """

    stop_loss: Money | None = None
    initial_stop_loss: Money | None = None
    target: Money | None = None
    #: The group's levels, as percentages of what the group took in. Kept as
    #: percentages rather than prices because the level cannot be a price
    #: until every leg has filled, and kept on the leg rather than looked up
    #: from configuration because the leg is what survives a restart -- and
    #: because the day conditions that resolved them are known at signal time
    #: and gone by the time a tick arrives.
    combined_stop_loss_percent: Decimal | None = None
    combined_target_percent: Decimal | None = None
    #: The strategy asked for no protective order at all. Distinct from having
    #: one that has not been placed yet.
    no_stop_loss: bool = False
    no_target: bool = False
    #: Track the level without sending an order. The engine exits at market
    #: when the level is crossed instead.
    dont_place_stop_loss_order: bool = False
    is_trailing: bool = False
    #: How the stop follows the price, when it does. Carried on the leg for
    #: the same reason the combined percentages are: it is resolved when the
    #: signal is built, with the day conditions in hand, and a restart that
    #: forgot it would leave a position marked as trailing with nothing
    #: telling it how far.
    trail: TrailConfig | None = None
    trail_to_cost: bool = False
    #: How far a stop-loss limit sits from its trigger, when the strategy
    #: overrides the venue default.
    trigger_to_limit_gap_percent: Decimal | None = None

    def moved_to(self, stop_loss: Money) -> Protection:
        """A trailing move. The initial level is never overwritten."""
        return replace(
            self,
            stop_loss=stop_loss,
            initial_stop_loss=self.initial_stop_loss or self.stop_loss,
        )

    @property
    def has_moved(self) -> bool:
        """Whether the stop has been trailed away from where it started.

        This is what tells a stop that fired at its original level from one
        that fired after trailing -- two different outcomes an operator reads
        differently, and the reference engine distinguished by stamping the
        exit reason ahead of time.
        """
        return (
            self.initial_stop_loss is not None
            and self.stop_loss is not None
            and self.stop_loss != self.initial_stop_loss
        )


@dataclass(frozen=True, slots=True)
class Relationships:
    """Which other legs this one is bound to, and how.

    Three different bindings, because they answer different questions. A hedge
    correlation binds a main leg to the one protecting it. A pair correlation
    binds the two sides of an option pair. A combo id binds everything entered
    together, whatever its instrument or product -- a cash leg and a futures
    leg have neither a hedge relationship nor an option pair, yet are one
    position that must be sized, risked and exited as a unit.
    """

    combo_id: str | None = None
    hedge_correlation_id: str | None = None
    hedge_trade_id: TradeId | None = None
    pair_correlation_id: str | None = None
    leg_role: LegRole | None = None
    #: Lower goes first, and a leg is not placed until every lower-sequence leg
    #: in its group has filled.
    entry_sequence: int = 0
    #: How far out the hedge sits, as a percentage of the underlying.
    hedge_distance_percent: Decimal | None = None
    #: Set on a hedge whose main leg never made it in. A durable marker, so the
    #: orphan is squared off on every sweep and after a restart, rather than
    #: depending on the main signal still being in memory.
    main_entry_failed: bool = False
    #: On a signal, the hedge this one replaces. Its presence is what makes a
    #: signal a hedge *replacement* rather than a hedge entry, and replacements
    #: are deliberately allowed back into a slot a live hedge already occupies
    #: -- that is the whole point of rolling one.
    hedge_trade_id_to_square_off: TradeId | None = None

    @property
    def is_hedge(self) -> bool:
        return self.leg_role is LegRole.HEDGE


@dataclass(frozen=True, slots=True)
class CorporateActionState:
    """What a split or bonus did to a held position.

    The originals are written once, on the first adjustment, and never again:
    they are what the trade looked like before any action, and a second write
    would compound the adjustment into itself. ``factor`` accumulates across
    actions, so a two-for-one followed by a three-for-one is six.
    """

    original_entry: Money | None = None
    original_quantity: int | None = None
    original_filled_quantity: int | None = None
    factor: Decimal = Decimal(1)
    applied_action_ids: tuple[int, ...] = ()

    @property
    def was_adjusted(self) -> bool:
        return bool(self.applied_action_ids)

    def has_applied(self, action_id: int) -> bool:
        return action_id in self.applied_action_ids


@dataclass(frozen=True, slots=True)
class ExitAttempts:
    """How hard the engine has already tried to get out.

    Both caps exist because without them a square-off that cannot fill places
    orders forever. They count different things: placements are fresh exit
    orders, and repricing an order already resting is not one.
    """

    square_off_attempts: int = 0
    exit_placement_attempts: int = 0
    last_attempt_at: datetime | None = None
    #: An operator asking again resets the placement budget: the documented
    #: recovery is to wait for the broker and retry by hand.
    stop_loss_order_attempts: int = 0
    target_order_attempts: int = 0


@dataclass(frozen=True, slots=True)
class Trade:
    """One position, and everything that has happened to it."""

    id: TradeId
    trading_client: TradingClientId
    instrument: InstrumentId
    strategy: str
    direction: Direction
    product: ProductType
    #: What was asked for, in units.
    quantity: int
    #: Units per lot, and units per contract. A commodity lot is a hundred
    #: barrels; P&L that assumes one is wrong by that factor.
    quantity_per_lot: int = 1
    contract_multiplier: Decimal = Decimal(1)

    state: TradeState = TradeState.OPEN
    filled_quantity: int = 0
    entry: Money | None = None
    exit: Money | None = None
    exit_reason: TradeExitReason | None = None
    #: Why this trade is on its way out, while it still holds a position. Set
    #: when a square-off is initiated and before it fills -- a window that can
    #: last minutes on an illiquid strike. Anything choosing between legs has
    #: to know: a hedge whose replacement is already placed is not the
    #: operative hedge, even though it is still live.
    exiting_for: TradeExitReason | None = None
    #: Why the entry failed, in the words the operator needs: the risk gate's
    #: rejection, the broker's message, or an internal failure. A trade that
    #: failed at entry often has no usable order to inspect.
    failure_reason: str | None = None

    started_at: datetime | None = None
    ended_at: datetime | None = None

    protection: Protection = field(default_factory=Protection)
    relationships: Relationships = field(default_factory=Relationships)
    corporate_actions: CorporateActionState = field(default_factory=CorporateActionState)
    attempts: ExitAttempts = field(default_factory=ExitAttempts)

    #: The signal this came from. Kept by id rather than by value: the signal
    #: is stored once in its own right, and holding a copy here means two
    #: records of one thing that drift.
    signal_id: str | None = None
    group: str = "DEFAULT"
    tranche: int = 0
    #: Which slice of a freeze-limit split this is, one-based. More than one
    #: only when the entry exceeded the venue's freeze quantity.
    slice: int = 1
    #: 0 for the first entry; 1, 2, 3 for re-entries after a stop.
    re_entry_count: int = 0
    #: The best and worst the market has been since entry. Kept on the trade
    #: rather than in memory because trailing measures from them, and a
    #: restart that forgot them would trail from the price at restart --
    #: giving back everything the position had already earned.
    high_since_entry: Money | None = None
    low_since_entry: Money | None = None
    #: Routed to the paper broker rather than the real one. A property of the
    #: subscription, so the same strategy runs paper on one account and live on
    #: another at once.
    is_paper: bool = False
    #: Exempt from automatic square-off. A carry-forward position the
    #: strategy manages itself.
    no_square_off: bool = False
    #: When the strategy wants this out regardless of where the price is.
    #: The venue has its own cut-off for intraday products; whichever comes
    #: first wins, because the later one can no longer be acted on.
    square_off_at: datetime | None = None
    remarks: str | None = None

    def __post_init__(self) -> None:
        if self.quantity < 1:
            raise DomainError(f"{self.id}: a trade for {self.quantity} units is not a trade")
        if self.filled_quantity < 0 or self.filled_quantity > self.quantity:
            raise DomainError(
                f"{self.id}: filled {self.filled_quantity} of {self.quantity} ordered"
            )
        if self.contract_multiplier <= 0:
            raise DomainError(f"{self.id}: contract multiplier {self.contract_multiplier}")
        for moment in (self.started_at, self.ended_at):
            if moment is not None:
                require_aware(moment)
        if self.state is TradeState.ACTIVE and self.entry is None:
            raise DomainError(f"{self.id}: active with no entry price")
        if self.state.is_terminal and self.exit_reason is None:
            raise DomainError(f"{self.id}: {self.state} without a reason")

    # -- reading ------------------------------------------------------------

    @property
    def is_open(self) -> bool:
        return self.state is TradeState.OPEN

    @property
    def is_active(self) -> bool:
        return self.state is TradeState.ACTIVE

    @property
    def is_terminal(self) -> bool:
        return self.state.is_terminal

    @property
    def is_live(self) -> bool:
        """Placed and not finished, whether or not anything has filled."""
        return self.state.is_live

    @property
    def is_exiting(self) -> bool:
        """A square-off is in flight but has not completed."""
        return self.exiting_for is not None and not self.is_terminal

    @property
    def open_quantity(self) -> int:
        """Units still held. Zero once the position is out."""
        if self.state is TradeState.COMPLETED or self.state is TradeState.CANCELLED:
            return 0
        return self.filled_quantity

    @property
    def value_per_unit_move(self) -> Decimal:
        """What one point of price movement is worth across the position."""
        return Decimal(self.filled_quantity) * self.contract_multiplier

    def pnl_at(self, price: Money) -> Money | None:
        """Profit or loss if the position closed here.

        None before anything filled: a trade with no entry has no P&L, and
        answering zero would let it into a total as though it were flat.
        """
        if self.entry is None or self.filled_quantity == 0:
            return None
        move = price - self.entry
        return Money(
            move.amount * self.value_per_unit_move * Decimal(self.direction.sign),
            price.currency,
        )

    @property
    def realised_pnl(self) -> Money | None:
        """P&L of a closed position, before charges."""
        if self.exit is None:
            return None
        return self.pnl_at(self.exit)

    # -- transitions --------------------------------------------------------

    def can_become(self, state: TradeState) -> bool:
        return state in TRADE_TRANSITIONS[self.state]

    def _become(self, state: TradeState, **changes: object) -> Trade:
        if not self.can_become(state):
            raise IllegalTradeTransitionError(f"{self.id}: {self.state} cannot become {state}")
        return replace(self, state=state, **changes)  # type: ignore[arg-type]

    def with_entry_fill(self, quantity: int, price: Money, at: datetime) -> Trade:
        """Fold an entry execution in, moving to ACTIVE on the first one.

        The average is weighted across fills and never rounded per fill --
        rounding each one compounds the error across a sliced entry, and a
        sliced entry is the normal case above a freeze limit.
        """
        require_aware(at)
        if quantity < 1:
            raise DomainError(f"{self.id}: an entry fill of {quantity} units")
        if self.is_terminal:
            raise IllegalTradeTransitionError(f"{self.id}: filled after it was {self.state}")

        filled = self.filled_quantity + quantity
        if filled > self.quantity:
            raise DomainError(
                f"{self.id}: filling {quantity} takes the total to {filled}, "
                f"above the {self.quantity} ordered"
            )

        if self.entry is None:
            average = price
        else:
            total = self.entry.amount * self.filled_quantity + price.amount * quantity
            average = Money(total / Decimal(filled), price.currency)

        if self.state is TradeState.OPEN:
            return self._become(
                TradeState.ACTIVE,
                filled_quantity=filled,
                entry=average,
                started_at=self.started_at or at,
            )
        return replace(self, filled_quantity=filled, entry=average)

    def exiting(self, reason: TradeExitReason) -> Trade:
        """Mark a square-off as under way, keeping the more urgent reason.

        A trade already leaving for one reason can be asked again for another
        -- an end-of-day sweep catching a position a stop is already working
        on. The more urgent wins, so a daily-loss breach is never downgraded.
        """
        if self.is_terminal:
            raise IllegalTradeTransitionError(f"{self.id}: already {self.state}")
        if self.exiting_for is None:
            return replace(self, exiting_for=reason)
        return replace(self, exiting_for=more_urgent(self.exiting_for, reason))

    def closed(self, price: Money, reason: TradeExitReason, at: datetime) -> Trade:
        """The position is out."""
        require_aware(at)
        return self._become(TradeState.COMPLETED, exit=price, exit_reason=reason, ended_at=at)

    def cancelled(
        self, reason: TradeExitReason, at: datetime, failure_reason: str | None = None
    ) -> Trade:
        """It never became a position."""
        require_aware(at)
        if self.filled_quantity > 0:
            # Something executed, so there is a position, and a position is
            # closed rather than cancelled. Recording it as cancelled loses a
            # real execution from the day's P&L.
            raise IllegalTradeTransitionError(
                f"{self.id}: cannot cancel with {self.filled_quantity} units filled"
            )
        return self._become(
            TradeState.CANCELLED,
            exit_reason=reason,
            ended_at=at,
            failure_reason=failure_reason or self.failure_reason,
        )

    def ended(self, reason: TradeExitReason, at: datetime, price: Money | None = None) -> Trade:
        """End the trade the way the reason implies.

        Entry-failure reasons cancel; everything else closes. Callers reach for
        this when the reason is what they have and the state is what they would
        otherwise have to work out.
        """
        if reason in CANCELLING_REASONS and self.filled_quantity == 0:
            return self.cancelled(reason, at)
        if price is None:
            raise DomainError(f"{self.id}: closing on {reason} needs an exit price")
        return self.closed(price, reason, at)

    def with_price_seen(self, price: Money) -> Trade:
        """Record a price the market traded at while this position was open."""
        high = self.high_since_entry
        low = self.low_since_entry
        return replace(
            self,
            high_since_entry=price if high is None or price > high else high,
            low_since_entry=price if low is None or price < low else low,
        )

    def __str__(self) -> str:
        return f"{self.instrument} {self.direction} x{self.quantity} [{self.strategy}]"
