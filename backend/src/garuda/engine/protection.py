"""Where a leg gets out, from what the strategy was configured with.

Configuration holds percentages; a trade needs prices. This converts one to
the other, and it is the piece whose absence meant every signal so far entered
at market with no stop at all.

**Which side a level sits on depends on the direction.** A sold option is
losing when its premium rises, so its stop is *above* the entry and its target
*below* it. A bought one is the other way round. Getting this backwards places
a stop that fills the instant it is sent, at a loss, and looks like a stop that
worked.

**Rounding is always away from the entry.** A stop rounded towards the entry is
tighter than the strategy asked for, and a target rounded towards it takes less
than the strategy asked for. Rounding away can only ever cost a fraction of a
tick, and never silently changes what was configured.
"""

from __future__ import annotations

from collections.abc import Callable
from decimal import ROUND_DOWN, ROUND_UP, Decimal

from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.intent import Intent
from garuda.domain.money import Money
from garuda.domain.trade import Protection
from garuda.engine.config import ResolvedConfig

HUNDRED = Decimal(100)


def protection_from(
    config: ResolvedConfig,
    *,
    direction: Direction,
    instrument: Instrument,
    entry: Money,
) -> Protection:
    """The levels one leg is protected by, given where it expects to enter."""
    if entry.amount <= 0:
        raise DomainError(f"{config.strategy}: cannot set levels against an entry price of {entry}")

    no_stop = config.flag("no_stop_loss")
    stop_percent = config.percent("sl_percentage")
    target_percent = config.percent("target_percentage")

    stop = (
        None
        if no_stop or stop_percent is None
        else _level(config, instrument, entry, stop_percent, direction, worsening=True)
    )
    target = (
        None
        if target_percent is None
        else _level(config, instrument, entry, target_percent, direction, worsening=False)
    )

    return Protection(
        stop_loss=stop,
        initial_stop_loss=stop,
        target=target,
        no_stop_loss=no_stop,
        no_target=target is None,
        is_trailing=config.flag("trail_sl"),
        trail_to_cost=config.flag("trail_sl_to_cost"),
        trigger_to_limit_gap_percent=config.percent("sl_trigger_to_limit_gap_percentage"),
    )


def _level(
    config: ResolvedConfig,
    instrument: Instrument,
    entry: Money,
    percent: Decimal,
    direction: Direction,
    *,
    worsening: bool,
) -> Money:
    """A price a given percentage away from the entry, on the right side.

    ``worsening`` is what separates a stop from a target: a stop sits where the
    position is losing, a target where it is winning. Which arithmetic that
    means depends on the direction, and this is the only place that decides it.
    """
    losing_is_up = direction is Direction.SHORT
    upwards = losing_is_up if worsening else not losing_is_up

    factor = (HUNDRED + percent) / HUNDRED if upwards else (HUNDRED - percent) / HUNDRED
    if factor <= 0:
        raise DomainError(
            f"{config.strategy}: a {percent}% "
            f"{'stop' if worsening else 'target'} on a {direction} position puts the level "
            f"at or below zero, which is not a price"
        )

    # Away from the entry: up rounds up, down rounds down.
    rounding = ROUND_UP if upwards else ROUND_DOWN
    return instrument.quantize_price(entry * factor, rounding=rounding)


def configured_protection(
    config: ResolvedConfig,
) -> Callable[[Intent, Instrument, Money], Protection]:
    """Bind one resolved configuration into a policy the signal factory takes.

    The direction comes from the leg rather than the configuration: one
    strategy sells a call and buys a hedge, and the same percentages mean
    opposite sides for the two.
    """

    def levels(intent: Intent, instrument: Instrument, entry: Money) -> Protection:
        return protection_from(
            config, direction=intent.direction, instrument=instrument, entry=entry
        )

    return levels
