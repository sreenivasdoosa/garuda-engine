"""Which legs belong with which, and which goes first.

A position is often several orders. A short call has a long call protecting it;
a straddle has two sides; a cash-and-futures position has legs in different
products entirely. Three questions have to be answerable about any leg: what
protects it, what it is paired with, and whether it may be placed yet.

**A leg's role is stated, never inferred from its direction.** The reference
engine originally worked out which leg was the hedge by asking whether it was
the long one, which held only because option selling's hedge is bought against
a sold main. A covered call breaks it exactly: its long leg is the stock and
its short leg is the call, so the direction rule calls the shareholding a hedge
and squares it off when the call exits. Garuda has no legacy trades without a
role, so there is no fallback here at all.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime

from garuda.domain.intent import LegRole
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_signal import TradeSignal
from garuda.domain.trade_state import TradeExitReason


@dataclass(frozen=True, slots=True)
class HedgeLookup:
    """The hedge a leg is paired with, and whether the answer was clean."""

    trade: Trade | None
    #: More than one live candidate. Expected for seconds during a roll --
    #: the new hedge is placed before the old one is squared off -- and a
    #: problem if it persists.
    ambiguous: tuple[TradeId, ...] = ()
    #: Every candidate is finished or being replaced, so this is the most
    #: recent rather than the operative one.
    degraded: bool = False


def is_hedge(trade_or_signal: Trade | TradeSignal) -> bool:
    """Whether this leg exists to protect another one."""
    relationships = trade_or_signal.relationships
    if isinstance(trade_or_signal, TradeSignal) and (
        relationships.hedge_trade_id_to_square_off is not None
    ):
        # A replacement is a hedge by definition, whatever else it says.
        return True
    return relationships.leg_role is LegRole.HEDGE


def find_hedge(of: Trade | TradeSignal, trades: Iterable[Trade]) -> HedgeLookup:
    """The operative hedge for a leg, among an account's trades.

    A multi-day short accumulates rolled hedges under one correlation id:
    the original, then each replacement. Taking the first match returns the
    oldest, which is dead, and links the live short to a hedge that no longer
    exists. So: skip anything finished or tagged as being replaced, and among
    what is left take the most recently started.

    Pairing is by role rather than by opposite direction. A protected long
    future and its bought put are both long, so direction can never pair them.
    """
    correlation = of.relationships.hedge_correlation_id
    if correlation is None:
        return HedgeLookup(None)

    wanted_hedge = not is_hedge(of)
    matches = [
        trade
        for trade in trades
        if trade.relationships.hedge_correlation_id == correlation
        and is_hedge(trade) == wanted_hedge
        and _not_itself(trade, of)
    ]
    if not matches:
        return HedgeLookup(None)

    live = [
        trade
        for trade in matches
        # A hedge whose replacement is already placed is on its way out. It
        # is still live -- the square-off has not filled -- and pairing to it
        # links the main leg to protection about to disappear.
        if trade.is_live and trade.exiting_for is not TradeExitReason.HEDGE_REPLACE
    ]
    if live:
        chosen = _most_recent(live)
        ambiguous = tuple(trade.id for trade in live) if len(live) > 1 else ()
        return HedgeLookup(chosen, ambiguous=ambiguous)

    # Nothing live. Hand back the most recent so the caller has a handle,
    # and say that the answer is degraded.
    return HedgeLookup(_most_recent(matches), degraded=True)


def find_pair(of: Trade, trades: Iterable[Trade]) -> Trade | None:
    """The other side of an option pair -- the put to a call, or the reverse."""
    correlation = of.relationships.pair_correlation_id
    if correlation is None:
        return None
    for trade in trades:
        if trade.id != of.id and trade.relationships.pair_correlation_id == correlation:
            return trade
    return None


def find_combo_legs(of: Trade, trades: Iterable[Trade]) -> tuple[Trade, ...]:
    """Every leg entered together with this one, whatever its product.

    The correlation ids cannot answer this: one binds a main to its hedge and
    the other binds two option sides, and both are option-shaped. A cash leg
    and a futures leg have neither, and are still one position.
    """
    combo = of.relationships.combo_id
    if combo is None:
        return ()
    return tuple(
        trade for trade in trades if trade.id != of.id and trade.relationships.combo_id == combo
    )


# -- entry ordering ---------------------------------------------------------


def earlier_leg_signal(signal: TradeSignal, signals: Sequence[TradeSignal]) -> TradeSignal | None:
    """The leg this one waits on.

    The *immediate* predecessor, not the first leg: a three-leg combo where the
    third waits on the first would go the moment the first filled, with the
    second still working -- which is the ordering the sequence exists to
    prevent.
    """
    if signal.relationships.entry_sequence <= 0:
        return None

    peers = [
        candidate
        for candidate in signals
        if candidate.id != signal.id
        and _shares_a_group(candidate, signal)
        and 0 < candidate.relationships.entry_sequence < signal.relationships.entry_sequence
    ]
    if not peers:
        return None
    return max(peers, key=lambda candidate: candidate.relationships.entry_sequence)


def goes_after_another_leg(signal: TradeSignal, signals: Sequence[TradeSignal]) -> bool:
    """Whether this leg must wait for another to fill before it is placed.

    Asked as "is my sequence later than my predecessor's", which is answerable
    for a group of any size. The reference engine asked "am I the sell, and is
    the rule buy-first" -- answerable only for a pair, and only for options.

    A leg with no sequence does not wait. Ordering is the strategy's decision
    and is expressed when the signals are built; a group whose legs carry no
    sequence has said it does not care.
    """
    return earlier_leg_signal(signal, signals) is not None


def earlier_leg_trade(
    signal: TradeSignal, signals: Sequence[TradeSignal], trades: Iterable[Trade]
) -> Trade | None:
    """The trade placed for the leg this one waits on, if there is one yet."""
    earlier = earlier_leg_signal(signal, signals)
    if earlier is None:
        return None
    for trade in trades:
        if trade.signal_id == earlier.id:
            return trade
    return None


def _shares_a_group(left: TradeSignal, right: TradeSignal) -> bool:
    """Whether two legs were entered together.

    A combo id binds legs across products; a hedge correlation binds a main to
    its protection. Either is enough to make one leg wait for the other.
    """
    combo = right.relationships.combo_id
    if combo is not None and left.relationships.combo_id == combo:
        return True
    hedge = right.relationships.hedge_correlation_id
    return hedge is not None and left.relationships.hedge_correlation_id == hedge


def _not_itself(trade: Trade, of: Trade | TradeSignal) -> bool:
    return not (isinstance(of, Trade) and trade.id == of.id)


def _most_recent(trades: Sequence[Trade]) -> Trade:
    """The latest by start time. A trade that never started sorts first."""
    return max(
        trades,
        key=lambda trade: (
            trade.started_at is not None,
            trade.started_at or datetime.min.replace(tzinfo=UTC),
        ),
    )
