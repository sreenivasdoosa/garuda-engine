"""Rejecting a signal the account has already been given.

Strategies re-emit. A restart replays. A scheduler and a recovery path can
both decide the same hedge needs rolling. Every one of those arrives as a
signal that looks new, and acting on it places a second position for one
decision -- which is the most expensive mistake in this subsystem, because
nothing downstream can tell the two apart afterwards.

Three rules, ported from the reference engine, in the order they are applied.
Each exists because of a specific way the naive version failed.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from enum import StrEnum

from garuda.domain.enums import InstrumentKind, OptionType
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.trade import Trade
from garuda.domain.trade_signal import TradeSignal

#: Resolves an instrument, for the option rules that need its underlying.
type InstrumentLookup = Callable[[InstrumentId], Instrument | None]


class DuplicateRule(StrEnum):
    """Which rule rejected a signal. Reported, so a rejection is explicable."""

    #: Same slot in the same tranche: strategy, group, instrument, direction,
    #: size and slice all match.
    SAME_TRANCHE_SLOT = "SAME_TRANCHE_SLOT"
    #: Not tranched, and identical down to the moment it was generated.
    IDENTICAL_SIGNAL = "IDENTICAL_SIGNAL"
    #: The same option side on the same underlying in the same group.
    SAME_OPTION_SIDE = "SAME_OPTION_SIDE"
    #: A hedge roll racing another attempt at the same roll.
    CONCURRENT_HEDGE_REPLACE = "CONCURRENT_HEDGE_REPLACE"


@dataclass(frozen=True, slots=True)
class Duplicate:
    """Why a signal was refused, and what it collided with."""

    rule: DuplicateRule
    existing_signal_id: str
    detail: str


def _slot(signal: TradeSignal) -> tuple[object, ...]:
    """The identity of a slot: what makes two signals the same request."""
    return (
        signal.slice,
        signal.tranche,
        signal.trading_client,
        signal.strategy,
        signal.group,
        signal.instrument,
        signal.direction,
        signal.quantity,
    )


def _option_side(
    signal: TradeSignal, instruments: InstrumentLookup
) -> tuple[InstrumentId, OptionType] | None:
    """The (underlying, call-or-put) this signal occupies, if it is an option.

    Taken from the instrument rather than parsed out of the trading symbol.
    The reference engine had to read the letters off the front of the symbol
    and stop at the first digit, which truncates an underlying whose own name
    contains one; it worked only because the truncation was consistent. Ours
    is the real underlying, because the instrument master carries it.
    """
    instrument = instruments(signal.instrument)
    if instrument is None or instrument.kind is not InstrumentKind.OPTION:
        return None
    if instrument.underlying is None or instrument.option_type is None:
        return None
    return (instrument.underlying, instrument.option_type)


def _backed_only_by_terminal_trades(signal_id: str, trades: Iterable[Trade]) -> bool:
    """Whether every trade this signal produced is finished.

    A hedge that a previous roll already squared off leaves its original signal
    behind, still untriggered-looking and reloaded on the next day-init. When a
    later window targets that strike again, the leftover matches and kills the
    roll -- so the roll never places and the position runs unhedged.

    True only when the signal *has* backing trades and all of them are
    terminal. A signal with no trade yet is a genuine in-flight race and stays
    caught; a signal with a live trade is a real duplicate.
    """
    found = False
    for trade in trades:
        if trade.signal_id != signal_id:
            continue
        found = True
        if not trade.is_terminal:
            return False
    return found


def find_duplicate(
    incoming: TradeSignal,
    existing: Sequence[TradeSignal],
    trades: Sequence[Trade],
    instruments: InstrumentLookup,
) -> Duplicate | None:
    """The signal this one duplicates, or None if it is new."""
    replacement = incoming.relationships.hedge_trade_id_to_square_off is not None

    if replacement:
        return _duplicate_hedge_replacement(incoming, existing, trades)

    for candidate in existing:
        collision = _collides(incoming, candidate)
        if collision is not None:
            return collision

    return _duplicate_option_side(incoming, existing, instruments)


def _collides(incoming: TradeSignal, candidate: TradeSignal) -> Duplicate | None:
    if incoming.tranche > 0 and candidate.tranche > 0:
        # Deliberately ignores when it was generated: a strategy resending its
        # tranche after a restart is the case this blocks, and those two
        # signals differ only in their timestamp.
        if _slot(incoming) == _slot(candidate):
            return Duplicate(
                DuplicateRule.SAME_TRANCHE_SLOT,
                candidate.id,
                f"tranche {incoming.tranche} slice {incoming.slice} of "
                f"{incoming.strategy}/{incoming.group} is already taken",
            )
        return None

    # Untranched signals include the generation time in their identity, so the
    # same request emitted again later is a new request. That is the reference
    # engine's behaviour and changing it would silently drop re-entries.
    if _slot(incoming) == _slot(candidate) and incoming.generated_at == candidate.generated_at:
        return Duplicate(
            DuplicateRule.IDENTICAL_SIGNAL,
            candidate.id,
            f"an identical signal was already accepted at {candidate.generated_at.isoformat()}",
        )
    return None


def _duplicate_option_side(
    incoming: TradeSignal, existing: Sequence[TradeSignal], instruments: InstrumentLookup
) -> Duplicate | None:
    """One call side and one put side per underlying, per group.

    A straddle is a call and a put, so different option types are expected. A
    main and its hedge are opposite directions, so those are expected too. What
    is not expected is the same option type in the same direction on the same
    underlying twice in one group -- that is the same leg, sized twice.

    Multi-strike shapes (condors, butterflies) would need the strike in this
    key. They are not supported, and this rule is what would have to change.
    """
    side = _option_side(incoming, instruments)
    if side is None:
        return None

    for candidate in existing:
        if (
            candidate.trading_client != incoming.trading_client
            or candidate.strategy != incoming.strategy
            or candidate.group != incoming.group
            or candidate.direction is not incoming.direction
        ):
            continue
        if _is_another_slice_of(incoming, candidate):
            continue
        if _option_side(candidate, instruments) == side:
            underlying, option_type = side
            return Duplicate(
                DuplicateRule.SAME_OPTION_SIDE,
                candidate.id,
                f"{incoming.group} already has a {incoming.direction} {option_type} "
                f"on {underlying}",
            )
    return None


def _is_another_slice_of(incoming: TradeSignal, candidate: TradeSignal) -> bool:
    """Whether these are two pieces of one leg rather than one leg twice.

    A position above the exchange freeze limit is sent as several orders, and
    each piece is its own signal with its own ordinal. They are the same
    instrument in the same direction in the same group, which is exactly the
    shape the option-side rule exists to refuse -- so without this, everything
    after the first slice is dropped and the account ends up holding a
    fraction of the size that was intended, with nothing saying so.

    Deliberately narrow. Two independent sizings of the same leg both carry
    slice 1 and are still caught, which is the case the rule is for.
    """
    return (
        incoming.instrument == candidate.instrument
        and incoming.tranche == candidate.tranche
        and incoming.slice != candidate.slice
    )


def _duplicate_hedge_replacement(
    incoming: TradeSignal, existing: Sequence[TradeSignal], trades: Sequence[Trade]
) -> Duplicate | None:
    """A hedge roll may re-enter a slot; two rolls of it may not.

    A replacement deliberately re-enters the slot its predecessor occupies --
    that is what rolling a hedge is -- so the ordinary rules would refuse every
    one of them. It is checked only against signals that are still live, and
    only to catch two attempts at the same roll racing each other.

    A *disabled* signal never counts: a roll that failed is left disabled
    rather than removed, and treating it as a duplicate means the recovery
    retry is refused and the hedge is never replaced at all.
    """
    for candidate in existing:
        if candidate.disabled or _slot(candidate) != _slot(incoming):
            continue
        if _backed_only_by_terminal_trades(candidate.id, trades):
            # A leftover from a roll that already completed. Its position is
            # gone; only the signal lingers.
            continue
        return Duplicate(
            DuplicateRule.CONCURRENT_HEDGE_REPLACE,
            candidate.id,
            f"another replacement of the same hedge in {incoming.group} is already in flight",
        )
    return None
