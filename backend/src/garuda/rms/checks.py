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

    @property
    def guards_exits(self) -> bool:
        """A kill switch stops an operator taking risk. Leaving risk already
        taken is the one thing it must never prevent, and the reference
        engine says so in as many words: always allow closing positions."""
        return False

    def __call__(self, context: RiskContext) -> Breach | None:
        if context.kill_switch_reason is None:
            return None
        return Breach(self.breach_type, context.kill_switch_reason)


@dataclass(frozen=True, slots=True)
class MarketOpenCheck:
    """An order outside market hours is a bug, not an opportunity."""

    breach_type: BreachType = BreachType.MARKET_CLOSED

    @property
    def guards_exits(self) -> bool:
        """The exchange refuses it either way, so refusing here costs one
        rejection and gives a clearer reason."""
        return True

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

    @property
    def guards_exits(self) -> bool:
        """Not knowing the price is a reason not to open a position, and never
        a reason to keep one."""
        return False

    def __call__(self, context: RiskContext) -> Breach | None:
        if context.quote is not None:
            return None
        return Breach(self.breach_type, f"no quote for {context.instrument.trading_symbol}")


@dataclass(frozen=True, slots=True)
class PriceNonZeroCheck:
    """A zero price is a feed defect that reads as a free trade."""

    breach_type: BreachType = BreachType.PRICE_ZERO

    @property
    def guards_exits(self) -> bool:
        """As above: a bad price stops an entry, never an exit."""
        return False

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

    @property
    def guards_exits(self) -> bool:
        """As above."""
        return False

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

    @property
    def guards_exits(self) -> bool:
        """A size cap is about how much risk may be taken on."""
        return False

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

    @property
    def guards_exits(self) -> bool:
        """As above."""
        return False

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

    @property
    def guards_exits(self) -> bool:
        """The exchange refuses anything above its freeze limit whichever way
        the order points, so an exit above it has to be sliced too."""
        return True

    def __call__(self, context: RiskContext) -> Breach | None:
        if not context.instrument.exceeds_freeze_limit(context.request.quantity):
            return None
        return Breach(
            self.breach_type,
            f"{context.request.quantity} exceeds the exchange freeze limit of "
            f"{context.instrument.freeze_quantity}; the entry should have been sliced",
        )


@dataclass(frozen=True, slots=True)
class DailyLossCheck:
    """Stops an account that has already lost its budget for the day.

    Entries only, which is the whole point of gating entries rather than
    orders: an account past its limit must stop *taking* risk, and must never
    be stopped from getting out of the risk it already has. A limit that
    blocked an exit would turn a bad day into an uncapped one.

    The limit is a positive amount and the day's realised result is signed, so
    the comparison is against its negation — which reads oddly and is the
    right way round: -50,000 breaches a 40,000 limit.
    """

    breach_type: BreachType = BreachType.DAILY_LOSS_EXCEEDED

    @property
    def guards_exits(self) -> bool:
        """The point of a loss limit is to stop taking more risk. Blocking an
        exit at the limit would turn a bad day into an uncapped one."""
        return False

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.max_daily_loss
        realized = context.realized_pnl_today
        if limit is None or realized is None:
            return None
        if realized >= -limit:
            return None
        return Breach(
            self.breach_type,
            f"the day is down {realized}, past the limit of {limit}; no new positions "
            "until tomorrow, and everything open can still be closed",
        )


@dataclass(frozen=True, slots=True)
class SpreadCheck:
    """A wide spread means the exit will cost more than the model assumes."""

    breach_type: BreachType = BreachType.SPREAD_WIDE

    @property
    def guards_exits(self) -> bool:
        """A wide spread makes an exit expensive. Staying in is more expensive."""
        return False

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

    @property
    def guards_exits(self) -> bool:
        """Thin volume is a reason not to arrive, not a reason to stay."""
        return False

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


@dataclass(frozen=True, slots=True)
class ExitQuantityCheck:
    """An exit may not be for more than the book says is open.

    The one check that exists *for* exits rather than in spite of them. It
    bounds the exit against the engine's own book — gross on the side being
    closed, so two strategies holding opposite positions in the same
    instrument do not cancel each other out — and never against the order,
    because an order claiming a size is exactly what this is guarding against.

    The reference engine reconstructs this from broker net positions with a
    chain of fallbacks, because the exit reaches its validator with no link to
    the trade it closes. Here the book is in process and the number is exact,
    so the fallbacks are not ported.

    A bound of None means the placing path did not supply one, and an exit is
    allowed: refusing an exit because nothing could be checked would strand a
    real position, which is the failure this check is meant to prevent.
    """

    breach_type: BreachType = BreachType.EXIT_QTY_EXCEEDS_POSITION

    @property
    def guards_exits(self) -> bool:
        """It has nothing else to guard."""
        return True

    def __call__(self, context: RiskContext) -> Breach | None:
        open_quantity = context.open_quantity
        if not context.is_exit or open_quantity is None:
            return None
        if context.request.quantity <= open_quantity:
            return None
        return Breach(
            self.breach_type,
            f"exit of {context.request.quantity} exceeds the {open_quantity} open in "
            f"{context.instrument.trading_symbol}",
        )


@dataclass(frozen=True, slots=True)
class PositionQuantityCheck:
    """A cap on how much of one instrument may be held one way at once.

    Measured against what the book holds *plus what it has resting*, because
    the failure this catches is a signal firing twice: the first entry is
    still unfilled, so a check against filled quantity alone sees nothing and
    lets the second through. The reference engine added its own version for
    exactly that.

    Entries only, which `guards_exits` says once for the gate rather than
    this check saying it again for itself: a cap on how much may be taken on
    has nothing to say about an order reducing it.
    """

    breach_type: BreachType = BreachType.POSITION_PER_SYMBOL_EXCEEDED

    @property
    def guards_exits(self) -> bool:
        """A cap on size is about what is taken on."""
        return False

    def __call__(self, context: RiskContext) -> Breach | None:
        limit = context.limits.max_position_quantity_per_symbol
        committed = context.committed_quantity
        if limit is None or committed is None:
            return None
        total = committed + context.request.quantity
        if total <= limit:
            return None
        return Breach(
            self.breach_type,
            f"{committed} already held or resting in {context.instrument.trading_symbol} "
            f"plus {context.request.quantity} more is {total}, past the limit of {limit}",
        )


def default_checks() -> tuple[
    KillSwitchCheck,
    MarketOpenCheck,
    ExitQuantityCheck,
    DailyLossCheck,
    QuoteAvailableCheck,
    PriceNonZeroCheck,
    StaleQuoteCheck,
    OrderQuantityCheck,
    OrderValueCheck,
    PositionQuantityCheck,
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
        ExitQuantityCheck(),
        DailyLossCheck(),
        QuoteAvailableCheck(),
        PriceNonZeroCheck(),
        StaleQuoteCheck(),
        OrderQuantityCheck(),
        OrderValueCheck(),
        PositionQuantityCheck(),
        FreezeQuantityCheck(),
        SpreadCheck(),
        VolumeCheck(),
    )
