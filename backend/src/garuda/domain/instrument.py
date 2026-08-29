"""Instruments and their canonical identity.

:class:`InstrumentId` is engine-owned and canonical. Adapters translate to and
from broker tokens or OCC/OSI symbols at their own boundary; the core never
sees a broker-specific symbol string.

``exercise_style`` and ``settlement_type`` are carried from day one even though
every NSE option is European and cash-settled. They are the two fields that let
American-style options coexist later without reworking the position book, and
retrofitting them would touch everything.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Final

from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.errors import DomainError, InvalidInstrumentError
from garuda.domain.exchange import Exchange
from garuda.domain.money import Currency, Money, Numeric, to_decimal

#: Instrument kinds that expire and reference an underlying.
DERIVATIVE_KINDS: Final = frozenset({InstrumentKind.FUTURE, InstrumentKind.OPTION})


#: A broker's own handle on an instrument, as text.
#:
#: Brokers do not agree on the shape: Zerodha numbers them, and an XTS-style
#: broker may use a string. The engine never computes on a token -- it looks
#: one up, sends it back, and matches it -- so the widest honest type is text,
#: and each adapter converts at its own boundary where it already translates
#: everything else. Typing it as a number would make the first string-token
#: broker a change to every signature that touches one.
type BrokerToken = str


@dataclass(frozen=True, slots=True)
class InstrumentId:
    """A canonical, engine-owned instrument identifier."""

    value: str

    def __post_init__(self) -> None:
        if not self.value or self.value.strip() != self.value:
            raise DomainError(f"instrument id {self.value!r} is empty or padded")
        if any(c.isspace() for c in self.value):
            raise DomainError(f"instrument id {self.value!r} contains whitespace")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class Instrument:
    """A tradable (or, for synthetics, priceable) instrument."""

    id: InstrumentId
    exchange: Exchange
    segment: Segment
    kind: InstrumentKind
    trading_symbol: str
    lot_size: int
    tick_size: Decimal
    multiplier: Decimal = Decimal(1)
    #: Exchange freeze limit in units, if the venue publishes one. An entry
    #: above it is sliced into several orders.
    freeze_quantity: int | None = None
    underlying: InstrumentId | None = None
    expiry: date | None = None
    strike: Decimal | None = None
    option_type: OptionType | None = None
    exercise_style: ExerciseStyle | None = None
    settlement_type: SettlementType | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "tick_size", to_decimal(self.tick_size))
        object.__setattr__(self, "multiplier", to_decimal(self.multiplier))
        if self.strike is not None:
            object.__setattr__(self, "strike", to_decimal(self.strike))

        if self.lot_size < 1:
            raise InvalidInstrumentError(f"{self.id}: lot size {self.lot_size} must be at least 1")
        if self.tick_size <= 0:
            raise InvalidInstrumentError(f"{self.id}: tick size {self.tick_size} must be positive")
        if self.multiplier <= 0:
            raise InvalidInstrumentError(f"{self.id}: multiplier must be positive")
        if self.freeze_quantity is not None and self.freeze_quantity < 1:
            raise InvalidInstrumentError(f"{self.id}: freeze quantity must be at least 1")
        if not self.exchange.trades(self.segment):
            raise InvalidInstrumentError(
                f"{self.id}: {self.exchange.code} does not trade {self.segment}"
            )
        self._validate_kind()

    def _validate_kind(self) -> None:
        is_derivative = self.kind in DERIVATIVE_KINDS

        if is_derivative:
            if self.expiry is None:
                raise InvalidInstrumentError(f"{self.id}: a {self.kind} needs an expiry")
            if self.underlying is None:
                raise InvalidInstrumentError(f"{self.id}: a {self.kind} needs an underlying")
        elif self.expiry is not None:
            raise InvalidInstrumentError(f"{self.id}: a {self.kind} cannot have an expiry")

        if self.kind is InstrumentKind.OPTION:
            missing = [
                name
                for name, value in (
                    ("strike", self.strike),
                    ("option_type", self.option_type),
                    ("exercise_style", self.exercise_style),
                    ("settlement_type", self.settlement_type),
                )
                if value is None
            ]
            if missing:
                raise InvalidInstrumentError(f"{self.id}: an option needs {', '.join(missing)}")
            if self.strike is not None and self.strike <= 0:
                raise InvalidInstrumentError(f"{self.id}: strike {self.strike} must be positive")
        else:
            if self.strike is not None:
                raise InvalidInstrumentError(f"{self.id}: only an option has a strike")
            if self.option_type is not None:
                raise InvalidInstrumentError(f"{self.id}: only an option has an option type")

    # -- classification -----------------------------------------------------

    @property
    def is_derivative(self) -> bool:
        return self.kind in DERIVATIVE_KINDS

    @property
    def is_option(self) -> bool:
        return self.kind is InstrumentKind.OPTION

    @property
    def is_future(self) -> bool:
        return self.kind is InstrumentKind.FUTURE

    @property
    def is_tradable(self) -> bool:
        """Synthetics and indices are priced and subscribed to, never routed."""
        return self.kind not in (InstrumentKind.INDEX, InstrumentKind.SYNTHETIC)

    @property
    def currency(self) -> Currency:
        return self.exchange.currency

    # -- prices and quantities ----------------------------------------------

    def quantize_price(self, price: Money, rounding: str = ROUND_HALF_UP) -> Money:
        """Snap a price to the instrument's tick size.

        The rounding mode is a parameter and not a default buried in the
        Decimal context, because at an order boundary the direction matters:
        round a buy protection down and it may never fill, round a sell
        protection up and the same.
        """
        if price.currency is not self.exchange.currency:
            raise InvalidInstrumentError(
                f"{self.id}: price is {price.currency}, "
                f"{self.exchange.code} trades in {self.exchange.currency}"
            )
        ticks = (price.amount / self.tick_size).quantize(Decimal(1), rounding=rounding)
        return Money(ticks * self.tick_size, price.currency)

    def is_on_tick(self, price: Money) -> bool:
        return price.amount % self.tick_size == 0

    def lots_to_quantity(self, lots: int) -> int:
        if lots < 0:
            raise DomainError(f"{self.id}: lot count {lots} is negative")
        return lots * self.lot_size

    def notional(self, price: Money, quantity: Numeric) -> Money:
        """Contract value of ``quantity`` units at ``price``."""
        return price * to_decimal(quantity) * self.multiplier

    def exceeds_freeze_limit(self, quantity: int) -> bool:
        return self.freeze_quantity is not None and quantity > self.freeze_quantity

    def __str__(self) -> str:
        return self.trading_symbol
