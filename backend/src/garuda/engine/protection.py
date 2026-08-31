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

import json
from collections.abc import Callable, Mapping
from decimal import ROUND_DOWN, ROUND_UP, Decimal, InvalidOperation

from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument
from garuda.domain.intent import Intent
from garuda.domain.money import Money
from garuda.domain.trade import Protection
from garuda.domain.trailing import GapUnit, TrailConfig, TrailingMode
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
        # Percentages, not prices. A group's level is a percentage of what
        # the group took in, which is unknown until every leg has filled --
        # see `trademgmt/combined_rules.py`. Each leg keeps its own stop as
        # well; whichever comes first.
        combined_stop_loss_percent=config.percent("combined_sl_percentage"),
        combined_target_percent=config.percent("combined_target_percentage"),
        is_trailing=config.flag("trail_sl"),
        trail=trail_from(config),
        trail_to_cost=config.flag("trail_sl_to_cost"),
        trigger_to_limit_gap_percent=config.percent("sl_trigger_to_limit_gap_percentage"),
    )


def trail_from(config: ResolvedConfig) -> TrailConfig | None:
    """How the stop follows the price, if it does.

    Two columns carry it, and they disagree about shape: `trail_sl_type`
    names the mode and `trail_config` is free JSON holding the gaps. The
    reference engine's Console writes both from a named policy in
    `trailing_sl_policy`, which is a template rather than a reference -- there
    is no key from a strategy to a policy, so what a strategy trails on is
    whatever was copied into its own row.

    None when trailing is off, so a leg marked as trailing without a mode is
    distinguishable from one not trailing at all.

    **A mode this engine cannot compute is kept, not dropped.** `TrailingMode`
    names every one the reference has, and the trailing pass refuses the ones
    needing candles by name. Falling back to the risk-multiple arithmetic
    would trail a position a way nobody configured.
    """
    if not config.flag("trail_sl"):
        return None

    mode = _trailing_mode(config)
    gaps = _trail_json(config)
    return TrailConfig(
        mode=mode,
        profit_gap=_gap(gaps, "profitGap", "profit_gap"),
        stop_move_gap=_gap(gaps, "slMoveGap", "stop_move_gap"),
        gap_unit=_gap_unit(gaps.get("trailMode") or gaps.get("gap_unit")),
        trail_to_cost_gap=_gap(gaps, "trailToCostGap", "trail_to_cost_gap"),
    )


def _trailing_mode(config: ResolvedConfig) -> TrailingMode:
    named = config.text("trail_sl_type")
    if named is None:
        return TrailingMode.RISK_MULTIPLE
    try:
        return TrailingMode(named.strip().upper())
    except ValueError:
        raise DomainError(
            f"{config.strategy}: trail_sl_type {named!r} is not a trailing mode; "
            f"expected one of {', '.join(sorted(m.value for m in TrailingMode))}"
        ) from None


def _trail_json(config: ResolvedConfig) -> Mapping[str, object]:
    """The gaps, from the free-text column the reference writes camelCase into.

    Unreadable JSON is refused rather than ignored. A strategy configured to
    trail with gaps the engine could not parse would trail on the defaults --
    which is a different strategy, silently.
    """
    raw = config.text("trail_config")
    if raw is None:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DomainError(
            f"{config.strategy}: trail_config is not readable JSON: {error}"
        ) from None
    if not isinstance(parsed, dict):
        raise DomainError(
            f"{config.strategy}: trail_config is {type(parsed).__name__}, not an object"
        )
    return parsed


def _gap(gaps: Mapping[str, object], *names: str) -> Decimal | None:
    """One gap, under whichever spelling the row used.

    The reference writes camelCase into this column; a row written by hand
    against garuda's own names should not be a silent no-op.
    """
    for name in names:
        value = gaps.get(name)
        if value is None:
            continue
        try:
            gap = Decimal(str(value))
        except InvalidOperation:
            raise DomainError(f"trail_config {name}={value!r} is not a number") from None
        if gap <= 0:
            raise DomainError(f"trail_config {name}={value!r} must be above zero to be a gap")
        return gap
    return None


def _gap_unit(named: object) -> GapUnit:
    """What the gaps are in. Absolute unless the row says otherwise.

    The reference spells this `trailMode` and writes it lower case.
    """
    if named is None:
        return GapUnit.ABSOLUTE
    try:
        return GapUnit(str(named).strip().upper())
    except ValueError:
        raise DomainError(
            f"trail_config trailMode {named!r} is not a gap unit; "
            f"expected one of {', '.join(sorted(u.value for u in GapUnit))}"
        ) from None


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
