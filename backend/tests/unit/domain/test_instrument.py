"""Instruments: the fields an instrument must have, and price arithmetic."""

from __future__ import annotations

from datetime import date
from decimal import ROUND_DOWN, ROUND_HALF_UP, ROUND_UP, Decimal
from typing import Any

import pytest
from hypothesis import given
from hypothesis import strategies as st

from garuda.domain import (
    Currency,
    DomainError,
    Exchange,
    ExerciseStyle,
    Instrument,
    InstrumentId,
    InstrumentKind,
    InvalidInstrumentError,
    Money,
    OptionType,
    Segment,
    SettlementType,
)

prices = st.decimals(
    min_value=Decimal("0.01"),
    max_value=Decimal("100000"),
    allow_nan=False,
    allow_infinity=False,
    places=4,
)


def option_kwargs(nse: Exchange, **overrides: Any) -> dict[str, Any]:
    base = {
        "id": InstrumentId("NSE:TEST"),
        "exchange": nse,
        "segment": Segment.FNO,
        "kind": InstrumentKind.OPTION,
        "trading_symbol": "TEST",
        "lot_size": 75,
        "tick_size": Decimal("0.05"),
        "underlying": InstrumentId("NSE:NIFTY"),
        "expiry": date(2026, 8, 27),
        "strike": Decimal(25000),
        "option_type": OptionType.CALL,
        "exercise_style": ExerciseStyle.EUROPEAN,
        "settlement_type": SettlementType.CASH,
    }
    return {**base, **overrides}


class TestIdentity:
    @pytest.mark.parametrize("value", ["", "  ", "NSE NIFTY", "NSE:NIFTY "])
    def test_a_malformed_id_is_refused(self, value):
        with pytest.raises(DomainError):
            InstrumentId(value)

    def test_the_id_renders_as_its_canonical_string(self):
        assert str(InstrumentId("NSE:NIFTY")) == "NSE:NIFTY"


class TestOptionFields:
    def test_a_well_formed_option_is_accepted(self, nse):
        assert Instrument(**option_kwargs(nse)).is_option

    @pytest.mark.parametrize(
        "missing", ["strike", "option_type", "exercise_style", "settlement_type"]
    )
    def test_an_option_missing_a_required_field_is_refused(self, nse, missing):
        with pytest.raises(InvalidInstrumentError, match=missing):
            Instrument(**option_kwargs(nse, **{missing: None}))

    def test_exercise_style_is_required_even_though_every_nse_option_is_european(self, nse):
        """The field that lets American-style options arrive without a rewrite."""
        with pytest.raises(InvalidInstrumentError, match="exercise_style"):
            Instrument(**option_kwargs(nse, exercise_style=None))

    def test_a_non_positive_strike_is_refused(self, nse):
        with pytest.raises(InvalidInstrumentError, match="strike"):
            Instrument(**option_kwargs(nse, strike=Decimal(0)))


class TestKindConsistency:
    def test_an_equity_cannot_have_an_expiry(self, nse):
        with pytest.raises(InvalidInstrumentError, match="expiry"):
            Instrument(
                id=InstrumentId("NSE:X"),
                exchange=nse,
                segment=Segment.EQUITY,
                kind=InstrumentKind.EQUITY,
                trading_symbol="X",
                lot_size=1,
                tick_size=Decimal("0.05"),
                expiry=date(2026, 8, 27),
            )

    def test_an_equity_cannot_have_a_strike(self, nse):
        with pytest.raises(InvalidInstrumentError, match="strike"):
            Instrument(
                id=InstrumentId("NSE:X"),
                exchange=nse,
                segment=Segment.EQUITY,
                kind=InstrumentKind.EQUITY,
                trading_symbol="X",
                lot_size=1,
                tick_size=Decimal("0.05"),
                strike=Decimal(100),
            )

    def test_a_future_needs_an_underlying(self, nse):
        with pytest.raises(InvalidInstrumentError, match="underlying"):
            Instrument(
                id=InstrumentId("NSE:F"),
                exchange=nse,
                segment=Segment.FNO,
                kind=InstrumentKind.FUTURE,
                trading_symbol="F",
                lot_size=75,
                tick_size=Decimal("0.05"),
                expiry=date(2026, 8, 27),
            )

    def test_an_instrument_cannot_trade_in_a_segment_the_venue_does_not_offer(self, nse):
        with pytest.raises(InvalidInstrumentError, match="COMMODITY"):
            Instrument(
                id=InstrumentId("NSE:GOLD"),
                exchange=nse,
                segment=Segment.COMMODITY,
                kind=InstrumentKind.EQUITY,
                trading_symbol="GOLD",
                lot_size=1,
                tick_size=Decimal("0.05"),
            )

    @pytest.mark.parametrize(
        ("field", "value"), [("lot_size", 0), ("tick_size", Decimal(0)), ("freeze_quantity", 0)]
    )
    def test_non_positive_sizes_are_refused(self, nse, field, value):
        with pytest.raises(InvalidInstrumentError):
            Instrument(**option_kwargs(nse, **{field: value}))


class TestTickQuantization:
    @given(price=prices)
    def test_a_quantized_price_sits_on_a_tick(self, nifty_call, price):
        result = nifty_call.quantize_price(Money(price, Currency.INR))
        assert nifty_call.is_on_tick(result)

    @given(price=prices)
    def test_quantizing_twice_is_the_same_as_once(self, nifty_call, price):
        once = nifty_call.quantize_price(Money(price, Currency.INR))
        assert nifty_call.quantize_price(once) == once

    def test_the_rounding_direction_is_the_caller_s_choice(self, nifty_call):
        """At an order boundary the direction decides whether a protection fills."""
        price = Money.of("100.03", Currency.INR)
        assert nifty_call.quantize_price(price, ROUND_DOWN).amount == Decimal("100.00")
        assert nifty_call.quantize_price(price, ROUND_UP).amount == Decimal("100.05")
        assert nifty_call.quantize_price(price, ROUND_HALF_UP).amount == Decimal("100.05")

    def test_a_price_in_the_wrong_currency_is_refused(self, nifty_call):
        with pytest.raises(InvalidInstrumentError, match="USD"):
            nifty_call.quantize_price(Money.of(100, Currency.USD))


class TestQuantities:
    def test_lots_convert_to_units_by_lot_size(self, nifty_call):
        assert nifty_call.lots_to_quantity(3) == 225

    def test_a_negative_lot_count_is_refused(self, nifty_call):
        with pytest.raises(DomainError):
            nifty_call.lots_to_quantity(-1)

    def test_notional_multiplies_price_quantity_and_multiplier(self, nifty_call):
        value = nifty_call.notional(Money.of("120.50", Currency.INR), 75)
        assert value == Money.of("9037.50", Currency.INR)

    def test_the_freeze_limit_is_what_forces_an_entry_to_be_sliced(self, nifty_call):
        assert not nifty_call.exceeds_freeze_limit(1800)
        assert nifty_call.exceeds_freeze_limit(1801)

    def test_an_instrument_without_a_published_freeze_limit_never_slices(self, reliance):
        assert reliance.freeze_quantity is None
        assert not reliance.exceeds_freeze_limit(1_000_000)


class TestClassification:
    def test_an_index_is_priced_but_never_routed(self, nifty_index):
        assert not nifty_index.is_tradable

    def test_an_option_is_tradable_and_a_derivative(self, nifty_call):
        assert nifty_call.is_tradable
        assert nifty_call.is_derivative

    def test_an_equity_is_neither_a_derivative_nor_an_option(self, reliance):
        assert not reliance.is_derivative
        assert not reliance.is_option

    def test_the_currency_comes_from_the_venue(self, nifty_call):
        assert nifty_call.currency is Currency.INR
