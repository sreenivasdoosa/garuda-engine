"""Reading strategies out of their rows.

Rows in, strategies the loop can run out -- and, as importantly, a strategy
that cannot be read left out **by name** rather than silently absent.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from garuda.composition.strategies import assemble, validate_strategy
from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.engine.daycondition import DayCondition
from garuda.engine.vocabulary import TradeMode
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDaysAllocationRow,
    StrategyDefinitionsRow,
    StrategyIndicatorRulesRow,
    SubscriptionsRow,
)

ENTRY_TREE = (
    '{"type": "operator", "operator": "AND", "children": [{"type": "condition", '
    '"condition": {"indicator": "RSI", "comparator": "GREATER_THAN", "value": 50, '
    '"params": {"period": 14}, "interval": "5minute"}}]}'
)


def definition(**overrides: Any) -> StrategyDefinitionsRow:
    defaults: dict[str, Any] = {
        "strategy_id": 1,
        "strategy_name": "straddle",
        "underlying_symbol": "NIFTY",
        "exchange": "NSE",
        "product": "INTRADAY",
        "trade_mode": "OPTION_SELLING",
        "status": "ACTIVE",
        "is_directional": False,
        "scheduled_trigger_enabled": True,
        "signal_trigger_enabled": False,
        "exclude_monthly_expiry": False,
        "use_premium_balancing": True,
        "catch_up_missed_tranches": True,
        "adaptive_tranches_enabled": False,
        "use_indicator_entry": False,
    }
    return StrategyDefinitionsRow(**{**defaults, **overrides})


def config(**overrides: Any) -> StrategyConfigRow:
    defaults: dict[str, Any] = {"id": 1, "strategy_name": "straddle"}
    return StrategyConfigRow(**{**defaults, **overrides})


def rules(**overrides: Any) -> StrategyIndicatorRulesRow:
    defaults: dict[str, Any] = {"id": 1, "strategy_name": "straddle", "use_indicator_exit": False}
    return StrategyIndicatorRulesRow(**{**defaults, **overrides})


def subscription(**overrides: Any) -> SubscriptionsRow:
    defaults: dict[str, Any] = {
        "subscription_id": 1,
        "trading_client_id": "appa",
        "strategy_name": "straddle",
        "is_active": True,
        "capital": Decimal(500000),
        "is_paper_trading": False,
    }
    return SubscriptionsRow(**{**defaults, **overrides})


class TestTheOrdinaryCase:
    def test_a_strategy_is_read_into_the_vocabulary(self) -> None:
        loaded = assemble([definition()], [], [], [])
        strategy = loaded.strategies["straddle"]
        assert strategy.definition.trade_mode is TradeMode.OPTION_SELLING
        assert strategy.underlying == InstrumentId("NSE:NIFTY")
        assert not strategy.winding_down

    def test_no_legs_are_needed_for_an_option_pair(self) -> None:
        """The shape comes from the trade mode; combo legs are optional."""
        assert "straddle" in assemble([definition(combo_spec_json=None)], [], [], []).strategies

    def test_an_inactive_strategy_is_not_read(self) -> None:
        loaded = assemble([definition(status="INACTIVE")], [], [], [subscription()])
        assert loaded.strategies == {}
        assert loaded.subscriptions == ()

    def test_a_winding_down_strategy_is_read_and_says_so(self) -> None:
        loaded = assemble([definition(status="WIND_DOWN")], [], [], [])
        assert loaded.strategies["straddle"].winding_down

    def test_configuration_merges_per_column_per_day(self) -> None:
        loaded = assemble(
            [definition()],
            [
                config(id=1, sl_percentage=Decimal(30), max_tranches=2),
                config(id=2, day_condition="E", sl_percentage=Decimal(15)),
                config(id=3, tranch_number=2, strike_value="OTM+1"),
            ],
            [],
            [],
        )
        strategy = loaded.strategies["straddle"]
        terms = loaded.subscriptions  # none subscribed; the runtime is built directly
        assert terms == ()
        from garuda.engine.runtime_config import SubscriptionTerms

        runtime = strategy.runtime(
            SubscriptionTerms(trading_client_id=TradingClientId("appa"), capital=Decimal(1)),
            frozenset({DayCondition.EXPIRY}),
        )
        assert runtime.tranche(1).percent("sl_percentage") == Decimal(15)
        assert runtime.tranche(2).text("strike_value") == "OTM+1"
        assert runtime.tranche(2).percent("sl_percentage") == Decimal(15)
        assert runtime.tranche_numbers == (1, 2)

    def test_day_allocation_is_read(self) -> None:
        row = StrategyDaysAllocationRow(
            strategy_name="straddle",
            monday=100,
            tuesday=100,
            wednesday=100,
            thursday=50,
            friday=100,
            expiry_day=25,
            dt1_day=100,
            dt2_day=100,
        )
        loaded = assemble([definition()], [], [], [], [row])
        allocation = loaded.strategies["straddle"].day_allocation
        assert allocation.percentage_for(frozenset({DayCondition.THURSDAY})) == 50
        assert (
            allocation.percentage_for(frozenset({DayCondition.EXPIRY, DayCondition.THURSDAY})) == 25
        )


class TestRefusals:
    def test_a_code_outside_the_vocabulary_leaves_it_out_by_name(self) -> None:
        loaded = assemble([definition(trade_mode="SPEC")], [], [], [subscription()])
        assert "tradeMode" in loaded.refused["straddle"]
        assert loaded.subscriptions == ()

    def test_a_config_choice_outside_the_vocabulary_leaves_it_out(self) -> None:
        loaded = assemble([definition()], [config(strike_type="Nearest")], [], [])
        assert "strike_type" in loaded.refused["straddle"]

    def test_a_directional_strategy_needs_a_known_provider(self) -> None:
        none = assemble([definition(is_directional=True)], [], [], [])
        assert "no direction provider" in none.refused["straddle"]
        unknown = assemble(
            [definition(is_directional=True, direction_provider_type="TEA_LEAVES")], [], [], []
        )
        assert "TEA_LEAVES" in unknown.refused["straddle"]
        fixed = assemble(
            [
                definition(
                    is_directional=True,
                    direction_provider_type="FIXED",
                    direction_provider_params='{"direction": "LONG"}',
                )
            ],
            [],
            [],
            [],
        )
        assert "straddle" in fixed.strategies

    def test_the_signal_trigger_leaves_it_out_until_signals_exist(self) -> None:
        loaded = assemble([definition(signal_trigger_enabled=True)], [], [], [])
        assert "external signals" in loaded.refused["straddle"]

    def test_indicator_entry_without_entry_rules_is_refused(self) -> None:
        loaded = assemble([definition(use_indicator_entry=True)], [], [], [])
        assert "no entry rules" in loaded.refused["straddle"]
        with_rules = assemble(
            [definition(use_indicator_entry=True)], [], [rules(entry_rules_json=ENTRY_TREE)], []
        )
        assert with_rules.strategies["straddle"].entry_rules is not None

    def test_an_unreadable_rule_tree_leaves_it_out(self) -> None:
        loaded = assemble([definition()], [], [rules(entry_rules_json="{not json")], [])
        assert "not readable JSON" in loaded.refused["straddle"]

    def test_one_broken_strategy_does_not_stop_the_others(self) -> None:
        loaded = assemble(
            [definition(), definition(strategy_id=2, strategy_name="broken", trade_mode="X")],
            [],
            [],
            [],
        )
        assert set(loaded.strategies) == {"straddle"}
        assert set(loaded.refused) == {"broken"}


class TestSubscriptions:
    def test_a_subscription_carries_its_terms(self) -> None:
        loaded = assemble([definition()], [], [], [subscription(is_paper_trading=True)])
        (sub,) = loaded.subscriptions
        assert sub.trading_client == TradingClientId("appa")
        assert sub.terms.capital == Decimal(500000)
        assert sub.is_paper
        assert loaded.subscribers("straddle") == (sub,)
        assert loaded.underlyings() == {InstrumentId("NSE:NIFTY")}

    def test_inactive_or_capital_less_subscriptions_are_skipped(self) -> None:
        loaded = assemble(
            [definition()],
            [],
            [],
            [
                subscription(is_active=False),
                subscription(subscription_id=2, trading_client_id="amma", capital=None),
            ],
        )
        assert loaded.subscriptions == ()

    def test_a_subscription_to_a_refused_strategy_is_dropped(self) -> None:
        loaded = assemble([definition(trade_mode="X")], [], [], [subscription()])
        assert loaded.subscriptions == ()


class TestValidateStrategy:
    def test_a_sound_strategy_has_nothing_to_refuse(self) -> None:
        assert validate_strategy(definition(), [], None) is None

    def test_a_refusal_comes_back_as_the_reason(self) -> None:
        reason = validate_strategy(definition(), [config(exit_mode="WHENEVER")], None)
        assert reason is not None
        assert "exit_mode" in reason

    def test_an_inactive_strategy_is_not_built_and_so_not_refused(self) -> None:
        assert validate_strategy(definition(status="INACTIVE", trade_mode="X"), [], None) is None
