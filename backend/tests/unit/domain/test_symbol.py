"""Per-underlying trading knowledge."""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.domain import DomainError
from garuda.domain.symbol import SymbolInfo


def nifty(**overrides: object) -> SymbolInfo:
    base: dict[str, object] = {
        "symbol": "NIFTY",
        "exchange_code": "NSE",
        "is_index": True,
        "index_symbol": "NIFTY 50",
        "strike_gap": Decimal(50),
        "freeze_limit_quantity": 1755,
        "has_weekly_options": True,
    }
    return SymbolInfo(**{**base, **overrides})  # type: ignore[arg-type]


class TestSpotSymbol:
    def test_an_index_takes_its_price_from_a_different_symbol(self):
        """Options on NIFTY price against NIFTY 50; without this, strike
        selection has no price to select against."""
        assert nifty().spot_symbol == "NIFTY 50"

    def test_a_stock_is_its_own_spot(self):
        stock = SymbolInfo(symbol="RELIANCE", exchange_code="NSE", strike_gap=Decimal(20))
        assert stock.spot_symbol == "RELIANCE"

    def test_an_index_without_a_separate_feed_symbol_is_its_own_spot(self):
        """MCX commodities carry no separate index symbol."""
        crude = SymbolInfo(
            symbol="CRUDEOIL",
            exchange_code="MCX",
            is_index=True,
            contract_multiplier=Decimal(100),
        )
        assert crude.spot_symbol == "CRUDEOIL"


class TestContractMultiplier:
    def test_equity_derivatives_default_to_one_unit_per_lot(self):
        assert SymbolInfo(symbol="RELIANCE", exchange_code="NSE").contract_multiplier == 1

    @pytest.mark.parametrize(
        ("symbol", "multiplier"),
        [("CRUDEOIL", 100), ("GOLDM", 10), ("NATURALGAS", 1250), ("SILVER", 30)],
    )
    def test_a_commodity_lot_is_many_units(self, symbol, multiplier):
        """Assuming one makes a commodity P&L wrong by orders of magnitude,
        and the wrong number still looks plausible."""
        info = SymbolInfo(
            symbol=symbol, exchange_code="MCX", contract_multiplier=Decimal(multiplier)
        )
        assert info.contract_multiplier == Decimal(multiplier)

    def test_a_non_positive_multiplier_is_refused(self):
        with pytest.raises(DomainError, match="multiplier"):
            SymbolInfo(symbol="X", exchange_code="MCX", contract_multiplier=Decimal(0))


class TestStrikes:
    def test_strikes_sit_at_the_underlyings_spacing(self):
        strikes = nifty().strikes_around(Decimal("24987"), levels=2)
        assert strikes == [
            Decimal(24900),
            Decimal(24950),
            Decimal(25000),
            Decimal(25050),
            Decimal(25100),
        ]

    def test_a_wider_gap_gives_wider_strikes(self):
        banknifty = nifty(symbol="BANKNIFTY", strike_gap=Decimal(100))
        strikes = banknifty.strikes_around(Decimal("52480"), levels=1)
        assert strikes == [Decimal(52400), Decimal(52500), Decimal(52600)]

    def test_the_default_level_count_comes_from_the_underlying(self):
        assert len(nifty(option_chain_levels=3).strikes_around(Decimal(25000))) == 7

    def test_a_non_positive_strike_gap_is_refused(self):
        with pytest.raises(DomainError, match="strike gap"):
            nifty(strike_gap=Decimal(0))


class TestHedgeStrikeRounding:
    def test_it_falls_back_to_the_strike_gap(self):
        assert nifty().hedge_strike_step == Decimal(50)

    def test_a_coarser_rounding_wins_when_set(self):
        """SENSEX hedges round to 500 even though its strikes sit at 100."""
        sensex = nifty(
            symbol="SENSEX",
            strike_gap=Decimal(100),
            hedge_strike_rounding=Decimal(500),
        )
        assert sensex.hedge_strike_step == Decimal(500)


class TestRejections:
    def test_an_unnamed_symbol_is_refused(self):
        with pytest.raises(DomainError, match="must name a symbol"):
            SymbolInfo(symbol="  ", exchange_code="NSE")

    def test_a_freeze_limit_below_one_unit_is_refused(self):
        with pytest.raises(DomainError, match="freeze limit"):
            nifty(freeze_limit_quantity=0)
