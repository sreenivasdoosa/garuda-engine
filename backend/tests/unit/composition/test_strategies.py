"""Reading strategies out of their rows.

Rows in, runnable subscriptions out — and, just as importantly, a strategy
that cannot be read left out **by name** rather than silently absent.
"""

from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

from garuda.composition.strategies import assemble
from garuda.domain import Currency, ProductType
from garuda.domain.enums import OptionType
from garuda.domain.intent import LegRole
from garuda.engine.daycondition import DayCondition
from garuda.engine.selectors import OptionStrikeSelector
from garuda.engine.spec import SideRule
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDefinitionsRow,
    StrategyIndicatorRulesRow,
    SubscriptionsRow,
)

STRADDLE_LEGS = {
    "legs": [
        {
            "role": "MAIN",
            "side": "ALWAYS_SHORT",
            "sequence": 0,
            "instrument": {"type": "option_strike", "option_type": "CALL", "moneyness": "ATM"},
        },
        {
            "role": "MAIN",
            "side": "ALWAYS_SHORT",
            "sequence": 1,
            "instrument": {"type": "option_strike", "option_type": "PUT", "moneyness": "ATM"},
        },
    ]
}


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
        "combo_spec_json": json.dumps(STRADDLE_LEGS),
        "tick_trigger_enabled": False,
        "scheduled_trigger_enabled": True,
        "signal_trigger_enabled": False,
        "periodic_trigger_enabled": False,
        "exclude_monthly_expiry": False,
        "use_premium_balancing": True,
        "catch_up_missed_tranches": True,
        "adaptive_tranches_enabled": False,
    }
    return StrategyDefinitionsRow(**{**defaults, **overrides})


def config(**overrides: Any) -> StrategyConfigRow:
    defaults: dict[str, Any] = {"id": 1, "strategy_name": "straddle"}
    return StrategyConfigRow(**{**defaults, **overrides})


def rules(**overrides: Any) -> StrategyIndicatorRulesRow:
    defaults: dict[str, Any] = {
        "id": 1,
        "strategy_name": "straddle",
        "use_indicator_exit": False,
    }
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


# -- the ordinary case ------------------------------------------------------


def test_a_strategy_is_read_from_its_definition() -> None:
    loaded = assemble([definition()], [], [], [])

    spec = loaded.strategies["straddle"].spec
    assert spec.underlying.value == "NSE:NIFTY"
    assert len(spec.legs) == 2


def test_the_legs_come_out_as_selectors() -> None:
    loaded = assemble([definition()], [], [], [])

    first = loaded.strategies["straddle"].spec.entry_order[0]
    assert isinstance(first.selector, OptionStrikeSelector)
    assert first.selector.option_type is OptionType.CALL
    assert first.side is SideRule.ALWAYS_SHORT
    assert first.role is LegRole.MAIN


def test_a_moneyness_is_read_not_left_as_text() -> None:
    """Left as text it would compare unequal to every member and take the
    wrong branch, which is the failure that looks most like working."""
    legs = {
        "legs": [
            {
                "instrument": {
                    "type": "option_strike",
                    "option_type": "CALL",
                    "moneyness": "OTM+2",
                }
            }
        ]
    }
    loaded = assemble([definition(combo_spec_json=json.dumps(legs))], [], [], [])

    selector = loaded.strategies["straddle"].spec.legs[0].selector
    assert isinstance(selector, OptionStrikeSelector)
    assert selector.moneyness.steps == 2


def test_a_hedged_strategy_reads_both_sides_and_their_order() -> None:
    """One spec, two side rules, hedge first — and none of it defaulted."""
    legs = {
        "legs": [
            {
                "role": "HEDGE",
                "side": "ALWAYS_LONG",
                "sequence": 0,
                "instrument": {
                    "type": "option_strike",
                    "option_type": "CALL",
                    "moneyness": "OTM+3",
                },
            },
            {
                "role": "MAIN",
                "side": "ALWAYS_SHORT",
                "sequence": 1,
                "instrument": {"type": "option_strike", "option_type": "CALL"},
            },
        ]
    }
    loaded = assemble([definition(combo_spec_json=json.dumps(legs))], [], [], [])

    ordered = loaded.strategies["straddle"].spec.entry_order
    assert [leg.role for leg in ordered] == [LegRole.HEDGE, LegRole.MAIN]
    assert [leg.side for leg in ordered] == [SideRule.ALWAYS_LONG, SideRule.ALWAYS_SHORT]
    assert [leg.sequence for leg in ordered] == [0, 1]


def test_a_leg_that_does_not_say_its_order_takes_its_position() -> None:
    """Written order is the obvious intent, and repeating it on every leg is
    the kind of thing an operator gets wrong once."""
    legs = {
        "legs": [
            {"instrument": {"type": "option_strike", "option_type": "PUT"}},
            {"instrument": {"type": "option_strike", "option_type": "CALL"}},
        ]
    }
    loaded = assemble([definition(combo_spec_json=json.dumps(legs))], [], [], [])

    assert [leg.sequence for leg in loaded.strategies["straddle"].spec.legs] == [0, 1]


def test_an_intraday_strategy_trades_intraday() -> None:
    loaded = assemble([definition(product="INTRADAY")], [], [], [])

    assert loaded.strategies["straddle"].spec.legs[0].product is ProductType.MIS


def test_a_positional_strategy_carries_forward() -> None:
    loaded = assemble([definition(product="POSITIONAL")], [], [], [])

    assert loaded.strategies["straddle"].spec.legs[0].product is ProductType.NRML


def test_a_leg_may_override_the_strategy_s_product() -> None:
    """A cash-and-futures pair is two products in one position."""
    legs = {"legs": [{"instrument": {"type": "underlying"}, "product": "CNC"}]}
    loaded = assemble([definition(combo_spec_json=json.dumps(legs))], [], [], [])

    assert loaded.strategies["straddle"].spec.legs[0].product is ProductType.CNC


def test_an_inactive_strategy_is_not_read() -> None:
    loaded = assemble([definition(status="INACTIVE")], [], [], [])

    assert loaded.strategies == {}


# -- rules ------------------------------------------------------------------


def test_entry_rules_are_built_from_their_json() -> None:
    tree = {"type": "all", "rules": [{"type": "at_or_after", "at": "13:00"}]}
    loaded = assemble([definition()], [], [rules(entry_rules_json=json.dumps(tree))], [])

    assert loaded.strategies["straddle"].entry_rules is not None
    assert loaded.refused == {}


def test_a_strategy_with_no_rules_has_no_conditions() -> None:
    """A real thing to configure, and not to be mistaken for broken."""
    loaded = assemble([definition()], [], [], [])

    assert loaded.strategies["straddle"].entry_rules is not None


def test_exit_rules_are_optional() -> None:
    loaded = assemble([definition()], [], [], [])

    assert loaded.strategies["straddle"].exit_rules is None


def test_an_unreadable_rule_tree_leaves_the_strategy_out_by_name() -> None:
    loaded = assemble([definition()], [], [rules(entry_rules_json="{oh dear")], [])

    assert "straddle" not in loaded.strategies
    assert "not readable JSON" in loaded.refused["straddle"]


def test_a_rule_nobody_registered_leaves_the_strategy_out() -> None:
    tree = {"type": "enter_if_i_feel_like_it"}
    loaded = assemble([definition()], [], [rules(entry_rules_json=json.dumps(tree))], [])

    assert "straddle" not in loaded.strategies
    assert "not usable" in loaded.refused["straddle"]


def test_one_broken_strategy_does_not_stop_the_others() -> None:
    good = definition(strategy_id=2, strategy_name="other")
    loaded = assemble([definition(), good], [], [rules(entry_rules_json="{oh dear")], [])

    assert "other" in loaded.strategies
    assert "straddle" in loaded.refused


# -- legs that cannot be read -----------------------------------------------


def test_a_strategy_describing_no_legs_is_left_out() -> None:
    loaded = assemble([definition(combo_spec_json=None)], [], [], [])

    assert "describes no legs" in loaded.refused["straddle"]


def test_a_selector_nobody_registered_leaves_the_strategy_out() -> None:
    legs = {"legs": [{"instrument": {"type": "vibes"}}]}
    loaded = assemble([definition(combo_spec_json=json.dumps(legs))], [], [], [])

    assert "straddle" in loaded.refused


def test_a_directional_strategy_is_left_out_rather_than_guessed_at() -> None:
    """Direction rules are not loaded yet, and trading a directional strategy
    one way that nobody chose is worse than not trading it."""
    loaded = assemble([definition(is_directional=True)], [], [], [])

    assert "direction rules are not loaded" in loaded.refused["straddle"]


# -- configuration ----------------------------------------------------------


def test_configuration_merges_across_its_scopes() -> None:
    layers = [
        config(id=1, sl_percentage=Decimal(30)),
        config(id=2, tranch_number=2, strike_type="MoneyNess"),
    ]
    loaded = assemble([definition()], layers, [], [])

    resolved = loaded.strategies["straddle"].configuration(2, frozenset())
    assert resolved.percent("sl_percentage") == Decimal(30)
    assert resolved.text("strike_type") == "MoneyNess"


def test_a_null_column_does_not_override_a_broader_scope() -> None:
    """The mechanism the whole config tree rests on."""
    layers = [
        config(id=1, sl_percentage=Decimal(30)),
        config(id=2, tranch_number=2, sl_percentage=None),
    ]
    loaded = assemble([definition()], layers, [], [])

    assert loaded.strategies["straddle"].configuration(2, frozenset()).percent(
        "sl_percentage"
    ) == Decimal(30)


def test_a_day_condition_is_read_from_its_code() -> None:
    layers = [config(id=1, day_condition="E", sl_percentage=Decimal(20))]
    loaded = assemble([definition()], layers, [], [])

    on_expiry = loaded.strategies["straddle"].configuration(0, frozenset({DayCondition.EXPIRY}))
    assert on_expiry.percent("sl_percentage") == Decimal(20)


def test_a_day_condition_nobody_recognises_leaves_the_strategy_out() -> None:
    loaded = assemble([definition()], [config(id=1, day_condition="QUARTERLY")], [], [])

    assert "straddle" in loaded.refused


def test_tranches_come_from_the_rows_that_configure_them() -> None:
    layers = [config(id=1, tranch_number=n) for n in (3, 1, 2)]
    loaded = assemble([definition()], layers, [], [])

    assert loaded.strategies["straddle"].tranches == (1, 2, 3)


def test_a_strategy_with_no_tranche_configuration_has_one() -> None:
    """The single-entry case in the same clothes as the multi-entry one."""
    loaded = assemble([definition()], [], [], [])

    assert loaded.strategies["straddle"].tranches == (0,)


# -- subscriptions ----------------------------------------------------------


def test_a_subscription_becomes_something_runnable() -> None:
    loaded = assemble([definition()], [], [], [subscription()])

    assert len(loaded.subscriptions) == 1
    assert loaded.subscriptions[0].capital.amount == Decimal(500000)
    assert loaded.subscriptions[0].capital.currency is Currency.INR


def test_an_inactive_subscription_is_skipped() -> None:
    loaded = assemble([definition()], [], [], [subscription(is_active=False)])

    assert loaded.subscriptions == ()


def test_a_subscription_with_no_capital_cannot_trade() -> None:
    loaded = assemble([definition()], [], [], [subscription(capital=None)])

    assert loaded.subscriptions == ()


def test_a_subscription_to_a_refused_strategy_is_dropped() -> None:
    loaded = assemble([definition()], [], [rules(entry_rules_json="{oh dear")], [subscription()])

    assert loaded.subscriptions == ()


def test_paper_carries_through_to_the_subscription() -> None:
    loaded = assemble([definition()], [], [], [subscription(is_paper_trading=True)])

    assert loaded.subscriptions[0].is_paper


def test_a_subscription_takes_the_strategy_s_tranches() -> None:
    layers = [config(id=1, tranch_number=n) for n in (1, 2)]
    loaded = assemble([definition()], layers, [], [subscription()])

    assert loaded.subscriptions[0].tranches == (1, 2)


def test_two_accounts_run_the_same_strategy_separately() -> None:
    rows = [subscription(), subscription(subscription_id=2, trading_client_id="amma")]
    loaded = assemble([definition()], [], [], rows)

    assert {s.trading_client.value for s in loaded.subscriptions} == {"appa", "amma"}
    assert loaded.subscriptions[0].spec is loaded.subscriptions[1].spec
