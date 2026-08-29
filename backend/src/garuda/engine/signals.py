"""Turning what a strategy decided into what trade management can act on.

An evaluator emits :class:`Intent`s: go long this, hedge it with that. Trade
management consumes :class:`TradeSignal`s: this instrument, this many units,
triggered at this price, protected at these levels. This is the join between
them, and it is where a decision acquires a size.

Three rules shape it, and each is the safe direction to be wrong in:

* **A partial entry is worse than none.** If any leg cannot be resolved,
  priced or sized, the whole combo is refused. A short option whose hedge was
  dropped for want of one lot is not a smaller version of the position that
  was designed -- it is a different position, with a different margin
  requirement and a different worst case. The evaluator already stands aside
  on an unresolvable leg for this reason; sizing holds the same line.
* **A position above the freeze limit is several signals, not one big one.**
  Each slice becomes its own signal, its own trade and its own protective
  order, because that is what the exchange will accept and what the engine
  can then manage independently.
* **Ids are derived, never random.** Replaying an evaluation must produce the
  same signal ids as the run that recorded it, or duplicate detection has
  nothing stable to compare and a replay proves nothing.

Sizing lives below this in the layer order and risk lives beside it: the risk
gate sees an order request, not a signal, so it applies where the entry order
is placed rather than here.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime

from garuda.capital.sizing import Sizer, Sizing
from garuda.domain.enums import Direction
from garuda.domain.errors import DomainError
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import Intent, IntentKind, LegRole
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.trade import Protection, Relationships
from garuda.domain.trade_signal import EntryRules, SignalType, TradeSignal

logger = logging.getLogger(__name__)

type InstrumentLookup = Callable[[InstrumentId], Instrument | None]
type QuoteLookup = Callable[[InstrumentId], Tick | None]

#: Where a leg's stop and target come from. Given the leg and the price it is
#: expected to enter at, because a percentage stop means nothing without one.
type ProtectionPolicy = Callable[[Intent, Money], Protection]

#: How the entry order is placed: at market, on a trigger, with escalation.
type EntryPolicy = Callable[[Intent, Money], EntryRules]

#: The stored signal id column is 50 characters, and an id that will not
#: persist is an id that vanishes on restart.
SIGNAL_ID_LENGTH = 50


@dataclass(frozen=True, slots=True)
class SignalBatch:
    """What one evaluation produced, or why it produced nothing.

    Either signals or a refusal, never both: a combo is entered whole or not
    at all, so there is no half-accepted batch to represent.
    """

    signals: tuple[TradeSignal, ...] = ()
    refusal: str | None = None
    #: What each leg sized to, kept for the log line and the evaluation record
    #: even when the batch was refused -- "no lot affordable" is the answer an
    #: operator asking why nothing traded actually needs.
    sizings: tuple[Sizing, ...] = ()

    @property
    def accepted(self) -> bool:
        return bool(self.signals) and self.refusal is None

    @property
    def leg_count(self) -> int:
        """Legs, not signals. A sliced leg is still one leg."""
        return len(self.sizings)


class SignalFactory:
    """Builds the signals for one evaluation's worth of intents."""

    def __init__(
        self,
        sizer: Sizer,
        instruments: InstrumentLookup,
        quotes: QuoteLookup,
        *,
        protection: ProtectionPolicy | None = None,
        entry: EntryPolicy | None = None,
    ) -> None:
        self._sizer = sizer
        self._instruments = instruments
        self._quotes = quotes
        self._protection = protection or _no_protection
        self._entry = entry or _at_market

    def build(
        self,
        intents: Sequence[Intent],
        *,
        capital: Money,
        now: datetime,
        group: str = "DEFAULT",
        tranche: int = 0,
        is_paper: bool = False,
    ) -> SignalBatch:
        """Size every leg, then emit signals -- or refuse the lot."""
        if not intents:
            return SignalBatch()

        problem = _disagreement(intents)
        if problem is not None:
            raise DomainError(problem)

        legs: list[_Leg] = []
        for sequence, intent in enumerate(intents):
            leg = self._size(intent, capital, sequence)
            if isinstance(leg, str):
                return SignalBatch(refusal=leg, sizings=tuple(sized.sizing for sized in legs))
            legs.append(leg)

        combo_id = intents[0].correlation_id if len(legs) > 1 else None
        signals: list[TradeSignal] = []
        for leg in legs:
            signals.extend(
                self._signals_for(
                    leg,
                    combo_id=combo_id,
                    leg_count=len(legs),
                    now=now,
                    group=group,
                    tranche=tranche,
                    is_paper=is_paper,
                )
            )
        return SignalBatch(signals=tuple(signals), sizings=tuple(leg.sizing for leg in legs))

    # -- one leg ------------------------------------------------------------

    def _size(self, intent: Intent, capital: Money, sequence: int) -> _Leg | str:
        """Resolve, price and size one leg. A string is the reason it cannot be."""
        instrument = self._instruments(intent.instrument)
        if instrument is None:
            return f"{intent.strategy}: {intent.instrument} is not in today's instrument master"

        quote = self._quotes(intent.instrument)
        if quote is None:
            return (
                f"{intent.strategy}: no price for {instrument.trading_symbol}, "
                "so it cannot be sized"
            )

        sizing = self._sizer.size(intent, instrument, quote.last_price, capital)
        if not sizing.is_tradable:
            return (
                f"{intent.strategy}: the {intent.role} leg "
                f"({instrument.trading_symbol}) sized to nothing"
                + (f" -- {sizing.refusal}" if sizing.refusal else "")
                + ". The whole entry is refused: a leg dropped for want of a lot "
                "makes a different position, not a smaller one."
            )
        return _Leg(
            intent=intent,
            instrument=instrument,
            price=quote.last_price,
            sizing=sizing,
            sequence=sequence,
        )

    def _signals_for(
        self,
        leg: _Leg,
        *,
        combo_id: str | None,
        leg_count: int,
        now: datetime,
        group: str,
        tranche: int,
        is_paper: bool,
    ) -> list[TradeSignal]:
        """One signal per slice, because one signal becomes one order."""
        relationships = _relationships_for(leg, combo_id)
        protection = self._protection(leg.intent, leg.price)
        entry = self._entry(leg.intent, leg.price)

        return [
            TradeSignal(
                id=_signal_id(leg, ordinal),
                trading_client=leg.intent.trading_client,
                instrument=leg.instrument.id,
                strategy=leg.intent.strategy,
                signal_type=_signal_type(leg.intent.direction),
                product=leg.intent.product,
                quantity=quantity,
                generated_at=now,
                quantity_per_lot=leg.instrument.lot_size,
                contract_multiplier=leg.instrument.multiplier,
                entry=entry,
                protection=protection,
                relationships=relationships,
                group=group,
                tranche=tranche,
                slice=ordinal,
                is_paper=is_paper,
                expiry=leg.instrument.expiry.isoformat() if leg.instrument.expiry else None,
                combo_leg_count=leg_count if leg_count > 1 else 0,
                remarks=leg.intent.reason,
            )
            for ordinal, quantity in enumerate(leg.sizing.slices, start=1)
        ]


@dataclass(frozen=True, slots=True)
class _Leg:
    """One leg, resolved and sized."""

    intent: Intent
    instrument: Instrument
    price: Money
    sizing: Sizing
    sequence: int


def _relationships_for(leg: _Leg, combo_id: str | None) -> Relationships:
    """What binds this leg to the others entered with it.

    ``entry_sequence`` is the leg's position in the order the evaluator
    emitted them, which is the entry order it chose. Nothing further down can
    recover that once the list is flattened into signals.
    """
    intent = leg.intent
    return Relationships(
        combo_id=combo_id,
        leg_role=intent.role,
        entry_sequence=leg.sequence,
        hedge_correlation_id=(intent.correlation_id if intent.role is LegRole.HEDGE else None),
    )


def _signal_id(leg: _Leg, slice_ordinal: int) -> str:
    """Derived from the correlation id, so a replay produces the same ids.

    Kept inside 50 characters because the stored column is that wide; the
    correlation id is truncated rather than the parts that make it unique,
    since two legs of one combo differ only in the suffix.
    """
    suffix = f"-{leg.sequence}-{slice_ordinal}"
    room = SIGNAL_ID_LENGTH - len(suffix)
    if room < 1:  # pragma: no cover - would need a 48-leg combo
        raise DomainError(f"{leg.intent.strategy}: leg {leg.sequence} has no room for an id")
    return f"{leg.intent.correlation_id[:room]}{suffix}"


def _signal_type(direction: Direction) -> SignalType:
    return SignalType.LONG_ENTRY if direction is Direction.LONG else SignalType.SHORT_ENTRY


def _no_protection(intent: Intent, price: Money) -> Protection:  # noqa: ARG001
    """No stop and no target until a policy says otherwise.

    Distinct from ``no_stop_loss``, which is a strategy deliberately trading
    without one. This is nothing having been configured yet, and the
    protective service treats a level of None as "not placed" rather than as
    "not wanted".
    """
    return Protection()


def _at_market(intent: Intent, price: Money) -> EntryRules:  # noqa: ARG001
    """Enter immediately, unless the intent asked for a limit."""
    if intent.limit_price is not None:
        return EntryRules(trigger=intent.limit_price)
    return EntryRules(place_market_order=True)


def _disagreement(intents: Sequence[Intent]) -> str | None:
    """Whether these intents can be one position at all.

    Legs of a combo share an account and a correlation id. A batch that does
    not is two evaluations that got mixed up, and entering it would create a
    combo whose legs cannot be coordinated because nothing links them.
    """
    first = intents[0]
    for intent in intents:
        if intent.kind is not IntentKind.ENTER:
            return (
                f"{intent.strategy}: an exit does not travel as a signal; it names a "
                "trade by id, because an exit matched back by symbol exits the wrong one"
            )
        if intent.trading_client != first.trading_client:
            return (
                f"{intent.strategy}: legs for {first.trading_client.value} and "
                f"{intent.trading_client.value} are not one position"
            )
        if intent.correlation_id != first.correlation_id:
            return (
                f"{intent.strategy}: legs carry correlation ids "
                f"{first.correlation_id} and {intent.correlation_id}; "
                "nothing would link them once entered"
            )
    return None
