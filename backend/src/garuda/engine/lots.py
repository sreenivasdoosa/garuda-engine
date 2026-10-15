"""How many lots a tranche trades.

The reference engine's `calculateAllocatedLots` and `SequentialLotAllocator`,
ported as they stand (`STRATEGY_ENGINE.md` §4 step 5). Integer arithmetic
throughout, because a lot is a whole thing and every division here rounds
down -- rounding up would put on a position the capital does not fund.

    total lots   = capital ÷ capital-per-lot (hedged or naked)
                   x day-allocation %   (floor)
                   x event-day %        (floor)
    tranche lots = the sequential allocator's share for this tranche

The sequential allocator fills whole copies of the configured base pattern
first, then hands the remainder out from tranche 1 onward. With base lots
``[2, 1, 1]`` and eleven lots to spend: two full sets give ``[4, 2, 2]``,
the three left over go ``2`` to tranche 1 and ``1`` to tranche 2, and the
answer is ``[6, 3, 2]``.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal

from garuda.domain.errors import DomainError
from garuda.engine.daycondition import DayCondition

FULL = 100


def sequential_allocation(base_lots: Sequence[int], total_lots: int) -> list[int]:
    """Spread ``total_lots`` across tranches in the proportions of ``base_lots``.

    The reference's `SequentialLotAllocator.allocateLots`, line for line.
    """
    if not base_lots:
        return []
    if total_lots <= 0:
        return [0] * len(base_lots)
    if any(base < 0 for base in base_lots):
        raise DomainError(f"base lots {list(base_lots)} include a negative tranche")
    total_base = sum(base_lots)
    if total_base <= 0:
        # Nothing configured to proportion by: an even split, the remainder
        # to the earliest tranches.
        per, remainder = divmod(total_lots, len(base_lots))
        return [per + (1 if index < remainder else 0) for index in range(len(base_lots))]

    full_sets, remaining = divmod(total_lots, total_base)
    allocation = [base * full_sets for base in base_lots]
    for index, base in enumerate(base_lots):
        if remaining <= 0:
            break
        given = min(base, remaining)
        allocation[index] += given
        remaining -= given
    return allocation


@dataclass(frozen=True, slots=True)
class LotDecision:
    """How many lots, and in words how that was arrived at."""

    lots: int
    because: str
    #: Risk this allocation spends from today's budget, when sized by risk.
    risk_used: Decimal = Decimal(0)

    @property
    def tradable(self) -> bool:
        return self.lots > 0


@dataclass(frozen=True, slots=True)
class LotInputs:
    """What the calculation reads, gathered so the arithmetic stays pure."""

    tranche: int
    #: The tranches the day's lots are spread across, in order: every tranche
    #: with a row of its own, extended to `max_tranches`. Empty when neither
    #: is configured, which is the reference's "fixed lots" case.
    allocation_tranches: Sequence[int]
    #: Each allocation tranche's configured `lots_per_tranch`, same order.
    base_lots: Sequence[int]
    #: This tranche's own configured lots: what trades when nothing is
    #: capital-based.
    configured_lots: int
    capital: int | None
    capital_per_lot: int | None
    day_percentage: int = FULL
    event_day_percentage: int = FULL
    adaptive: bool = False


def allocated_lots(inputs: LotInputs) -> LotDecision:
    """The reference's `calculateAllocatedLots`, in its order."""
    tranche = inputs.tranche
    if not inputs.allocation_tranches and not inputs.adaptive:
        return LotDecision(
            inputs.configured_lots,
            f"{inputs.configured_lots} lot(s) as configured: no tranche rows and no "
            "max tranches, so nothing to spread capital across",
        )
    capital = inputs.capital or 0
    per_lot = inputs.capital_per_lot or 0
    if capital <= 0 or per_lot <= 0:
        return LotDecision(
            inputs.configured_lots,
            f"{inputs.configured_lots} lot(s) as configured: no capital per lot to size from",
        )

    total = capital // per_lot
    if total <= 0:
        return LotDecision(0, f"capital {capital} affords no lot at {per_lot} a lot")
    steps = [f"{capital} ÷ {per_lot} = {total} lot(s)"]

    total, step = _scaled(total, inputs.day_percentage, "day allocation")
    if step:
        steps.append(step)
    if total <= 0:
        return LotDecision(0, "; ".join(steps))
    total, step = _scaled(total, inputs.event_day_percentage, "event day")
    if step:
        steps.append(step)
    if total <= 0:
        return LotDecision(0, "; ".join(steps))

    if inputs.adaptive:
        # The reference's adaptive mode: each tranche trades everything, because
        # only one is ever on at a time.
        return LotDecision(total, "; ".join([*steps, "adaptive: every lot to this tranche"]))

    order = list(inputs.allocation_tranches)
    if tranche not in order:
        return LotDecision(
            0, "; ".join([*steps, f"tranche {tranche} is outside the allocation {order}"])
        )
    shares = sequential_allocation(inputs.base_lots, total)
    lots = shares[order.index(tranche)]
    steps.append(f"tranche {tranche} gets {lots} of {total} by base lots {list(inputs.base_lots)}")
    return LotDecision(lots, "; ".join(steps))


def _scaled(total: int, percentage: int, what: str) -> tuple[int, str | None]:
    if percentage < 0 or percentage > FULL:
        raise DomainError(f"a {what} percentage of {percentage} is not between 0 and 100")
    if percentage == FULL:
        return total, None
    if percentage == 0:
        return 0, f"{what} is 0% today"
    scaled = (total * percentage) // FULL
    return scaled, f"{what} {percentage}% leaves {scaled}"


@dataclass(frozen=True, slots=True)
class DayAllocation:
    """A strategy's share of its lots on each kind of day, as percentages."""

    monday: int = FULL
    tuesday: int = FULL
    wednesday: int = FULL
    thursday: int = FULL
    friday: int = FULL
    expiry_day: int = FULL
    dt1_day: int = FULL
    dt2_day: int = FULL

    def percentage_for(self, conditions: frozenset[DayCondition]) -> int:
        """Expiry beats DT1 beats DT2 beats the weekday: the reference's order."""
        if DayCondition.EXPIRY in conditions:
            return self.expiry_day
        if DayCondition.ONE_DAY_TO_EXPIRY in conditions:
            return self.dt1_day
        if DayCondition.TWO_DAYS_TO_EXPIRY in conditions:
            return self.dt2_day
        for condition, share in (
            (DayCondition.MONDAY, self.monday),
            (DayCondition.TUESDAY, self.tuesday),
            (DayCondition.WEDNESDAY, self.wednesday),
            (DayCondition.THURSDAY, self.thursday),
            (DayCondition.FRIDAY, self.friday),
        ):
            if condition in conditions:
                return share
        return FULL


FULL_SIZE_EVERY_DAY = DayAllocation()


@dataclass(frozen=True, slots=True)
class RiskDecision:
    """A risk-aware allocation, and the risk it spends from today's budget."""

    lots: int
    risk_used: Decimal
    because: str


def risk_aware_lots(
    *,
    cap_lots: int,
    budget: Decimal,
    used: Decimal,
    firing_index: int,
    total_tranches: int,
    risk_per_lot: Decimal,
) -> RiskDecision:
    """The reference's `RiskAwareSequentialLotAllocator`: today's remaining
    risk budget split evenly over the tranches still to fire, this tranche
    taking at most its share -- and at least one lot when one lot fits the
    whole remaining budget -- never above ``cap_lots``."""
    remaining = budget - used
    left = total_tranches - firing_index + 1
    if remaining <= 0 or left <= 0:
        return RiskDecision(0, Decimal(0), f"risk budget {budget} spent ({used} used)")
    if risk_per_lot <= 0:
        return RiskDecision(cap_lots, Decimal(0), "no risk per lot to size by")
    share = remaining / left
    risk_lots = int(share // risk_per_lot)
    if risk_lots == 0 and risk_per_lot <= remaining:
        risk_lots = 1
    lots = max(0, min(cap_lots, risk_lots))
    used_now = risk_per_lot * lots
    limit = "risk" if risk_lots < cap_lots else "margin"
    return RiskDecision(
        lots,
        used_now,
        f"{limit}-constrained: {lots} lot(s) at {risk_per_lot} risk a lot, "
        f"{remaining} of {budget} left over {left} tranche(s)",
    )
