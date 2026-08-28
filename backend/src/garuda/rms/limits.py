"""Risk limits.

Configuration, not code. Every value here is something an operator sets from
the Console; none of it is a constant a strategy can talk its way around.

``None`` means "not enforced", and is deliberately explicit. A limit that is
absent because nobody configured it should look different from one deliberately
set to zero.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal

from garuda.domain.money import Money


@dataclass(frozen=True, slots=True)
class RiskLimits:
    """What a trading client, or a strategy on it, is allowed to do."""

    max_order_quantity: int | None = None
    max_order_value: Money | None = None
    max_position_value_per_symbol: Money | None = None
    max_daily_loss: Money | None = None
    #: A quote older than this is not a price, it is a memory.
    stale_quote_after: timedelta | None = timedelta(seconds=30)
    #: Spread as a fraction of the last traded price, e.g. 0.05 for 5%.
    max_spread_fraction: Decimal | None = None
    min_volume: int | None = None

    def merged_with(self, override: RiskLimits) -> RiskLimits:
        """Layer a narrower scope over a wider one.

        Anything the override leaves as None inherits. This is what makes
        system, client and strategy limits compose without a config tree.
        """
        return RiskLimits(
            max_order_quantity=_pick(self.max_order_quantity, override.max_order_quantity),
            max_order_value=_pick(self.max_order_value, override.max_order_value),
            max_position_value_per_symbol=_pick(
                self.max_position_value_per_symbol, override.max_position_value_per_symbol
            ),
            max_daily_loss=_pick(self.max_daily_loss, override.max_daily_loss),
            stale_quote_after=_pick(self.stale_quote_after, override.stale_quote_after),
            max_spread_fraction=_pick(self.max_spread_fraction, override.max_spread_fraction),
            min_volume=_pick(self.min_volume, override.min_volume),
        )


def _pick[T](inherited: T | None, override: T | None) -> T | None:
    return override if override is not None else inherited
