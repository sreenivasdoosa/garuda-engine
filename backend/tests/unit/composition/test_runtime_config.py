"""Rows into the typed definition the engine reads.

What is pinned: a stored code outside the vocabulary is refused with the
strategy's name on it, and the two ways the reference stores a day list
both read.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

from garuda.composition.runtime_config import definition_of, runtime_config_for, terms_of
from garuda.domain.errors import DomainError
from garuda.engine.daycondition import DayCondition
from garuda.engine.vocabulary import TradeMode
from garuda.persistence.models import StrategyConfigRow, StrategyDefinitionsRow, SubscriptionsRow

NOW = dt.datetime(2026, 10, 15, 4, 0, tzinfo=dt.UTC)


def row(**overrides: object) -> StrategyDefinitionsRow:
    values: dict[str, object] = {
        "strategy_name": "straddle",
        "underlying_symbol": "NIFTY",
        "exchange": "NSE",
        "product": "INTRADAY",
        "trade_mode": "OPTION_SELLING",
        "status": "ACTIVE",
        "exclude_monthly_expiry": False,
        "use_premium_balancing": True,
        "catch_up_missed_tranches": True,
        "adaptive_tranches_enabled": False,
        "use_indicator_entry": False,
        "created_at": NOW,
        "updated_at": NOW,
    }
    values.update(overrides)
    return StrategyDefinitionsRow(**values)


def subscription(**overrides: object) -> SubscriptionsRow:
    values: dict[str, object] = {
        "trading_client_id": "appa",
        "strategy_name": "straddle",
        "is_active": True,
        "capital": Decimal(500000),
        "is_paper_trading": False,
    }
    values.update(overrides)
    return SubscriptionsRow(**values)


def test_a_row_reads_into_the_vocabulary() -> None:
    d = definition_of(row(start_time="09:20", stop_time="15:15", tradable_days='["E","DT1"]'))
    assert d.trade_mode is TradeMode.OPTION_SELLING
    assert d.start_time == dt.time(9, 20)
    assert d.tradable_days == frozenset({DayCondition.EXPIRY, DayCondition.ONE_DAY_TO_EXPIRY})


def test_a_comma_separated_day_list_reads_too() -> None:
    d = definition_of(row(excluded_days="E, F"))
    assert d.excluded_days == frozenset({DayCondition.EXPIRY, DayCondition.FRIDAY})


def test_a_code_outside_the_vocabulary_is_refused_by_name() -> None:
    with pytest.raises(DomainError, match="straddle: tradeMode 'SPEC'"):
        definition_of(row(trade_mode="SPEC"))
    with pytest.raises(DomainError, match="tradableDays"):
        definition_of(row(tradable_days='["SATURDAY"]'))
    with pytest.raises(DomainError, match="startTime"):
        definition_of(row(start_time="nine"))


def test_provider_params_and_legs_read_as_objects() -> None:
    d = definition_of(
        row(
            is_directional=True,
            direction_provider_type="fixed",
            direction_provider_params='{"direction": "LONG"}',
            combo_spec_json='{"legs": [{"role": "MAIN"}]}',
        )
    )
    assert d.direction_provider_type == "FIXED"
    assert d.direction_provider_params == {"direction": "LONG"}
    assert d.is_combo


def test_the_runtime_config_only_sees_this_strategys_rows() -> None:
    mine = StrategyConfigRow(strategy_name="straddle", sl_percentage=Decimal(30))
    theirs = StrategyConfigRow(strategy_name="other", sl_percentage=Decimal(99))
    built = runtime_config_for(
        row(), subscription(), [mine, theirs], conditions=frozenset({DayCondition.THURSDAY})
    )
    assert built.base.percent("sl_percentage") == Decimal(30)
    assert built.capital == Decimal(500000)
    assert terms_of(subscription(is_paper_trading=True)).is_paper_trading
