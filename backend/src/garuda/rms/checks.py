"""The checks.

Each is a pure function of a :class:`RiskContext`. No I/O, no clock of its own,
nothing fetched -- so each can be tested in isolation and none of them can
disagree about what the market was doing at the moment of the decision.

This phase implements the checks the vertical slice needs. The rest of the
vocabulary in :mod:`garuda.rms.breaches` is filled in during the phase that
brings live execution.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from garuda.rms.breaches import BreachType
from garuda.rms.gate import Breach, RiskContext


@dataclass(frozen=True, slots=True)
class KillSwitchCheck:
    """Nothing leaves the process while a kill switch is on."""

    breach_type: BreachType = BreachType.KILL_SWITCH_ACTIVE

    def __call__(self, context: RiskContext) -> Breach | None:
        if context.kill_switch_reason is None:
            return None
        return Breach(self.breach_type, context.kill_switch_reason)


@dataclass(frozen=True, slots=True)
class MarketOpenCheck:
    """An order outside market hours is a bug, not an opportunity."""

    breach_type: BreachType = BreachType.MARKET_CLOSED

    def __call__(self, context: RiskContext) -> Breach | None:
        if context.market_open:
            return None
        return Breach(
            self.breach_type,
            f"{context.instrument.exchange.code} is closed at {context.now.isoformat()}",
        )


@dataclass(frozen=True, slots=True)
class QuoteAvailableCheck:
    """No price, no order. The engine does not trade on a memory."""

    breach_type: BreachType = BreachType.QUOTE_UNAVAILABLE

    def __call__(self, context: RiskContext) -> Breach | None:
        if context.quote is not None:
            return None
        return Breach(self.breach_type, f"no quote for {context.instrument.trading_symbol}")


@dataclass(frozen=True, slots=True)
class PriceNonZeroCheck:
    """A zero price is a feed defect that reads as a free trade."""

    breach_type: BreachType = BreachType.PRICE_ZERO

    def __call__(self, context: RiskContext) -> Breach | None:
        quote = context.quote
        if quote is None or quote.last_price.amount > 0:
            return None
        return Breach(
            self.breach_type,
            f"{context.instrument.trading_symbol} last traded at {quote.last_price}",
        )


@dataclass(frozen=True, slots=True)
class StaleQuoteCheck:
    """A quote older than the limit is not a price, it is a memory."""

    breach_type: BreachType = BreachType.PRICE_STALE

    def __call__(self, context: RiskContext) -> Breach | None:
        quote = context.quote
        limit = context.limits.stale_quote_after
        if quote is None or limit is None:
            return None
        age = context.now - quote.timestamp
        if age <= limit:
            return None
        return Breach(
            self.breach_type,
            f"{context.instrument.trading_symbol} quote is {age.total_seconds():.0f}s old, "
            f"limit is {limit.total_seconds():.0f}s",
        )


@dataclass(frozen=True, slots=True)
class OrderQuantityCheck:
    breach_type: BreachType = BreachType.ORDER_QTY_EXCEEDED

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.max_order_quantity
        if limit is None or context.request.quantity <= limit:
            return None
        return Breach(
            self.breach_type,
            f"{context.request.quantity} units exceeds the limit of {limit}",
        )


@dataclass(frozen=True, slots=True)
class OrderValueCheck:
    """Guards against a sizing bug turning a lot into a hundred."""

    breach_type: BreachType = BreachType.ORDER_VALUE_EXCEEDED

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.max_order_value
        quote = context.quote
        if limit is None or quote is None:
            return None
        value = context.instrument.notional(quote.last_price, context.request.quantity)
        if value <= limit:
            return None
        return Breach(self.breach_type, f"order value {value} exceeds the limit of {limit}")


@dataclass(frozen=True, slots=True)
class FreezeQuantityCheck:
    """The exchange will reject anything above its freeze limit.

    Reaching the gate at all means the sizing layer failed to slice the entry,
    so this is a defect detector rather than a risk limit.
    """

    breach_type: BreachType = BreachType.FREEZE_QTY_EXCEEDED

    def __call__(self, context: RiskContext) -> Breach | None:
        if not context.instrument.exceeds_freeze_limit(context.request.quantity):
            return None
        return Breach(
            self.breach_type,
            f"{context.request.quantity} exceeds the exchange freeze limit of "
            f"{context.instrument.freeze_quantity}; the entry should have been sliced",
        )


@dataclass(frozen=True, slots=True)
class SpreadCheck:
    """A wide spread means the exit will cost more than the model assumes."""

    breach_type: BreachType = BreachType.SPREAD_WIDE

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.max_spread_fraction
        quote = context.quote
        if limit is None or quote is None:
            return None
        spread = quote.spread
        if spread is None or quote.last_price.is_zero:
            return None
        fraction = spread.ratio_to(quote.last_price)
        if fraction <= limit:
            return None
        return Breach(
            self.breach_type,
            f"spread {spread} is {fraction:.2%} of {quote.last_price}, "
            f"limit is {Decimal(limit):.2%}",
        )


@dataclass(frozen=True, slots=True)
class VolumeCheck:
    breach_type: BreachType = BreachType.VOLUME_LOW

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.min_volume
        quote = context.quote
        if limit is None or quote is None or quote.volume is None:
            return None
        if quote.volume >= limit:
            return None
        return Breach(
            self.breach_type,
            f"volume {quote.volume} is below the minimum of {limit}",
        )


def default_checks() -> tuple[
    KillSwitchCheck,
    MarketOpenCheck,
    QuoteAvailableCheck,
    PriceNonZeroCheck,
    StaleQuoteCheck,
    OrderQuantityCheck,
    OrderValueCheck,
    FreezeQuantityCheck,
    SpreadCheck,
    VolumeCheck,
]:
    """The set every gate runs unless told otherwise.

    Ordered so an operator reading a multi-breach message sees the systemic
    reasons before the market-quality ones.
    """
    return (
        KillSwitchCheck(),
        MarketOpenCheck(),
        QuoteAvailableCheck(),
        PriceNonZeroCheck(),
        StaleQuoteCheck(),
        OrderQuantityCheck(),
        OrderValueCheck(),
        FreezeQuantityCheck(),
        SpreadCheck(),
        VolumeCheck(),
    )
