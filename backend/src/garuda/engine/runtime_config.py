"""The configuration one subscription trades with on one day.

`STRATEGY_ENGINE.md` §2. Built in the reference engine's order, so that every
evaluation reads one object and the order never has to be reconstructed at
09:20:

1. engine defaults;
2. the definition's columns;
3. the subscription: its capital, and its risk and leverage overrides
   **clamped** to the definition's minimum and maximum;
4. the config tree for the day, merged per column;
5. one resolved configuration per tranche, the base-and-day rows standing in
   for any tranche that has no row of its own.

Pure: a definition, a subscription's terms and the configuration layers in,
a `RuntimeConfig` out. Nothing here reads a table or a clock, which is what
lets the whole order be pinned by a test with three dataclasses.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.daycondition import DayCondition
from garuda.engine.vocabulary import (
    EquitySizingModel,
    ExpiryType,
    OnIndexRemoval,
    StrategyProduct,
    StrategyStatus,
    TradeMode,
    UnderlyingType,
)

#: The reference's defaults where its definition leaves a value unset.
DEFAULT_HEDGE_DISTANCE_INTRADAY = Decimal("4.0")
DEFAULT_HEDGE_DISTANCE_POSITIONAL = Decimal("1.0")
DEFAULT_HEDGE_MORNING_START_OFFSET = 1
DEFAULT_HEDGE_MORNING_END_OFFSET = 15
DEFAULT_HEDGE_EVENING_START_OFFSET = 10
DEFAULT_HEDGE_EVENING_END_OFFSET = 2
#: Between two tranches, in minutes, when the configuration says nothing.
DEFAULT_MIN_TRANCHE_GAP = 1


@dataclass(frozen=True)
class Definition:
    """A strategy definition as the engine reads it: typed, parsed, refused
    at build if a stored value is outside the vocabulary.

    Everything the reference's `StrategyRuntimeConfig` takes from
    `STRATEGY_DEFINITIONS`, by the same names, minus what garuda dropped
    (`SCOPE_DECISIONS.md` §5a).
    """

    name: str
    exchange: str
    underlying_symbol: str
    trade_mode: TradeMode
    product: StrategyProduct
    status: StrategyStatus
    underlying_type: UnderlyingType = UnderlyingType.INDEX
    expiry_type: ExpiryType = ExpiryType.WEEKLY
    exclude_monthly_expiry: bool = False
    use_premium_balancing: bool = True

    scheduled_trigger: bool = True
    tick_trigger: bool = False
    periodic_trigger: bool = False
    signal_trigger: bool = False
    periodic_interval_minutes: int | None = None
    periodic_offset_seconds: int | None = None

    start_time: dt.time | None = None
    stop_time: dt.time | None = None
    tradable_days: frozenset[DayCondition] = frozenset()
    excluded_days: frozenset[DayCondition] = frozenset()

    capital_per_lot: int | None = None
    capital_per_lot_hedged: int | None = None
    capital_per_lot_naked: int | None = None
    is_overlap_capital: bool = False

    hedge_distance_intraday: Decimal = DEFAULT_HEDGE_DISTANCE_INTRADAY
    hedge_distance_positional: Decimal = DEFAULT_HEDGE_DISTANCE_POSITIONAL
    hedge_replace_enabled: bool = False
    hedge_morning_start_offset: int = DEFAULT_HEDGE_MORNING_START_OFFSET
    hedge_morning_end_offset: int = DEFAULT_HEDGE_MORNING_END_OFFSET
    hedge_evening_start_offset: int = DEFAULT_HEDGE_EVENING_START_OFFSET
    hedge_evening_end_offset: int = DEFAULT_HEDGE_EVENING_END_OFFSET

    is_directional: bool = False
    direction_provider_type: str | None = None
    direction_provider_params: Mapping[str, object] = field(default_factory=dict)

    catch_up_missed_tranches: bool = True
    adaptive_tranches_enabled: bool = False
    use_indicator_entry: bool = False
    strategy_class: str | None = None

    risk_percentage: Decimal | None = None
    absolute_max_risk: Decimal | None = None
    min_risk_percentage: Decimal | None = None
    max_risk_percentage: Decimal | None = None

    leverage: Decimal | None = None
    min_leverage: Decimal | None = None
    max_leverage: Decimal | None = None
    universe_id: int | None = None
    equity_sizing_model: EquitySizingModel | None = None
    fixed_amount_per_stock: Decimal | None = None
    max_active_positions: int | None = None
    max_risk_pct_per_trade: Decimal | None = None
    on_index_removal: OnIndexRemoval | None = None

    combo_spec: Mapping[str, object] | None = None
    entry_leg_order: str | None = None
    exit_leg_order: str | None = None

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise DomainError("a strategy definition needs a name")
        if self.start_time and self.stop_time and self.stop_time <= self.start_time:
            raise DomainError(
                f"{self.name}: stop time {self.stop_time:%H:%M} is not after "
                f"start time {self.start_time:%H:%M}"
            )
        if self.periodic_trigger and not self.periodic_interval_minutes:
            raise DomainError(f"{self.name}: a periodic trigger needs an interval")
        if self.periodic_interval_minutes is not None and not (
            1 <= self.periodic_interval_minutes <= 240
        ):
            raise DomainError(
                f"{self.name}: periodic interval {self.periodic_interval_minutes} is not "
                "between 1 and 240 minutes"
            )
        if self.periodic_offset_seconds is not None and not (
            0 <= self.periodic_offset_seconds <= 15
        ):
            raise DomainError(
                f"{self.name}: periodic offset {self.periodic_offset_seconds} is not "
                "between 0 and 15 seconds"
            )
        if self.is_directional and not self.direction_provider_type:
            raise DomainError(
                f"{self.name} is directional but names no direction provider; it is "
                "left out rather than traded in a direction nobody chose"
            )
        if _inverted(self.min_risk_percentage, self.max_risk_percentage):
            raise DomainError(f"{self.name}: minimum risk is above maximum risk")
        if _inverted(self.min_leverage, self.max_leverage):
            raise DomainError(f"{self.name}: minimum leverage is above maximum leverage")

    def capital_per_lot_for(self, *, hedged: bool) -> int | None:
        """What one lot costs: the hedged or naked figure, falling back to
        the plain one, as the reference does."""
        specific = self.capital_per_lot_hedged if hedged else self.capital_per_lot_naked
        if specific is not None and specific > 0:
            return specific
        if self.capital_per_lot is not None and self.capital_per_lot > 0:
            return self.capital_per_lot
        return None

    def hedge_distance_for(self, product: StrategyProduct) -> Decimal:
        if product is StrategyProduct.POSITIONAL:
            return self.hedge_distance_positional
        return self.hedge_distance_intraday

    @property
    def is_equity(self) -> bool:
        return self.trade_mode is TradeMode.EQUITY

    @property
    def is_combo(self) -> bool:
        return bool(self.combo_spec)

    def can_trade_on(self, conditions: frozenset[DayCondition]) -> bool:
        """The reference's `canTradeToday` day rules: the blacklist wins, then
        the whitelist when there is one."""
        if self.excluded_days & conditions:
            return False
        if self.tradable_days:
            return bool(self.tradable_days & conditions)
        return True


@dataclass(frozen=True)
class SubscriptionTerms:
    """What one trading client's subscription contributes, before clamping."""

    trading_client_id: TradingClientId
    capital: Decimal | None = None
    is_paper_trading: bool = False
    risk_percentage: Decimal | None = None
    absolute_max_risk: Decimal | None = None
    leverage: Decimal | None = None
    max_active_positions: int | None = None


@dataclass(frozen=True)
class RuntimeConfig:
    """Everything one subscription's evaluation reads, for one day."""

    definition: Definition
    subscription: SubscriptionTerms
    conditions: frozenset[DayCondition]
    #: The base-and-day rows merged: what any tranche without its own row
    #: uses, and where the strategy-wide settings (`max_tranches`, the gaps)
    #: are read from.
    base: ResolvedConfig
    #: Each tranche's own merge, by tranche number, for the tranches that
    #: have rows.
    tranche_configs: Mapping[int, ResolvedConfig]
    #: The subscription's overrides after the reference's clamps.
    capital: Decimal | None
    risk_percentage: Decimal | None
    absolute_max_risk: Decimal | None
    leverage: Decimal | None
    max_active_positions: int | None

    @property
    def strategy(self) -> str:
        return self.definition.name

    @property
    def tranche_numbers(self) -> tuple[int, ...]:
        """The tranches this strategy has today, numbered from one.

        Every tranche with a row of its own, extended up to `max_tranches`
        when that is larger. A strategy with neither has one tranche: the
        single-entry case wearing the same clothes as the multi-entry one.
        """
        numbered = set(self.tranche_configs)
        cap = self.base.whole("max_tranches")
        if cap is not None and cap > 0:
            numbered.update(range(1, cap + 1))
        return tuple(sorted(numbered)) or (1,)

    def tranche(self, number: int) -> ResolvedConfig:
        """One tranche's configuration, or the default when it has no row."""
        if number < 1:
            raise DomainError(
                f"{self.strategy}: tranche {number} is not a tranche; they start at 1"
            )
        return self.tranche_configs.get(number, self.base)

    @property
    def risk_allocation_enabled(self) -> bool:
        """Sized by risk rather than margin alone, as the reference decides it."""
        return bool(
            (self.risk_percentage is not None and self.risk_percentage > 0)
            or (self.absolute_max_risk is not None and self.absolute_max_risk > 0)
        )

    @property
    def min_tranche_gap(self) -> int:
        return self.base.whole("min_tranch_gap") or DEFAULT_MIN_TRANCHE_GAP

    @property
    def tranche_gap(self) -> int | None:
        return self.base.whole("tranch_gap")


def build_runtime_config(
    definition: Definition,
    subscription: SubscriptionTerms,
    layers: Sequence[ConfigLayer],
    *,
    conditions: frozenset[DayCondition],
) -> RuntimeConfig:
    """The reference's merge, steps 2 to 5 (`STRATEGY_ENGINE.md` §2)."""
    if subscription.capital is not None and subscription.capital < 0:
        raise DomainError(f"{definition.name}: capital {subscription.capital} is negative")
    base = resolve(definition.name, layers, tranche=None, conditions=conditions)
    numbered = sorted({layer.tranche for layer in layers if layer.tranche is not None})
    tranches = {
        number: resolve(definition.name, layers, tranche=number, conditions=conditions)
        for number in numbered
    }
    return RuntimeConfig(
        definition=definition,
        subscription=subscription,
        conditions=conditions,
        base=base,
        tranche_configs=tranches,
        capital=_positive(subscription.capital),
        risk_percentage=_clamped(
            _positive(subscription.risk_percentage) or definition.risk_percentage,
            definition.min_risk_percentage,
            definition.max_risk_percentage,
        ),
        absolute_max_risk=_positive(subscription.absolute_max_risk) or definition.absolute_max_risk,
        leverage=_clamped(
            _positive(subscription.leverage) or definition.leverage,
            definition.min_leverage,
            definition.max_leverage,
        ),
        max_active_positions=(
            subscription.max_active_positions
            if subscription.max_active_positions is not None
            and subscription.max_active_positions > 0
            else definition.max_active_positions
        ),
    )


def _inverted(low: Decimal | None, high: Decimal | None) -> bool:
    return low is not None and high is not None and low > high


def _positive(value: Decimal | None) -> Decimal | None:
    """The reference ignores an override at or below zero: "unset" and "0"
    both mean "use the strategy's own"."""
    return value if value is not None and value > 0 else None


def _clamped(value: Decimal | None, low: Decimal | None, high: Decimal | None) -> Decimal | None:
    if value is None:
        return None
    if low is not None and value < low:
        return low
    if high is not None and value > high:
        return high
    return value
