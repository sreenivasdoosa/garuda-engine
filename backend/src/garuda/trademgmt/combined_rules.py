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

from garuda.domain.money import Money
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeExitReason

HUNDRED = Decimal(100)

#: What a leg's price counts for. A short took its premium in, a long paid it
#: out, and the net is the difference.
type PriceOf = Callable[[Trade], Money | None]


@dataclass(frozen=True, slots=True)
class GroupLevels:
    """How far a group may go, as percentages of what it took in."""

    stop_loss_percent: Decimal | None = None
    target_percent: Decimal | None = None

    @property
    def is_configured(self) -> bool:
        return self.stop_loss_percent is not None or self.target_percent is not None

    @classmethod
    def of(cls, trade: Trade) -> GroupLevels:
        """What one leg says its group comes out on.

        Read from a leg rather than from configuration because the leg is what
        survives a restart, and because the day conditions that resolved these
        percentages are known when the signal is built and gone by the time a
        tick arrives.
        """
        return cls(
            stop_loss_percent=trade.protection.combined_stop_loss_percent,
            target_percent=trade.protection.combined_target_percent,
        )


class CombinedOutcome(StrEnum):
    """What the group's own arithmetic says to do."""

    HOLD = "HOLD"
    STOP = "STOP"
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

    @property
    def is_exit(self) -> bool:
        return self.outcome in (CombinedOutcome.STOP, CombinedOutcome.TARGET)

    @property
    def exit_reason(self) -> TradeExitReason | None:
        if self.outcome is CombinedOutcome.STOP:
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


def evaluate(
    trades: Sequence[Trade],
    levels: GroupLevels,
    *,
    entry_of: PriceOf,
    current_of: PriceOf,
) -> CombinedDecision:
    """Whether the group has reached a level of its own.

    The stop is checked before the target. Both can be true only if a level is
    configured at zero or the two overlap, and in that case coming out on the
    stop is the answer that cannot be regretted.
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

    if stop is not None and result <= -stop:
        return CombinedDecision(
            CombinedOutcome.STOP,
            f"the group is down {-result} against {basis} taken in, past the {stop} allowed",
            entry=entry,
            current=current,
            result=result,
        )
    if target is not None and result >= target:
        return CombinedDecision(
            CombinedOutcome.TARGET,
            f"the group is up {result} against {basis} taken in, at the {target} wanted",
            entry=entry,
            current=current,
            result=result,
        )
    return CombinedDecision(
        CombinedOutcome.HOLD,
        f"the group is at {result} against {basis} taken in",
        entry=entry,
        current=current,
        result=result,
    )


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
