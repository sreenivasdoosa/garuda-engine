"""Which limits apply to which order.

The reference engine keeps one `rms_config` table holding rows at several
scopes at once — a global default, a whole exchange, one account, one
underlying — with a segment narrowing any of them. The narrowest row that
applies wins, field by field, so a row saying only "options on crude oil need
five thousand lots of volume" inherits everything else from the global row
rather than blanking it.

**The `config_level` label is not the scope.** In the reference's own data a
row labelled `SYMBOL` carries no symbol and a row labelled `GLOBAL` names an
exchange; the label was never what the resolution read. Specificity here comes
from which scope columns are actually populated, which is the only thing that
cannot disagree with itself.

**No row is unscoped by segment there either.** Every row in the reference
names one — equity, futures or options — which is exactly why reading "the
global row" and taking the first of them silently applied equity limits to an
options order.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING

from garuda.domain.enums import InstrumentKind
from garuda.rms.limits import RiskLimits

if TYPE_CHECKING:
    from collections.abc import Iterable, Sequence

    from garuda.domain.client import TradingClientId
    from garuda.domain.instrument import Instrument

logger = logging.getLogger(__name__)

#: What the reference calls a segment in this table, mapped to what garuda
#: calls an instrument kind. The names diverge because `Segment` here means
#: the venue's segment -- equity, F&O, currency, commodity -- and the column
#: means the sort of contract. An options row on MCX is `COMMODITY` by segment
#: and `OPTION` by kind, and it is the kind the row is about.
SEGMENT_KINDS: dict[str, InstrumentKind] = {
    "EQUITY": InstrumentKind.EQUITY,
    "FUTURES": InstrumentKind.FUTURE,
    "FUTURE": InstrumentKind.FUTURE,
    "OPTIONS": InstrumentKind.OPTION,
    "OPTION": InstrumentKind.OPTION,
    "INDEX": InstrumentKind.INDEX,
}


@dataclass(frozen=True, slots=True)
class LimitScope:
    """What one row of limits applies to. Every field is a wildcard when None."""

    exchange: str | None = None
    trading_client: str | None = None
    symbol: str | None = None
    kind: InstrumentKind | None = None

    def matches(self, instrument: Instrument, trading_client: TradingClientId) -> bool:
        if self.exchange is not None and self.exchange != instrument.exchange.code:
            return False
        if self.trading_client is not None and self.trading_client != trading_client.value:
            return False
        if self.kind is not None and self.kind is not instrument.kind:
            return False
        return self.symbol is None or self.symbol in names_of(instrument)

    @property
    def specificity(self) -> int:
        """How narrow this scope is. Higher wins.

        One underlying beats one account, which beats one exchange, which
        beats a segment on its own — a segment narrows the others rather than
        standing against them, which is why it is worth the least.
        """
        return (
            (8 if self.symbol is not None else 0)
            + (4 if self.trading_client is not None else 0)
            + (2 if self.exchange is not None else 0)
            + (1 if self.kind is not None else 0)
        )


def names_of(instrument: Instrument) -> tuple[str, ...]:
    """What a symbol-scoped row could plausibly name.

    A row saying CRUDEOIL is about every crude option, not about one strike,
    so the underlying counts as well as the trading symbol itself.
    """
    names = [instrument.trading_symbol]
    if instrument.underlying is not None:
        names.append(instrument.underlying.value.rpartition(":")[2])
    return tuple(names)


@dataclass(frozen=True, slots=True)
class ScopedLimits:
    """One row: limits, and what they apply to."""

    scope: LimitScope
    limits: RiskLimits


class LimitBook:
    """Every configured row, resolved per order.

    Held whole rather than resolved once at startup, because an account trades
    several instruments and the row that applies to a crude option is not the
    row that applies to a Nifty one. And held as a book rather than a value:
    the RMS Config page swaps its rows while the engine runs, and every
    account's placement reads the same book on each order.
    """

    def __init__(self, rows: Sequence[ScopedLimits] = ()) -> None:
        self._rows: tuple[ScopedLimits, ...] = tuple(rows)
        self.version = 0

    @property
    def rows(self) -> tuple[ScopedLimits, ...]:
        return self._rows

    def for_(self, instrument: Instrument, trading_client: TradingClientId) -> RiskLimits:
        """The limits in force, widest merged under narrowest.

        Nothing configured means nothing enforced, and it says so once rather
        than on every order: an engine with no risk rows is a real state on a
        fresh install, not a fault.
        """
        applicable = sorted(
            (row for row in self._rows if row.scope.matches(instrument, trading_client)),
            key=lambda row: row.scope.specificity,
        )
        if not applicable:
            return RiskLimits()

        resolved = applicable[0].limits
        for row in applicable[1:]:
            resolved = resolved.merged_with(row.limits)
        return resolved

    def replace(self, rows: Sequence[ScopedLimits]) -> None:
        """Take the table whole: a deleted row has to stop applying."""
        self._rows = tuple(rows)
        self.version += 1

    def __len__(self) -> int:
        return len(self._rows)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, LimitBook) and other._rows == self._rows

    __hash__ = None  # type: ignore[assignment]


#: What a placement holds when it was wired without a book. Every limit
#: unenforced, which is what an empty table means. Shared, so never replaced
#: into: an engine the Console can reconfigure builds its own book.
NO_LIMITS = LimitBook()


#: The scopes a row can be at, named by its narrowest populated column. The
#: reference's `config_level` vocabulary with its broker and user levels
#: folded into the trading client, which is what a limit belongs to here.
LEVELS: tuple[str, ...] = ("GLOBAL", "EXCHANGE", "SYMBOL", "CLIENT")


def level_of(*, exchange: str | None, trading_client: str | None, symbol: str | None) -> str:
    """Which scope a row is at, read from its columns rather than its label."""
    if trading_client:
        return "CLIENT"
    if symbol:
        return "SYMBOL"
    if exchange:
        return "EXCHANGE"
    return "GLOBAL"


#: Which columns mean something at which scope, ported from the reference's
#: field applicability table. A column not listed applies everywhere. The
#: reference nulls an inapplicable column at merge time; garuda drops it when
#: the row is written and again when it is loaded, so a rate limit on a
#: symbol row -- which the reference would silently ignore -- is never read.
_EXCHANGE_POLICY = frozenset({"GLOBAL", "EXCHANGE"})
_ACCOUNT_POLICY = frozenset({"GLOBAL", "CLIENT"})
APPLICABLE_AT: dict[str, frozenset[str]] = {
    # Price validation: exchange timing.
    "stale_price_seconds": _EXCHANGE_POLICY,
    "early_market_grace_seconds": _EXCHANGE_POLICY,
    "min_volume_early_period_seconds": _EXCHANGE_POLICY,
    # Order limits: exchange policy.
    "enable_freeze_qty_check": _EXCHANGE_POLICY,
    # Rate limits: the broker's and the account's.
    "max_orders_per_second": _ACCOUNT_POLICY,
    "max_order_operations_per_second": _ACCOUNT_POLICY,
    "max_orders_per_minute": _ACCOUNT_POLICY,
    "max_orders_per_day": _ACCOUNT_POLICY,
    # Position limits: portfolio aggregates.
    "max_total_positions": _ACCOUNT_POLICY,
    "max_total_combos": _ACCOUNT_POLICY,
    "max_buy_orders_per_day": _ACCOUNT_POLICY,
    "max_sell_orders_per_day": _ACCOUNT_POLICY,
    # Loss protection: the account's capital.
    "max_daily_loss_amount": _ACCOUNT_POLICY,
    "max_daily_loss_pct": _ACCOUNT_POLICY,
    "enable_auto_kill_on_loss": _ACCOUNT_POLICY,
    "auto_square_off_on_breach": _ACCOUNT_POLICY,
    # Circuit breakers: rejections are per account, volatility is market-wide.
    "max_rejection_rate_pct": _ACCOUNT_POLICY,
    "max_vix_level": _EXCHANGE_POLICY,
    "volatility_pause_minutes": _EXCHANGE_POLICY,
}


def inapplicable(level: str, columns: Iterable[str]) -> list[str]:
    """Which of these columns mean nothing at this scope."""
    return [name for name in columns if level not in APPLICABLE_AT.get(name, frozenset(LEVELS))]


#: The columns the gate enforces today, which is what the composition root
#: maps onto `RiskLimits`. Every other column on the row is stored for a
#: check not yet built, and the Console says so rather than let an operator
#: believe it took effect.
ENFORCED_COLUMNS = frozenset(
    {
        "max_order_qty",
        "max_order_value",
        "max_daily_loss_amount",
        "max_position_qty_per_symbol",
        "max_orders_per_second",
        "max_orders_per_minute",
        "max_orders_per_day",
        "max_orders_per_symbol_per_day",
        "stale_price_seconds",
        "max_bid_ask_spread_pct",
        "min_volume_today",
    }
)
