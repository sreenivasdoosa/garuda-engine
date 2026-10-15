"""Rows to the configuration one subscription trades with.

The engine's `build_runtime_config` is pure and typed; this is where a
definition row and a subscription row become the typed values it takes.
Every stored code is parsed through the vocabulary here, so a value outside
it is refused with the strategy's name on it rather than read as text and
misunderstood later.
"""

from __future__ import annotations

import datetime as dt
import json
from collections.abc import Mapping, Sequence

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.engine.config import ConfigLayer
from garuda.engine.daycondition import DayCondition
from garuda.engine.runtime_config import (
    DEFAULT_HEDGE_DISTANCE_INTRADAY,
    DEFAULT_HEDGE_DISTANCE_POSITIONAL,
    DEFAULT_HEDGE_EVENING_END_OFFSET,
    DEFAULT_HEDGE_EVENING_START_OFFSET,
    DEFAULT_HEDGE_MORNING_END_OFFSET,
    DEFAULT_HEDGE_MORNING_START_OFFSET,
    Definition,
    RuntimeConfig,
    SubscriptionTerms,
    build_runtime_config,
)
from garuda.engine.vocabulary import (
    EquitySizingModel,
    ExpiryType,
    OnIndexRemoval,
    StrategyProduct,
    StrategyStatus,
    TradeMode,
    UnderlyingType,
)
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDefinitionsRow,
    SubscriptionsRow,
)

#: Columns of the configuration table that are not settings.
NOT_A_SETTING = frozenset(
    {
        "id",
        "priority",
        "strategy_name",
        "tranch_number",
        "day_condition",
        "description",
        "created_at",
        "updated_at",
    }
)


def definition_of(row: StrategyDefinitionsRow) -> Definition:
    """A definition row, parsed and refused if any code is outside the
    vocabulary."""
    name = row.strategy_name
    return Definition(
        name=name,
        exchange=row.exchange,
        underlying_symbol=row.underlying_symbol,
        trade_mode=TradeMode.parse(row.trade_mode, field=f"{name}: tradeMode"),
        product=StrategyProduct.parse(row.product or "INTRADAY", field=f"{name}: product"),
        status=StrategyStatus.parse(row.status, field=f"{name}: status"),
        underlying_type=UnderlyingType.parse(
            row.underlying_type or "INDEX", field=f"{name}: underlyingType"
        ),
        expiry_type=ExpiryType.parse(row.expiry_type or "WEEKLY", field=f"{name}: expiryType"),
        exclude_monthly_expiry=bool(row.exclude_monthly_expiry),
        use_premium_balancing=bool(row.use_premium_balancing),
        scheduled_trigger=_flag(row.scheduled_trigger_enabled, default=True),
        tick_trigger=_flag(row.tick_trigger_enabled),
        periodic_trigger=_flag(row.periodic_trigger_enabled),
        signal_trigger=_flag(row.signal_trigger_enabled),
        periodic_interval_minutes=row.periodic_interval_minutes,
        periodic_offset_seconds=row.periodic_offset_seconds,
        start_time=_clock_time(name, "startTime", row.start_time),
        stop_time=_clock_time(name, "stopTime", row.stop_time),
        tradable_days=_days(name, "tradableDays", row.tradable_days),
        excluded_days=_days(name, "excludedDays", row.excluded_days),
        capital_per_lot=row.capital_per_lot,
        capital_per_lot_hedged=row.capital_per_lot_hedged,
        capital_per_lot_naked=row.capital_per_lot_naked,
        is_overlap_capital=_flag(row.is_overlap_capital),
        hedge_distance_intraday=_or(
            row.hedge_distance_percentage_intraday, DEFAULT_HEDGE_DISTANCE_INTRADAY
        ),
        hedge_distance_positional=_or(
            row.hedge_distance_percentage_positional, DEFAULT_HEDGE_DISTANCE_POSITIONAL
        ),
        hedge_replace_enabled=_flag(row.hedge_replace_enabled),
        hedge_morning_start_offset=_or(
            row.hedge_morning_start_offset, DEFAULT_HEDGE_MORNING_START_OFFSET
        ),
        hedge_morning_end_offset=_or(
            row.hedge_morning_end_offset, DEFAULT_HEDGE_MORNING_END_OFFSET
        ),
        hedge_evening_start_offset=_or(
            row.hedge_evening_start_offset, DEFAULT_HEDGE_EVENING_START_OFFSET
        ),
        hedge_evening_end_offset=_or(
            row.hedge_evening_end_offset, DEFAULT_HEDGE_EVENING_END_OFFSET
        ),
        is_directional=_flag(row.is_directional),
        direction_provider_type=(row.direction_provider_type or "").strip().upper() or None,
        direction_provider_params=_object(
            name, "directionProviderParams", row.direction_provider_params
        ),
        catch_up_missed_tranches=bool(row.catch_up_missed_tranches),
        adaptive_tranches_enabled=bool(row.adaptive_tranches_enabled),
        use_indicator_entry=bool(row.use_indicator_entry),
        strategy_class=(row.strategy_class or "").strip() or None,
        risk_percentage=row.risk_percentage,
        absolute_max_risk=row.absolute_max_risk,
        min_risk_percentage=row.min_risk_percentage,
        max_risk_percentage=row.max_risk_percentage,
        leverage=row.leverage,
        min_leverage=row.min_leverage,
        max_leverage=row.max_leverage,
        universe_id=row.universe_id,
        equity_sizing_model=(
            EquitySizingModel.parse(row.equity_sizing_model, field=f"{name}: equitySizingModel")
            if row.equity_sizing_model
            else None
        ),
        fixed_amount_per_stock=row.fixed_amount_per_stock,
        max_active_positions=row.max_active_positions,
        max_risk_pct_per_trade=row.max_risk_pct_per_trade,
        on_index_removal=(
            OnIndexRemoval.parse(row.on_index_removal, field=f"{name}: onIndexRemoval")
            if row.on_index_removal
            else None
        ),
        combo_spec=_object(name, "comboSpec", row.combo_spec_json) or None,
        entry_leg_order=(row.entry_leg_order or "").strip() or None,
        exit_leg_order=(row.exit_leg_order or "").strip() or None,
    )


def terms_of(row: SubscriptionsRow) -> SubscriptionTerms:
    return SubscriptionTerms(
        trading_client_id=TradingClientId(row.trading_client_id),
        capital=row.capital,
        is_paper_trading=bool(row.is_paper_trading),
        risk_percentage=row.risk_percentage,
        absolute_max_risk=row.absolute_max_risk,
        leverage=row.leverage,
        max_active_positions=row.max_active_positions,
    )


def layer_of(row: StrategyConfigRow) -> ConfigLayer:
    """One configuration row, reduced to the fields it actually sets.

    A null means "not set at this scope" and must not be carried, or it would
    override a broader scope with nothing.
    """
    values = {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
        if column.name not in NOT_A_SETTING and getattr(row, column.name) is not None
    }
    return ConfigLayer(
        values=values,
        tranche=row.tranch_number,
        day_condition=(DayCondition.parse(row.day_condition) if row.day_condition else None),
    )


def runtime_config_for(
    definition: StrategyDefinitionsRow,
    subscription: SubscriptionsRow,
    configs: Sequence[StrategyConfigRow],
    *,
    conditions: frozenset[DayCondition],
) -> RuntimeConfig:
    """The configuration this subscription trades with today."""
    rows = [row for row in configs if row.strategy_name == definition.strategy_name]
    return build_runtime_config(
        definition_of(definition),
        terms_of(subscription),
        [layer_of(row) for row in rows],
        conditions=conditions,
    )


def _flag(value: bool | None, *, default: bool = False) -> bool:
    return default if value is None else bool(value)


def _or[T](value: T | None, default: T) -> T:
    return default if value is None else value


def _clock_time(strategy: str, field: str, value: str | None) -> dt.time | None:
    text = (value or "").strip()
    if not text:
        return None
    try:
        return dt.time.fromisoformat(text)
    except ValueError:
        raise DomainError(f"{strategy}: {field} {text!r} is not a time of day (HH:MM)") from None


def _days(strategy: str, field: str, value: str | None) -> frozenset[DayCondition]:
    """A day list as the reference stores it: a JSON array, or a comma-separated
    list, of day-condition codes."""
    text = (value or "").strip()
    if not text:
        return frozenset()
    codes: list[str]
    if text.startswith("["):
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            raise DomainError(f"{strategy}: {field} is not readable JSON") from None
        if not isinstance(parsed, list):
            raise DomainError(f"{strategy}: {field} is not a list of day conditions")
        codes = [str(code) for code in parsed]
    else:
        codes = text.split(",")
    try:
        return frozenset(DayCondition.parse(code) for code in codes if code.strip())
    except DomainError as error:
        raise DomainError(f"{strategy}: {field} — {error}") from None


def _object(strategy: str, field: str, value: str | None) -> Mapping[str, object]:
    text = (value or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise DomainError(f"{strategy}: {field} is not readable JSON ({error})") from None
    if not isinstance(parsed, Mapping):
        raise DomainError(f"{strategy}: {field} is not a JSON object")
    return dict(parsed)


__all__ = [
    "NOT_A_SETTING",
    "definition_of",
    "layer_of",
    "runtime_config_for",
    "terms_of",
]
