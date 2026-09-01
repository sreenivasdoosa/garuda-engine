"""Where a group of legs gets out, taken together.

A straddle is not two positions with two stops. Stopping each leg on its own
premium exits the winning side of a position that is net perfectly fine, which
is the whole reason a combined level exists.

**The measure is the group's net premium** — what it took in less what it paid
out, each leg weighted by its size:

    net = sum over legs of  price * quantity * (+1 short, -1 long)

A short call at 150 and a short put at 120, equal size, is 270 taken in. The
same sum at current prices is what closing costs now, and the difference is the
group's result. A 10% stop on that group is 27: out when closing would cost
297. A 10% target is the mirror, out at 243.

**Written as a result against a basis, not as a signed multiple.** A debit
group has a negative net, and scaling that by 1.1 moves the level the wrong
way: a spread bought for 100 would be "stopped" the instant it was opened.
Comparing the result to a percentage of `abs(net)` is right for both, and is
the only arithmetic here that is not obvious.

**Hedges count.** A bought hedge reduces the net premium and moves both
levels. It matters when the hedge sits near the sold strike and is negligible
when it is far out, which is an argument for always including it rather than
for a rule about when to.

**Quantities are weighted in, not assumed equal.** The worked example above is
in premium points because a straddle's legs are the same size. A hedge at half
the ratio is not, and points would silently misweight it, as would a leg on a
commodity contract, where one lot is a hundred barrels.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum

from garuda.domain.errors import DomainError
from garuda.domain.money import Money
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.domain.trailing import GapUnit

HUNDRED = Decimal(100)

#: What a leg's price counts for. A short took its premium in, a long paid it
#: out, and the net is the difference.
type PriceOf = Callable[[Trade], Money | None]


@dataclass(frozen=True, slots=True)
class GroupLevels:
    """How far a group may go, as percentages of what it took in."""

    stop_loss_percent: Decimal | None = None
    target_percent: Decimal | None = None
    #: How much profit earns one step of trailing, and how far the group's
    #: stop moves per step. Both needed, and useless without a stop to move:
    #: the trail starts from the fixed level and walks it up.
    trail_profit_gap: Decimal | None = None
    trail_stop_move_gap: Decimal | None = None
    #: What those two are in. Per cent of the group's premium by default,
    #: which is the reference engine's default for the combined trail -- and
    #: the opposite of the per-leg trail, where a gap is in points unless said
    #: otherwise.
    trail_unit: GapUnit = GapUnit.PERCENTAGE

    def __post_init__(self) -> None:
        if self.trail_unit is GapUnit.RISK_MULTIPLE:
            # A multiple of the initial risk is a per-leg idea: it measures
            # from entry to that leg's first stop, and a group has neither.
            raise DomainError(
                "a combined trail is in per cent of the group's premium or in money, "
                "not in multiples of risk"
            )
        for name, gap in (
            ("trail_profit_gap", self.trail_profit_gap),
            ("trail_stop_move_gap", self.trail_stop_move_gap),
        ):
            if gap is not None and gap <= 0:
                raise DomainError(f"a combined trail's {name} of {gap} is not a gap")

    @property
    def is_configured(self) -> bool:
        return self.stop_loss_percent is not None or self.target_percent is not None

    @property
    def is_trailing(self) -> bool:
        """Whether the group's stop moves as the group earns.

        All three are needed. A profit gap with no move gap never moves the
        stop, and either without a fixed stop has nothing to move -- the trail
        walks the configured level up rather than inventing one.
        """
        return (
            self.trail_profit_gap is not None
            and self.trail_stop_move_gap is not None
            and self.stop_loss_percent is not None
        )

    @classmethod
    def of(cls, trade: Trade) -> GroupLevels:
        """What one leg says its group comes out on.

        Read from a leg rather than from configuration because the leg is what
        survives a restart, and because the day conditions that resolved these
        percentages are known when the signal is built and gone by the time a
        tick arrives.
        """
        protection = trade.protection
        return cls(
            stop_loss_percent=protection.combined_stop_loss_percent,
            target_percent=protection.combined_target_percent,
            trail_profit_gap=protection.combined_trail_profit_gap,
            trail_stop_move_gap=protection.combined_trail_stop_move_gap,
            trail_unit=protection.combined_trail_unit or GapUnit.PERCENTAGE,
        )


class CombinedOutcome(StrEnum):
    """What the group's own arithmetic says to do."""

    HOLD = "HOLD"
    STOP = "STOP"
    #: Stopped at a level the group's own profit moved, rather than at the one
    #: it was configured with. The same exit; a different thing to have
    #: happened, and an operator reads the two differently.
    TRAIL_STOP = "TRAIL_STOP"
    TARGET = "TARGET"
    #: The arithmetic could not be done: a leg has no price, or the group took
    #: in nothing to measure against. Distinct from HOLD on purpose: one is an
    #: answer and the other is the absence of one, and an operator reading
    #: "held all day" needs to know which it was.
    UNAVAILABLE = "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class CombinedDecision:
    """The arithmetic, kept whole so a log line can explain itself."""

    outcome: CombinedOutcome
    detail: str
    entry: Money | None = None
    current: Money | None = None
    #: Entry less current: positive is profit, in premium terms.
    result: Money | None = None

    #: The best the group has been, for a trail to measure down from. Carried
    #: out of the decision so the caller can put it back on the legs: a
    #: restart that forgot it would trail from wherever the group stands now,
    #: giving back everything it had earned.
    high_water: Money | None = None

    @property
    def is_exit(self) -> bool:
        return self.exit_reason is not None

    @property
    def exit_reason(self) -> TradeExitReason | None:
        if self.outcome in (CombinedOutcome.STOP, CombinedOutcome.TRAIL_STOP):
            return TradeExitReason.GROUP_STOP_LOSS
        if self.outcome is CombinedOutcome.TARGET:
            return TradeExitReason.GROUP_TARGET
        return None


def levels_of(trades: Sequence[Trade]) -> GroupLevels | None:
    """The levels the group as a whole comes out on.

    Not simply the first leg's. The book indexes trades by set, so "the first
    leg" is whichever one iteration happened to yield — and a hedge added
    without combined percentages would then turn the group's stop off on some
    ticks and not others.

    Legs that carry no combined levels are ignored: a hedge configured without
    them still belongs to the group. Legs that carry *different* ones are a
    real misconfiguration, and None says so rather than picking a winner.
    """
    configured = {levels for trade in trades if (levels := GroupLevels.of(trade)).is_configured}
    if not configured:
        return GroupLevels()
    if len(configured) > 1:
        return None
    return configured.pop()


def net_premium(trades: Sequence[Trade], price_of: PriceOf) -> Money | None:
    """The group's premium at the given prices, positive for a credit.

    None when any leg's price is unknown. Fail closed rather than leaving a leg
    out: a straddle valued on one side is not a smaller straddle, it is a
    number that would trip a stop.
    """
    total: Money | None = None
    for trade in trades:
        price = price_of(trade)
        if price is None:
            return None
        # A short's sign is -1 and a short takes premium in, so the sense is
        # inverted here. Getting this backwards inverts every level.
        leg = price * trade.value_per_unit_move * Decimal(-trade.direction.sign)
        total = leg if total is None else total + leg
    return total


def trailing_floor(basis: Money, levels: GroupLevels, high_water: Money) -> Money | None:
    """The least the group will now accept, given the best it has been.

    None until the first step is earned, which is what makes this a trail
    rather than a second stop: below one profit gap the configured level
    stands as it was.

    The level walks up from the configured stop, one move gap per whole
    profit gap earned. Whole steps, so the level does not jitter with every
    tick -- a stop that drifts on noise is one that fires on noise.
    """
    profit_gap = _in_money(basis, levels.trail_profit_gap, levels.trail_unit)
    move_gap = _in_money(basis, levels.trail_stop_move_gap, levels.trail_unit)
    configured = _threshold(basis, levels.stop_loss_percent)
    if profit_gap is None or move_gap is None or configured is None:
        # The three `is_trailing` asks for, checked here rather than through
        # it: leading with `if not levels.is_trailing` would read better and
        # say the same thing twice, since this has to narrow the types anyway.
        return None

    if high_water < profit_gap:
        return None
    steps = int(high_water.amount / profit_gap.amount)
    return move_gap * steps - configured


def _in_money(basis: Money, gap: Decimal | None, unit: GapUnit) -> Money | None:
    """A configured gap as an amount, whichever way it was written."""
    if gap is None:
        return None
    if unit is GapUnit.PERCENTAGE:
        return basis * (gap / HUNDRED)
    return Money(gap, basis.currency)


def evaluate(
    trades: Sequence[Trade],
    levels: GroupLevels,
    *,
    entry_of: PriceOf,
    current_of: PriceOf,
    high_water: Money | None = None,
) -> CombinedDecision:
    """Whether the group has reached a level of its own.

    Checked in the order the reference engine checks them, and the order
    matters: the configured stop first, then the trailed one, then the target.
    A group past its fixed stop is out on that, whatever the trail says, and a
    group that has given back its gains is out on the trail rather than left
    to run to a target it is walking away from.

    ``high_water`` is the best the group has been so far, and the decision
    carries the updated one back. It is not held here: a rule that kept state
    between evaluations would lose it on a restart, which is the one moment a
    trail must not forget.
    """
    if not levels.is_configured:
        return CombinedDecision(CombinedOutcome.HOLD, "no combined level is configured")
    if not trades:
        return CombinedDecision(CombinedOutcome.HOLD, "the group holds nothing")

    entry = net_premium(trades, entry_of)
    if entry is None:
        return CombinedDecision(
            CombinedOutcome.UNAVAILABLE, "a leg has not filled, so the group has no entry premium"
        )

    basis = abs(entry)
    if basis.is_zero:
        # Perfectly offsetting legs. A percentage of nothing is nothing, and
        # exiting on it would exit at once, every time.
        return CombinedDecision(
            CombinedOutcome.UNAVAILABLE,
            "the group's legs offset exactly, so a percentage has nothing to measure",
            entry=entry,
        )

    current = net_premium(trades, current_of)
    if current is None:
        return CombinedDecision(
            CombinedOutcome.UNAVAILABLE,
            "a leg has no price, so the group cannot be valued",
            entry=entry,
        )

    result = entry - current
    stop = _threshold(basis, levels.stop_loss_percent)
    target = _threshold(basis, levels.target_percent)
    best = _best(result, high_water, levels)

    def decided(outcome: CombinedOutcome, detail: str) -> CombinedDecision:
        return CombinedDecision(
            outcome,
            detail,
            entry=entry,
            current=current,
            result=result,
            high_water=best,
        )

    if stop is not None and result <= -stop:
        return decided(
            CombinedOutcome.STOP,
            f"the group is down {-result} against {basis} taken in, past the {stop} allowed",
        )

    floor = trailing_floor(basis, levels, best) if best is not None else None
    if floor is not None and result <= floor:
        return decided(
            CombinedOutcome.TRAIL_STOP,
            f"the group is at {result} against {basis} taken in, at or below the {floor} its "
            f"own best of {best} has moved the stop to",
        )

    if target is not None and result >= target:
        return decided(
            CombinedOutcome.TARGET,
            f"the group is up {result} against {basis} taken in, at the {target} wanted",
        )
    return decided(CombinedOutcome.HOLD, f"the group is at {result} against {basis} taken in")


def _best(result: Money, high_water: Money | None, levels: GroupLevels) -> Money | None:
    """The best the group has been, floored at nothing.

    A group that has only ever been in loss has earned no step, which is what
    the reference means by starting the watermark at zero rather than at the
    first reading. The floor is the default: nothing ever stores a negative
    one, because this is where it would have to come from.
    """
    if not levels.is_trailing:
        return None
    return max(result, high_water if high_water is not None else Money.zero(result.currency))


def _threshold(basis: Money, percent: Decimal | None) -> Money | None:
    return None if percent is None else basis * (percent / HUNDRED)


def combinable(trade: Trade) -> bool:
    """Whether a leg is part of what the group's level is measured on.

    A leg on its way out is not: its exit is already decided, and counting it
    would measure a position that is being dismantled.

    A leg that has not filled yet *is*, deliberately. It has no entry price,
    so the group comes back UNAVAILABLE rather than being valued on the legs
    that did fill — a straddle with one side still resting is not a one-legged
    straddle, and reading it as one is how a combined stop fires on half a
    position.
    """
    return trade.is_live and not trade.is_exiting
