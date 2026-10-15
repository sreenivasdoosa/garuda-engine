"""Equity sizing: the reference's `EquitySizingCalculator`.

Three models, each a share count floored to a whole share:

* ``FIXED_AMOUNT_PER_STOCK`` -- amount x leverage / price;
* ``MAX_POSITIONS_EQUAL_SPLIT`` -- capital / max positions x leverage / price;
* ``MAX_RISK_PER_TRADE`` -- the risk budget (capital x pct) over the stop
  distance per share, never more than capital x leverage buys.

Delivery (CASHBUY) always runs at 1x, whatever leverage says.
"""

from __future__ import annotations

from decimal import ROUND_FLOOR, Decimal

from garuda.engine.vocabulary import EquitySizingModel, StrategyProduct

HUNDRED = Decimal(100)


def effective_leverage(product: StrategyProduct, leverage: Decimal | None) -> Decimal:
    if product is StrategyProduct.CASHBUY or leverage is None or leverage <= 0:
        return Decimal(1)
    return leverage


def _floor(value: Decimal) -> int:
    return int(value.to_integral_value(rounding=ROUND_FLOOR)) if value > 0 else 0


def equity_quantity(
    model: EquitySizingModel,
    *,
    product: StrategyProduct,
    capital: Decimal,
    leverage: Decimal | None,
    price: Decimal,
    fixed_amount: Decimal | None = None,
    max_positions: int | None = None,
    risk_percent: Decimal | None = None,
    stop_price: Decimal | None = None,
) -> int:
    """Shares to buy or sell, or 0 when the model cannot size."""
    if price <= 0:
        return 0
    lev = effective_leverage(product, leverage)
    if model is EquitySizingModel.FIXED_AMOUNT_PER_STOCK:
        if fixed_amount is None or fixed_amount <= 0:
            return 0
        return _floor(fixed_amount * lev / price)
    if model is EquitySizingModel.MAX_POSITIONS_EQUAL_SPLIT:
        if capital <= 0 or not max_positions or max_positions <= 0:
            return 0
        return _floor(capital / max_positions * lev / price)
    if capital <= 0 or risk_percent is None or risk_percent <= 0 or stop_price is None:
        return 0
    per_share = abs(price - stop_price)
    if per_share <= 0:
        return 0
    by_risk = _floor(capital * risk_percent / HUNDRED / per_share)
    by_power = _floor(capital * lev / price)
    return min(by_risk, by_power)
