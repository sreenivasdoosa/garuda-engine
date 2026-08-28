"""Per-underlying trading knowledge.

The broker's instrument master says what exists — tokens, expiries, strikes,
lot sizes. It does not say what an underlying *is*: which spot symbol carries
its price, how far apart its strikes sit, how many contracts a lot represents,
or how much the exchange will let you trade at once.

That is operator-curated, per underlying, and it is what makes strike selection
and P&L correct:

* **The spot symbol is not the derivative symbol.** Options on ``NIFTY`` take
  their spot from ``NIFTY 50``. Without the mapping, strike selection has no
  price to select against.
* **A lot is not a unit.** One CRUDEOIL lot is 100 barrels, one NATURALGAS lot
  is 1250 units. A multiplier assumed to be 1 makes every commodity P&L wrong
  by two or three orders of magnitude, and the number still looks plausible.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from garuda.domain.errors import DomainError


@dataclass(frozen=True, slots=True)
class SymbolInfo:
    """What the engine knows about one underlying."""

    symbol: str
    exchange_code: str
    is_index: bool = False
    #: The symbol carrying this underlying's spot price, when it differs from
    #: the symbol itself: NIFTY's spot is published as "NIFTY 50".
    index_symbol: str | None = None
    #: Spacing between adjacent strikes.
    strike_gap: Decimal = Decimal(50)
    #: Units the exchange will accept in one order. Above it, an entry is
    #: sliced.
    freeze_limit_quantity: int | None = None
    #: Units per lot. One for most equity derivatives, and emphatically not
    #: for commodities.
    contract_multiplier: Decimal = Decimal(1)
    #: Strikes either side of at-the-money worth subscribing to.
    option_chain_levels: int = 10
    has_weekly_options: bool = False
    has_monthly_options: bool = True
    has_weekly_futures: bool = False
    has_monthly_futures: bool = True
    #: Rounding applied when placing a hedge strike, where it is coarser than
    #: the strike gap. Zero means use the strike gap.
    hedge_strike_rounding: Decimal = Decimal(0)

    def __post_init__(self) -> None:
        if not self.symbol.strip():
            raise DomainError("symbol info must name a symbol")
        if self.strike_gap <= 0:
            raise DomainError(f"{self.symbol}: strike gap {self.strike_gap} must be positive")
        if self.contract_multiplier <= 0:
            raise DomainError(
                f"{self.symbol}: contract multiplier {self.contract_multiplier} must be positive"
            )
        if self.freeze_limit_quantity is not None and self.freeze_limit_quantity < 1:
            raise DomainError(f"{self.symbol}: freeze limit must be at least one unit")
        if self.option_chain_levels < 1:
            raise DomainError(f"{self.symbol}: option chain levels must be at least one")
        if self.hedge_strike_rounding < 0:
            raise DomainError(f"{self.symbol}: hedge strike rounding cannot be negative")

    @property
    def spot_symbol(self) -> str:
        """Where this underlying's price comes from.

        The index symbol when there is one, the symbol itself otherwise. A
        stock's spot is the stock; an index's spot is a separate feed symbol.
        """
        return self.index_symbol or self.symbol

    @property
    def hedge_strike_step(self) -> Decimal:
        """The multiple a hedge strike is rounded to."""
        return self.hedge_strike_rounding or self.strike_gap

    def strikes_around(self, spot: Decimal, levels: int | None = None) -> list[Decimal]:
        """Strikes either side of the money, at this underlying's spacing."""
        count = self.option_chain_levels if levels is None else levels
        if count < 1:
            raise DomainError(f"{self.symbol}: cannot list {count} strike levels")
        at_the_money = (spot / self.strike_gap).to_integral_value() * self.strike_gap
        return [at_the_money + self.strike_gap * offset for offset in range(-count, count + 1)]
