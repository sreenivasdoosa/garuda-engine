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
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from garuda.domain.enums import InstrumentKind
from garuda.rms.limits import RiskLimits

if TYPE_CHECKING:
    from collections.abc import Sequence

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


@dataclass(frozen=True)
class LimitBook:
    """Every configured row, resolved per order.

    Held whole rather than resolved once at startup, because an account trades
    several instruments and the row that applies to a crude option is not the
    row that applies to a Nifty one.
    """

    rows: Sequence[ScopedLimits] = field(default_factory=tuple)

    def for_(self, instrument: Instrument, trading_client: TradingClientId) -> RiskLimits:
        """The limits in force, widest merged under narrowest.

        Nothing configured means nothing enforced, and it says so once rather
        than on every order: an engine with no risk rows is a real state on a
        fresh install, not a fault.
        """
        applicable = sorted(
            (row for row in self.rows if row.scope.matches(instrument, trading_client)),
            key=lambda row: row.scope.specificity,
        )
        if not applicable:
            return RiskLimits()

        resolved = applicable[0].limits
        for row in applicable[1:]:
            resolved = resolved.merged_with(row.limits)
        return resolved

    def __len__(self) -> int:
        return len(self.rows)


#: What an engine holds when nothing is configured. Every limit unenforced,
#: which is what an empty table means and is stated rather than implied.
NO_LIMITS = LimitBook()
