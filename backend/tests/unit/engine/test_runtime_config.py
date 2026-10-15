"""The configuration one subscription trades with, built in the reference's
order.

The behaviour that costs money if it is wrong: a subscription's override
must land inside the definition's bounds, a tranche without a row must trade
on the base settings rather than nothing, and tranche numbering must agree
with the scheduler's -- from one, with zero meaning "base".
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.engine.config import ConfigLayer
from garuda.engine.daycondition import DayCondition
from garuda.engine.runtime_config import (
    Definition,
    SubscriptionTerms,
    build_runtime_config,
)
from garuda.engine.vocabulary import StrategyProduct, StrategyStatus, TradeMode

APPA = TradingClientId("appa")
THURSDAY = frozenset({DayCondition.THURSDAY})
EXPIRY_THURSDAY = frozenset({DayCondition.EXPIRY, DayCondition.THURSDAY})


def definition(**overrides: object) -> Definition:
    values: dict[str, object] = {
        "name": "straddle",
        "exchange": "NSE",
        "underlying_symbol": "NIFTY",
        "trade_mode": TradeMode.OPTION_SELLING,
        "product": StrategyProduct.INTRADAY,
        "status": StrategyStatus.ACTIVE,
    }
    values.update(overrides)
    return Definition(**values)  # type: ignore[arg-type]


def terms(**overrides: object) -> SubscriptionTerms:
    values: dict[str, object] = {"trading_client_id": APPA, "capital": Decimal(500000)}
    values.update(overrides)
    return SubscriptionTerms(**values)  # type: ignore[arg-type]


def layer(
    tranche: int | None = None, day: DayCondition | None = None, **values: object
) -> ConfigLayer:
    return ConfigLayer(values=values, tranche=tranche, day_condition=day)


# -- the definition ----------------------------------------------------------


class TestDefinition:
    def test_stop_must_follow_start(self) -> None:
        with pytest.raises(DomainError, match="not after"):
            definition(start_time=dt.time(15, 0), stop_time=dt.time(9, 20))

    def test_directional_without_a_provider_is_refused(self) -> None:
        with pytest.raises(DomainError, match="names no direction provider"):
            definition(is_directional=True)

    def test_a_periodic_trigger_needs_an_interval_within_bounds(self) -> None:
        with pytest.raises(DomainError, match="needs an interval"):
            definition(periodic_trigger=True)
        with pytest.raises(DomainError, match="between 1 and 240"):
            definition(periodic_trigger=True, periodic_interval_minutes=500)
        with pytest.raises(DomainError, match="between 0 and 15"):
            definition(periodic_interval_minutes=5, periodic_offset_seconds=30)

    def test_inverted_bounds_are_refused(self) -> None:
        with pytest.raises(DomainError, match="minimum risk"):
            definition(min_risk_percentage=Decimal(2), max_risk_percentage=Decimal(1))
        with pytest.raises(DomainError, match="minimum leverage"):
            definition(min_leverage=Decimal(3), max_leverage=Decimal(2))

    def test_capital_per_lot_prefers_the_hedged_or_naked_figure(self) -> None:
        d = definition(capital_per_lot=100000, capital_per_lot_hedged=80000)
        assert d.capital_per_lot_for(hedged=True) == 80000
        assert d.capital_per_lot_for(hedged=False) == 100000  # naked unset: fall back

    def test_capital_per_lot_is_none_when_nothing_positive_is_set(self) -> None:
        assert definition(capital_per_lot=0).capital_per_lot_for(hedged=True) is None

    def test_hedge_distance_follows_the_product(self) -> None:
        d = definition(hedge_distance_intraday=Decimal(4), hedge_distance_positional=Decimal(1))
        assert d.hedge_distance_for(StrategyProduct.INTRADAY) == Decimal(4)
        assert d.hedge_distance_for(StrategyProduct.POSITIONAL) == Decimal(1)

    def test_the_blacklist_wins_over_the_whitelist(self) -> None:
        d = definition(
            tradable_days=frozenset({DayCondition.THURSDAY}),
            excluded_days=frozenset({DayCondition.EXPIRY}),
        )
        assert d.can_trade_on(THURSDAY)
        assert not d.can_trade_on(EXPIRY_THURSDAY)

    def test_no_day_lists_means_every_day(self) -> None:
        assert definition().can_trade_on(EXPIRY_THURSDAY)

    def test_a_whitelist_that_does_not_name_today_stands_down(self) -> None:
        d = definition(tradable_days=frozenset({DayCondition.EXPIRY}))
        assert not d.can_trade_on(THURSDAY)


# -- the subscription's clamps ------------------------------------------------


class TestSubscriptionClamps:
    def test_risk_below_the_minimum_becomes_the_minimum(self) -> None:
        d = definition(min_risk_percentage=Decimal(1), max_risk_percentage=Decimal(3))
        built = build_runtime_config(
            d, terms(risk_percentage=Decimal("0.5")), [], conditions=THURSDAY
        )
        assert built.risk_percentage == Decimal(1)

    def test_risk_above_the_maximum_becomes_the_maximum(self) -> None:
        d = definition(min_risk_percentage=Decimal(1), max_risk_percentage=Decimal(3))
        built = build_runtime_config(d, terms(risk_percentage=Decimal(9)), [], conditions=THURSDAY)
        assert built.risk_percentage == Decimal(3)

    def test_an_override_at_zero_means_the_strategys_own(self) -> None:
        d = definition(risk_percentage=Decimal(2), leverage=Decimal(4), max_active_positions=5)
        built = build_runtime_config(
            d,
            terms(risk_percentage=Decimal(0), leverage=Decimal(0), max_active_positions=0),
            [],
            conditions=THURSDAY,
        )
        assert built.risk_percentage == Decimal(2)
        assert built.leverage == Decimal(4)
        assert built.max_active_positions == 5

    def test_the_strategys_own_risk_is_clamped_too(self) -> None:
        d = definition(risk_percentage=Decimal(9), max_risk_percentage=Decimal(3))
        built = build_runtime_config(d, terms(), [], conditions=THURSDAY)
        assert built.risk_percentage == Decimal(3)

    def test_leverage_is_clamped_and_positions_override(self) -> None:
        d = definition(min_leverage=Decimal(1), max_leverage=Decimal(5), max_active_positions=5)
        built = build_runtime_config(
            d, terms(leverage=Decimal(8), max_active_positions=2), [], conditions=THURSDAY
        )
        assert built.leverage == Decimal(5)
        assert built.max_active_positions == 2

    def test_absolute_max_risk_overrides_when_positive(self) -> None:
        d = definition(absolute_max_risk=Decimal(5000))
        assert build_runtime_config(
            d, terms(absolute_max_risk=Decimal(1000)), [], conditions=THURSDAY
        ).absolute_max_risk == Decimal(1000)
        assert build_runtime_config(
            d, terms(), [], conditions=THURSDAY
        ).absolute_max_risk == Decimal(5000)

    def test_capital_at_zero_is_none_and_negative_is_refused(self) -> None:
        assert (
            build_runtime_config(
                definition(), terms(capital=Decimal(0)), [], conditions=THURSDAY
            ).capital
            is None
        )
        with pytest.raises(DomainError, match="negative"):
            build_runtime_config(definition(), terms(capital=Decimal(-1)), [], conditions=THURSDAY)

    def test_risk_allocation_is_on_when_either_risk_figure_is_positive(self) -> None:
        assert not build_runtime_config(
            definition(), terms(), [], conditions=THURSDAY
        ).risk_allocation_enabled
        assert build_runtime_config(
            definition(), terms(absolute_max_risk=Decimal(1)), [], conditions=THURSDAY
        ).risk_allocation_enabled


# -- tranches -----------------------------------------------------------------


class TestTranches:
    def test_tranches_are_the_numbered_rows_from_one(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [layer(lots_per_tranch=1), layer(tranche=1, tranch_timing="09:20"), layer(tranche=3)],
            conditions=THURSDAY,
        )
        assert built.tranche_numbers == (1, 3)

    def test_max_tranches_extends_the_numbering(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [layer(max_tranches=4), layer(tranche=2, lots_per_tranch=2)],
            conditions=THURSDAY,
        )
        assert built.tranche_numbers == (1, 2, 3, 4)

    def test_no_rows_means_one_tranche(self) -> None:
        assert build_runtime_config(
            definition(), terms(), [], conditions=THURSDAY
        ).tranche_numbers == (1,)

    def test_a_tranche_without_a_row_trades_on_the_base(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [
                layer(sl_percentage=Decimal(30), max_tranches=2),
                layer(tranche=1, sl_percentage=Decimal(20)),
            ],
            conditions=THURSDAY,
        )
        assert built.tranche(1).percent("sl_percentage") == Decimal(20)
        assert built.tranche(2).percent("sl_percentage") == Decimal(30)

    def test_a_tranche_row_inherits_what_it_does_not_say(self) -> None:
        """The stop set on the base survives a tranche row that only sets the strike."""
        built = build_runtime_config(
            definition(),
            terms(),
            [layer(sl_percentage=Decimal(30)), layer(tranche=1, strike_type="MoneyNess")],
            conditions=THURSDAY,
        )
        assert built.tranche(1).percent("sl_percentage") == Decimal(30)
        assert built.tranche(1).text("strike_type") == "MoneyNess"

    def test_the_base_does_not_see_tranche_rows(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [layer(sl_percentage=Decimal(30)), layer(tranche=1, sl_percentage=Decimal(20))],
            conditions=THURSDAY,
        )
        assert built.base.percent("sl_percentage") == Decimal(30)

    def test_a_row_at_tranche_zero_is_a_base_row(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [layer(tranche=0, sl_percentage=Decimal(25))],
            conditions=THURSDAY,
        )
        assert built.tranche_numbers == (1,)
        assert built.base.percent("sl_percentage") == Decimal(25)

    def test_tranche_zero_cannot_be_asked_for(self) -> None:
        built = build_runtime_config(definition(), terms(), [], conditions=THURSDAY)
        with pytest.raises(DomainError, match="start at 1"):
            built.tranche(0)

    def test_the_day_row_applies_to_every_tranche_on_that_day(self) -> None:
        built = build_runtime_config(
            definition(),
            terms(),
            [
                layer(sl_percentage=Decimal(30), max_tranches=2),
                layer(day=DayCondition.EXPIRY, sl_percentage=Decimal(15)),
                layer(tranche=2, day=DayCondition.EXPIRY, sl_percentage=Decimal(10)),
            ],
            conditions=EXPIRY_THURSDAY,
        )
        assert built.tranche(1).percent("sl_percentage") == Decimal(15)
        assert built.tranche(2).percent("sl_percentage") == Decimal(10)

    def test_gaps_read_from_the_base_with_the_references_default(self) -> None:
        plain = build_runtime_config(definition(), terms(), [], conditions=THURSDAY)
        assert plain.min_tranche_gap == 1
        assert plain.tranche_gap is None
        set_up = build_runtime_config(
            definition(), terms(), [layer(min_tranch_gap=5, tranch_gap=15)], conditions=THURSDAY
        )
        assert (set_up.min_tranche_gap, set_up.tranche_gap) == (5, 15)
