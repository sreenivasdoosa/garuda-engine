"""Equity sizing and hedge windows, by the reference's arithmetic."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.engine.equity import effective_leverage, equity_quantity
from garuda.engine.hedge_windows import WindowKind, windows_for
from garuda.engine.runtime_config import Definition
from garuda.engine.vocabulary import EquitySizingModel, StrategyProduct, StrategyStatus, TradeMode

IST = ZoneInfo("Asia/Kolkata")


class TestEquitySizing:
    def test_fixed_amount_per_stock(self) -> None:
        assert (
            equity_quantity(
                EquitySizingModel.FIXED_AMOUNT_PER_STOCK,
                product=StrategyProduct.INTRADAY,
                capital=Decimal(0),
                leverage=Decimal(5),
                price=Decimal(250),
                fixed_amount=Decimal(10000),
            )
            == 200
        )

    def test_equal_split_over_max_positions(self) -> None:
        assert (
            equity_quantity(
                EquitySizingModel.MAX_POSITIONS_EQUAL_SPLIT,
                product=StrategyProduct.INTRADAY,
                capital=Decimal(100000),
                leverage=Decimal(2),
                price=Decimal(333),
                max_positions=10,
            )
            == 60
        )

    def test_max_risk_is_capped_by_buying_power(self) -> None:
        by_risk = equity_quantity(
            EquitySizingModel.MAX_RISK_PER_TRADE,
            product=StrategyProduct.INTRADAY,
            capital=Decimal(100000),
            leverage=Decimal(1),
            price=Decimal(100),
            risk_percent=Decimal(1),
            stop_price=Decimal(98),
        )
        assert by_risk == 500  # 1000 risk / 2 a share, under 1000 buyable
        capped = equity_quantity(
            EquitySizingModel.MAX_RISK_PER_TRADE,
            product=StrategyProduct.INTRADAY,
            capital=Decimal(10000),
            leverage=Decimal(1),
            price=Decimal(100),
            risk_percent=Decimal(5),
            stop_price=Decimal("99.9"),
        )
        assert capped == 100

    def test_delivery_never_uses_leverage(self) -> None:
        assert effective_leverage(StrategyProduct.CASHBUY, Decimal(5)) == 1
        assert effective_leverage(StrategyProduct.MTF, Decimal(4)) == 4


def positional(**values: object) -> Definition:
    base: dict[str, object] = {
        "name": "s",
        "exchange": "NSE",
        "underlying_symbol": "NIFTY",
        "trade_mode": TradeMode.OPTION_SELLING,
        "product": StrategyProduct.POSITIONAL,
        "status": StrategyStatus.ACTIVE,
        "hedge_replace_enabled": True,
    }
    base.update(values)
    return Definition(**base)  # type: ignore[arg-type]


class TestHedgeWindows:
    opens = dt.datetime(2026, 10, 15, 9, 15, tzinfo=IST)
    closes = dt.datetime(2026, 10, 15, 15, 30, tzinfo=IST)

    def test_the_reference_defaults(self) -> None:
        morning, evening = windows_for(
            positional(), opens=self.opens, closes=self.closes, expiry_day=False
        )
        assert morning.kind is WindowKind.MORNING
        assert (morning.start.time(), morning.end.time(), morning.distance) == (
            dt.time(9, 16),
            dt.time(9, 30),
            Decimal(4),
        )
        assert (evening.start.time(), evening.end.time(), evening.distance) == (
            dt.time(15, 20),
            dt.time(15, 28),
            Decimal(1),
        )

    def test_no_evening_window_on_expiry_and_none_when_off(self) -> None:
        assert [
            w.kind
            for w in windows_for(
                positional(), opens=self.opens, closes=self.closes, expiry_day=True
            )
        ] == [WindowKind.MORNING]
        assert (
            windows_for(
                positional(hedge_replace_enabled=False),
                opens=self.opens,
                closes=self.closes,
                expiry_day=False,
            )
            == []
        )
