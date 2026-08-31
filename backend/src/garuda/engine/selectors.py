"""Instrument selectors.

Asset class lives on the leg, not on the strategy. Each selector knows how to
pick one kind of instrument; the evaluator knows none of it, which is why
there is only one evaluator.

Selection can fail for ordinary reasons — no spot price yet, a strike the
exchange never listed, an expiry the master has lost — and every one of those
answers ``None`` rather than raising. A leg that cannot be resolved stands the
whole entry down, which the evaluator decides, not the selector.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol, runtime_checkable

from garuda.core.plugins import Registration, Registry
from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Money
from garuda.domain.strikes import AT_THE_MONEY, Moneyness, strike_for


@runtime_checkable
class SelectionContext(Protocol):
    """What a selector may consult.

    Deliberately smaller than what a rule sees: choosing an instrument needs
    the master and a price, and nothing else. A selector reaching for candles
    is a selector doing a rule's job.
    """

    def spot(self, underlying: InstrumentId) -> Money | None:
        """The underlying's price now, which is what strikes are chosen around."""
        ...

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        """Spacing between listed strikes, from the curated symbol info."""
        ...

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        """The weekly or monthly expiry this strategy trades."""
        ...

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        """One listed option. None when the exchange never listed it."""
        ...

    def future(self, underlying: InstrumentId, expiry: date) -> InstrumentId | None: ...

    def strikes(self, underlying: InstrumentId, expiry: date) -> Sequence[Decimal]:
        """Every strike the exchange lists for that series, ascending.

        Needed by anything choosing on premium rather than distance: the
        strikes either side of the money are not evenly spaced everywhere, and
        the wings are often missing entirely.
        """
        ...

    def premium(self, instrument: InstrumentId) -> Money | None:
        """What an option is trading at.

        None when nothing is subscribed to it, which is the ordinary state for
        a strike outside the chain the engine watches — and the reason a
        premium-based selector searches outward from the money rather than
        over every listed strike.
        """
        ...


@runtime_checkable
class InstrumentSelector(Protocol):
    """Picks the instrument a leg trades."""

    def select(
        self, underlying: InstrumentId, context: SelectionContext
    ) -> InstrumentId | None: ...


_SELECTORS: Registry[InstrumentSelector] = Registry("selector", InstrumentSelector)


def selector(name: str) -> Callable[[type[InstrumentSelector]], type[InstrumentSelector]]:
    """Register a selector under a configuration name.

    The same mechanism rules use, for the same reason: a leg names what picks
    its instrument, and adding a way to pick one changes nothing above it.
    """
    return _SELECTORS.register(name)


def build(config: object) -> InstrumentSelector:
    return _SELECTORS.build(config)


def registered() -> Mapping[str, Registration]:
    return _SELECTORS.known()


@selector("fixed")
@dataclass(frozen=True, slots=True)
class FixedInstrumentSelector:
    """Always the same instrument, named up front."""

    instrument: InstrumentId

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        del underlying, context
        return self.instrument


@selector("underlying")
@dataclass(frozen=True, slots=True)
class UnderlyingSelector:
    """The strategy's own underlying — an equity or index traded directly."""

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        del context
        if not underlying.value:  # pragma: no cover - InstrumentId refuses this
            raise DomainError("no underlying to select")
        return underlying


@selector("option_strike")
@dataclass(frozen=True, slots=True)
class OptionStrikeSelector:
    """An option, chosen by how far from the money it sits.

    The side is the selector's, not the leg's: a straddle is two legs of this
    selector differing only in whether they are calls or puts, and a leg does
    not otherwise care what an option is.
    """

    option_type: OptionType
    moneyness: Moneyness = AT_THE_MONEY
    expiry_kind: ExpiryKind = ExpiryKind.WEEKLY
    #: Which expiry out. Zero is the immediate one.
    expiry_offset: int = 0

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        spot = context.spot(underlying)
        if spot is None:
            return None

        gap = context.strike_gap(underlying)
        if gap is None or gap <= 0:
            return None

        expiry = context.expiry(underlying, self.expiry_kind)
        if expiry is None:
            return None

        strike = strike_for(self.moneyness, self.option_type, spot=spot, gap=gap)
        if strike <= 0:
            # A deep in-the-money offset on a low-priced underlying can walk
            # past zero. No such strike is listed, and asking for one would be
            # a lookup that can only fail.
            return None
        return context.option(underlying, expiry, strike, self.option_type)


@selector("hedge_strike")
@dataclass(frozen=True, slots=True)
class HedgeStrikeSelector:
    """An option a fixed distance beyond another leg's strike.

    Expressed in strikes rather than in premium or percent, because that is
    what makes a hedge's width predictable: two strikes out is two strikes out
    whatever the premium happens to be that morning.
    """

    option_type: OptionType
    #: How many strikes further out of the money than at-the-money.
    steps_out: int = 2
    expiry_kind: ExpiryKind = ExpiryKind.WEEKLY

    def __post_init__(self) -> None:
        if self.steps_out < 1:
            raise DomainError(
                f"a hedge {self.steps_out} strikes out is not further out than what it hedges"
            )

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        return OptionStrikeSelector(
            option_type=self.option_type,
            moneyness=Moneyness(self.steps_out),
            expiry_kind=self.expiry_kind,
        ).select(underlying, context)


@selector("future")
@dataclass(frozen=True, slots=True)
class NearMonthFutureSelector:
    """The underlying's future, on the expiry the strategy trades."""

    expiry_kind: ExpiryKind = ExpiryKind.MONTHLY

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        expiry = context.expiry(underlying, self.expiry_kind)
        if expiry is None:
            return None
        return context.future(underlying, expiry)


#: How far either side of the money a premium search will walk before giving
#: up. Beyond this the premium asked for is not on the board, and walking
#: further only finds strikes nobody is quoting.
MAX_STRIKES_SEARCHED = 40


@selector("premium")
@dataclass(frozen=True, slots=True)
class PremiumSelector:
    """The strike trading nearest a target premium.

    What an operator means by "sell the 100-rupee call": not a distance from
    the money, which moves with volatility, but a price. The same strategy on
    a quiet day is far out and on a busy one is close in, which is the point.

    Searched outward from the money rather than over every listed strike,
    because only the strikes the engine subscribes to have a price at all —
    and because the answer is always near the money for a sane target.
    """

    option_type: OptionType
    target: Decimal = Decimal(100)
    #: The widest acceptable miss. Without one, a target nobody is near is
    #: answered by whichever strike happened to be least wrong.
    tolerance: Decimal | None = None
    expiry_kind: ExpiryKind = ExpiryKind.WEEKLY
    #: Prefer a strike further out than the money when two are equally near,
    #: which is the safer side for a seller.
    prefer_further_out: bool = True

    def __post_init__(self) -> None:
        if self.target <= 0:
            raise DomainError(f"a target premium of {self.target} is not a premium")
        if self.tolerance is not None and self.tolerance < 0:
            raise DomainError(f"a tolerance of {self.tolerance} is not a tolerance")

    def select(self, underlying: InstrumentId, context: SelectionContext) -> InstrumentId | None:
        expiry = context.expiry(underlying, self.expiry_kind)
        if expiry is None:
            return None

        best: tuple[Decimal, bool, InstrumentId] | None = None
        for strike in self._candidates(underlying, expiry, context):
            listed = context.option(underlying, expiry, strike, self.option_type)
            if listed is None:
                continue
            premium = context.premium(listed)
            if premium is None:
                continue
            miss = abs(premium.amount - self.target)
            if self.tolerance is not None and miss > self.tolerance:
                continue
            # Further out breaks a tie: for a seller it is the safer strike,
            # and without a tie-break the answer depends on iteration order.
            further = premium.amount < self.target
            candidate = (miss, further is not self.prefer_further_out, listed)
            if best is None or candidate[:2] < best[:2]:
                best = candidate

        return best[2] if best is not None else None

    def _candidates(
        self, underlying: InstrumentId, expiry: date, context: SelectionContext
    ) -> Sequence[Decimal]:
        """Listed strikes, nearest the money first.

        Ordered so the search can stop being interesting early and so a tie is
        broken by distance rather than by however the exchange listed them.
        """
        spot = context.spot(underlying)
        listed = context.strikes(underlying, expiry)
        if spot is None or not listed:
            return ()
        nearest = sorted(listed, key=lambda strike: abs(strike - spot.amount))
        return nearest[:MAX_STRIKES_SEARCHED]
