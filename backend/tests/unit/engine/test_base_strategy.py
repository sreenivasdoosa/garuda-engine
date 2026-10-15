"""The pipeline, end to end, against a fake environment.

Behavioural: a scheduled tranche goes in as the reference would enter it --
which strikes, which hedges, how many lots, sliced how, linked by which ids
-- or stands down and says why.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from garuda.domain.calendar import TradingCalendar
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    Direction,
    ExerciseStyle,
    ExpiryKind,
    InstrumentKind,
    OptionType,
    ProductType,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.domain.trade_signal import SignalType
from garuda.engine.base_strategy import BaseStrategy, Evaluation, Outcome
from garuda.engine.config import ConfigLayer
from garuda.engine.daycondition import DayCondition
from garuda.engine.runtime_config import Definition, SubscriptionTerms, build_runtime_config
from garuda.engine.strategy_state import StrategyState
from garuda.engine.vocabulary import StrategyProduct, StrategyStatus, TradeMode

IST = ZoneInfo("Asia/Kolkata")
DAY = dt.date(2026, 10, 15)
EXPIRY = dt.date(2026, 10, 20)
NOW = dt.datetime(2026, 10, 15, 9, 20, tzinfo=IST)
NIFTY = InstrumentId("NSE:NIFTY")
APPA = TradingClientId("appa")


def option_id(strike: Decimal, option_type: OptionType) -> InstrumentId:
    suffix = "CE" if option_type is OptionType.CALL else "PE"
    return InstrumentId(f"NFO:NIFTY26OCT{int(strike)}{suffix}")


@dataclass
class FakeEnvironment:
    venue: Exchange
    now: dt.datetime = NOW
    trading_day: dt.date = DAY
    conditions: frozenset[DayCondition] = frozenset({DayCondition.THURSDAY})
    spot_price: Decimal | None = Decimal("22512")
    freeze: int | None = None
    premium: Decimal = Decimal(100)
    missing: set[InstrumentId] = field(default_factory=set)
    unquoted: set[InstrumentId] = field(default_factory=set)
    volumes: dict[InstrumentId, int] = field(default_factory=dict)
    day_percent: int = 100
    event_percent: int = 100
    monthly_week: bool = False
    memory: Mapping[str, Any] = field(default_factory=dict)

    @property
    def timezone(self) -> ZoneInfo:
        return IST

    @property
    def calendar(self) -> TradingCalendar:
        return self.venue.calendar

    @property
    def market_close(self) -> dt.time:
        return dt.time(15, 30)

    def spot(self, underlying: InstrumentId) -> Money | None:
        return Money(self.spot_price, Currency.INR) if self.spot_price is not None else None

    def future_price(self, underlying: InstrumentId) -> Money | None:
        return None

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        return Decimal(50)

    def hedge_rounding(self, underlying: InstrumentId) -> Decimal | None:
        return None

    def option_expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> dt.date | None:
        return EXPIRY

    def is_monthly_expiry_week(self, underlying: InstrumentId) -> bool:
        return self.monthly_week

    def option(
        self, underlying: InstrumentId, expiry: dt.date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None:
        listed = option_id(strike, option_type)
        return None if listed in self.missing else listed

    def strikes(self, underlying: InstrumentId, expiry: dt.date) -> list[Decimal]:
        return [Decimal(s) for s in range(20000, 25001, 50)]

    def instrument(self, instrument: InstrumentId) -> Instrument | None:
        symbol = instrument.value.split(":")[1]
        strike = Decimal(symbol[len("NIFTY26OCT") : -2])
        return Instrument(
            id=instrument,
            exchange=self.venue,
            segment=Segment.FNO,
            kind=InstrumentKind.OPTION,
            trading_symbol=symbol,
            lot_size=75,
            tick_size=Decimal("0.05"),
            freeze_quantity=self.freeze,
            underlying=NIFTY,
            expiry=EXPIRY,
            strike=strike,
            option_type=OptionType.CALL if symbol.endswith("CE") else OptionType.PUT,
            exercise_style=ExerciseStyle.EUROPEAN,
            settlement_type=SettlementType.CASH,
        )

    def quote(self, instrument: InstrumentId) -> Tick | None:
        if instrument in self.unquoted:
            return None
        return Tick(
            instrument=instrument,
            last_price=Money(self.premium, Currency.INR),
            timestamp=self.now,
            volume=self.volumes.get(instrument),
        )

    def day_allocation_percent(self, strategy: str) -> int:
        return self.day_percent

    def event_day_percent(self, strategy: str, exchange: str) -> int:
        return self.event_percent


def definition(**overrides: Any) -> Definition:
    values: dict[str, Any] = {
        "name": "straddle",
        "exchange": "NSE",
        "underlying_symbol": "NIFTY",
        "trade_mode": TradeMode.OPTION_SELLING,
        "product": StrategyProduct.INTRADAY,
        "status": StrategyStatus.ACTIVE,
        "start_time": dt.time(9, 20),
        "stop_time": dt.time(15, 15),
        "capital_per_lot": 100000,
    }
    values.update(overrides)
    return Definition(**values)


def evaluate(
    env: FakeEnvironment,
    *,
    layers: tuple[ConfigLayer, ...] = (),
    capital: str = "300000",
    tranche: int = 1,
    state: StrategyState | None = None,
    entry_gate: Any = None,
    **definition_overrides: Any,
) -> Outcome:
    runtime = build_runtime_config(
        definition(**definition_overrides),
        SubscriptionTerms(trading_client_id=APPA, capital=Decimal(capital)),
        layers,
        conditions=env.conditions,
    )
    return BaseStrategy().on_scheduled(
        Evaluation(
            runtime=runtime,
            state=state or StrategyState(APPA, "straddle", DAY),
            env=env,
            tranche=tranche,
            entry_gate=entry_gate,
        )
    )


def base(**values: object) -> ConfigLayer:
    return ConfigLayer(values={"strike_type": "MoneyNess", "strike_value": "ATM", **values})


@pytest.fixture
def env(nse: Exchange) -> FakeEnvironment:
    return FakeEnvironment(venue=nse)


class TestAnAtTheMoneyPair:
    def test_it_sells_the_call_and_the_put_at_the_money(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),))
        assert outcome.entered, outcome.stood_down
        assert {s.instrument.value for s in outcome.signals} == {
            "NFO:NIFTY26OCT22500CE",
            "NFO:NIFTY26OCT22500PE",
        }
        assert all(s.signal_type is SignalType.SHORT_ENTRY for s in outcome.signals)
        assert all(s.product is ProductType.MIS for s in outcome.signals)

    def test_lots_are_capital_over_capital_per_lot(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(max_tranches=1),), capital="300000")
        assert outcome.lots == 3
        assert {s.quantity for s in outcome.signals} == {225}

    def test_without_tranche_rows_it_trades_the_configured_lots(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(lots_per_tranch=2),), capital="9000000")
        assert outcome.lots == 2

    def test_the_slice_is_grouped_and_linked_as_the_reference_does(
        self, env: FakeEnvironment
    ) -> None:
        outcome = evaluate(env, layers=(base(),))
        groups = {s.group for s in outcome.signals}
        assert groups == {"Tranch-1|Slice-1"}
        pair = {s.relationships.pair_correlation_id for s in outcome.signals}
        assert len(pair) == 1
        assert {s.relationships.combo_id for s in outcome.signals} == pair
        assert all(s.combo_leg_count == 2 for s in outcome.signals)
        assert all(len(s.id) <= 50 for s in outcome.signals)

    def test_the_tranche_is_marked_signalled(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),))
        assert outcome.state.has_signalled(1)
        again = evaluate(env, layers=(base(),), state=outcome.state)
        assert not again.entered
        assert "already signalled" in (again.stood_down or "")

    def test_ids_are_replayable(self, env: FakeEnvironment) -> None:
        first = evaluate(env, layers=(base(),))
        second = evaluate(env, layers=(base(),))
        assert [s.id for s in first.signals] == [s.id for s in second.signals]

    def test_positional_groups_carry_the_date(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),), product=StrategyProduct.POSITIONAL)
        assert {s.group for s in outcome.signals} == {"2026-10-15|Tranch-1|Slice-1"}
        assert all(s.product is ProductType.NRML for s in outcome.signals)


class TestHedges:
    def test_each_main_leg_gets_its_hedge_and_shares_its_correlation(
        self, env: FakeEnvironment
    ) -> None:
        outcome = evaluate(
            env,
            layers=(base(hedging_enabled=True),),
            hedge_distance_intraday=Decimal(4),
        )
        by_instrument = {s.instrument.value: s for s in outcome.signals}
        assert set(by_instrument) == {
            "NFO:NIFTY26OCT22500CE",
            "NFO:NIFTY26OCT22500PE",
            "NFO:NIFTY26OCT23400CE",
            "NFO:NIFTY26OCT21600PE",
        }
        call, call_hedge = (
            by_instrument["NFO:NIFTY26OCT22500CE"],
            by_instrument["NFO:NIFTY26OCT23400CE"],
        )
        put_hedge = by_instrument["NFO:NIFTY26OCT21600PE"]
        assert call_hedge.signal_type is SignalType.LONG_ENTRY
        assert call_hedge.relationships.leg_role is LegRole.HEDGE
        assert (
            call.relationships.hedge_correlation_id == call_hedge.relationships.hedge_correlation_id
        )
        assert (
            call.relationships.hedge_correlation_id != put_hedge.relationships.hedge_correlation_id
        )

    def test_protection_goes_on_first(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(hedging_enabled=True),))
        sequence = {
            s.relationships.leg_role: s.relationships.entry_sequence for s in outcome.signals
        }
        assert sequence[LegRole.HEDGE] < sequence[LegRole.MAIN]

    def test_hedged_lots_use_the_hedged_capital_per_lot(self, env: FakeEnvironment) -> None:
        outcome = evaluate(
            env,
            layers=(base(hedging_enabled=True, max_tranches=1),),
            capital="300000",
            capital_per_lot_hedged=50000,
            capital_per_lot_naked=300000,
        )
        assert outcome.lots == 6

    def test_a_hedge_that_is_not_listed_stands_the_entry_down(self, env: FakeEnvironment) -> None:
        env.missing.add(option_id(Decimal(23400), OptionType.CALL))
        outcome = evaluate(env, layers=(base(hedging_enabled=True),))
        assert not outcome.entered
        assert outcome.alert
        assert "not entering without it" in (outcome.stood_down or "")


class TestSlicing:
    def test_above_the_freeze_limit_each_slice_is_its_own_combo(self, env: FakeEnvironment) -> None:
        env.freeze = 1800
        outcome = evaluate(env, layers=(base(max_tranches=1),), capital="3000000")  # 30 lots
        quantities = sorted({(s.slice, s.quantity) for s in outcome.signals})
        assert quantities == [(1, 1800), (2, 450)]
        assert len({s.relationships.combo_id for s in outcome.signals}) == 2
        assert {s.group for s in outcome.signals} == {"Tranch-1|Slice-1", "Tranch-1|Slice-2"}


class TestStandingDown:
    def test_not_active(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),), status=StrategyStatus.WIND_DOWN)
        assert outcome.stood_down == "status is WIND_DOWN"
        assert not outcome.alert

    def test_an_excluded_day(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),), excluded_days=frozenset({DayCondition.THURSDAY}))
        assert "not a tradable day" in (outcome.stood_down or "")

    def test_the_monthly_expiry_week_when_excluded(self, env: FakeEnvironment) -> None:
        env.monthly_week = True
        outcome = evaluate(env, layers=(base(),), exclude_monthly_expiry=True)
        assert outcome.stood_down == "monthly expiry week is excluded"

    def test_before_the_start_and_after_the_cutoff(self, env: FakeEnvironment) -> None:
        early = evaluate(env, layers=(base(),), start_time=dt.time(9, 30))
        assert "before the start" in (early.stood_down or "")
        late = evaluate(env, layers=(base(tranch_cutoff_time="09:15"),))
        assert "past the cutoff" in (late.stood_down or "")

    def test_no_spot_price(self, env: FakeEnvironment) -> None:
        env.spot_price = None
        outcome = evaluate(env, layers=(base(),))
        assert "spot price is not available" in (outcome.stood_down or "")
        assert outcome.alert

    def test_zero_lots_is_reported(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(max_tranches=1),), capital="50000")
        assert (outcome.stood_down or "").startswith("zero lots")
        assert outcome.alert

    def test_a_leg_with_no_price_cannot_be_protected(self, env: FakeEnvironment) -> None:
        env.unquoted.add(option_id(Decimal(22500), OptionType.PUT))
        outcome = evaluate(env, layers=(base(),))
        assert "no price" in (outcome.stood_down or "")

    def test_the_volume_filter(self, env: FakeEnvironment) -> None:
        env.volumes[option_id(Decimal(22500), OptionType.CALL)] = 10
        outcome = evaluate(env, layers=(base(volume_filter=1000),))
        assert "volume 10 is below 1000" in (outcome.stood_down or "")

    def test_an_unimplemented_strike_type_is_refused_not_guessed(
        self, env: FakeEnvironment
    ) -> None:
        outcome = evaluate(env, layers=(ConfigLayer(values={"strike_type": "FixedDelta"}),))
        assert "not implemented" in (outcome.stood_down or "")

    def test_the_entry_rules_block(self, env: FakeEnvironment) -> None:
        outcome = evaluate(
            env, layers=(base(),), use_indicator_entry=True, entry_gate=lambda _: "RSI is 40"
        )
        assert outcome.stood_down == "entry rules: RSI is 40"


class TestDirection:
    def test_a_bullish_seller_sells_the_put(self, env: FakeEnvironment) -> None:
        outcome = evaluate(
            env,
            layers=(base(),),
            is_directional=True,
            direction_provider_type="FIXED",
            direction_provider_params={"direction": "LONG"},
        )
        assert [s.instrument.value for s in outcome.signals] == ["NFO:NIFTY26OCT22500PE"]
        assert outcome.signals[0].direction is Direction.SHORT

    def test_a_bearish_buyer_buys_the_put(self, env: FakeEnvironment) -> None:
        outcome = evaluate(
            env,
            layers=(base(),),
            trade_mode=TradeMode.OPTION_BUYING,
            is_directional=True,
            direction_provider_type="FIXED",
            direction_provider_params={"direction": "SHORT"},
        )
        assert [s.instrument.value for s in outcome.signals] == ["NFO:NIFTY26OCT22500PE"]
        assert outcome.signals[0].direction is Direction.LONG

    def test_otm_moves_the_call_up_and_the_put_down(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(strike_value="OTM+2"),))
        assert {s.instrument.value for s in outcome.signals} == {
            "NFO:NIFTY26OCT22600CE",
            "NFO:NIFTY26OCT22400PE",
        }


class TestTheExit:
    def test_a_configured_exit_time_becomes_the_square_off(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(exit_mode="SAME_DAY", exit_time="14:45"),))
        assert {s.square_off_at for s in outcome.signals} == {
            dt.datetime(2026, 10, 15, 14, 45, tzinfo=IST)
        }

    def test_entries_are_at_market_valid_ten_minutes(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(),))
        entry = outcome.signals[0].entry
        assert entry.place_market_order
        assert entry.valid_till == NOW + dt.timedelta(minutes=10)
        assert entry.cancel_unfilled_order_at == dt.datetime(2026, 10, 15, 15, 15, tzinfo=IST)

    def test_the_stop_is_placed_from_the_price(self, env: FakeEnvironment) -> None:
        outcome = evaluate(env, layers=(base(sl_percentage=Decimal(30)),))
        stops = {s.protection.stop_loss for s in outcome.signals}
        assert stops == {Money(Decimal("130.00"), Currency.INR)}
