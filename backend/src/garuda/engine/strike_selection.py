"""Choosing the strikes an option entry trades.

`STRATEGY_ENGINE.md` §4 step 4: the tranche's `strike_type` names a selector,
which answers a call strike and a put strike from the spot and the chain.
The pair is chosen together because some selectors balance the two legs
against each other; a single-leg entry takes the side it needs.

Selectors are a registry. A strike type the engine does not implement is
refused by name rather than read as at-the-money: a strategy that silently
trades a different strike than configured is worse than one that does not
trade.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from decimal import Decimal
from typing import Protocol

from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.strikes import Moneyness, atm_strike
from garuda.engine.config import ResolvedConfig
from garuda.engine.vocabulary import StrikeType


class ChainView(Protocol):
    """What a selector may consult."""

    def option(
        self, underlying: InstrumentId, expiry: date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None: ...

    def quote(self, instrument: InstrumentId) -> Tick | None: ...

    def strikes(self, underlying: InstrumentId, expiry: date) -> list[Decimal]: ...


@dataclass(frozen=True, slots=True)
class StrikeRequest:
    underlying: InstrumentId
    expiry: date
    #: The price strikes are chosen around: spot for an index, the future for
    #: a future-based strategy.
    price: Money
    gap: Decimal
    config: ResolvedConfig
    chain: ChainView


@dataclass(frozen=True, slots=True)
class StrikePair:
    call: Decimal
    put: Decimal
    because: str


type StrikeSelector = Callable[[StrikeRequest], StrikePair | str]

_SELECTORS: dict[StrikeType, StrikeSelector] = {}


def strike_selector(kind: StrikeType) -> Callable[[StrikeSelector], StrikeSelector]:
    def register(selector: StrikeSelector) -> StrikeSelector:
        _SELECTORS[kind] = selector
        return selector

    return register


def select_strikes(kind: StrikeType, request: StrikeRequest) -> StrikePair | str:
    """The pair, or why there is none. Never a guess."""
    selector = _SELECTORS.get(kind)
    if selector is None:
        raise DomainError(f"strike type {kind.value} is not implemented by this engine")
    return selector(request)


def implemented() -> tuple[str, ...]:
    return tuple(kind.value for kind in StrikeType if kind in _SELECTORS)


@strike_selector(StrikeType.MONEYNESS)
def moneyness(request: StrikeRequest) -> StrikePair | str:
    """ATM, or a number of strikes either side of it, from the configured
    `strike_value`. Call and put move in opposite directions: OTM+1 is one
    strike above the money for the call and one below for the put."""
    value = request.config.text("strike_value") or "ATM"
    steps = Moneyness.parse(value).steps
    atm = atm_strike(request.price, request.gap)
    call = atm + steps * request.gap
    put = atm - steps * request.gap
    if call <= 0 or put <= 0:
        return f"{value} from {atm} walks past zero"
    return StrikePair(call, put, f"{value}: ATM {atm} at {request.price.amount}")
