"""Putting the risk gate in front of entries.

The checks existed and nothing ran them. These are about the wiring: that an
entry is refused when it should be, that an exit is never refused, and that a
refusal arrives in the shape the entry service knows how to handle.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.composition.risk import PlaceOrder, gated, realised_today
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Direction, Money, OrderType, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.enums import InstrumentKind, Segment
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.broker import OrderRejectedError
from garuda.rms.checks import default_checks
from garuda.rms.gate import RiskGate
from garuda.rms.limits import RiskLimits

NOW = datetime(2026, 8, 31, 10, 0, tzinfo=UTC)
CLIENT = TradingClientId("appa")
STOCK = InstrumentId("NSE:RELIANCE")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@pytest.fixture
def stock(nse: Exchange) -> Instrument:
    return Instrument(
        id=STOCK,
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.EQUITY,
        trading_symbol="RELIANCE",
        lot_size=1,
        tick_size=Decimal("0.05"),
    )


def an_order(quantity: int = 10) -> OrderRequest:
    return OrderRequest(
        client_order_id=ClientOrderId("gar-1"),
        trading_client=CLIENT,
        instrument=STOCK,
        side=Side.BUY,
        quantity=quantity,
        order_type=OrderType.MARKET,
        product=ProductType.MIS,
    )


def a_quote(at: datetime = NOW) -> Tick:
    return Tick(instrument=STOCK, last_price=rupees("2500"), timestamp=at)


def wrap(
    stock: Instrument,
    *,
    limits: RiskLimits | None = None,
    quote: Tick | None = None,
    placed: list[OrderRequest] | None = None,
) -> PlaceOrder:
    async def place(request: OrderRequest) -> BrokerOrderId:
        if placed is not None:
            placed.append(request)
        return BrokerOrderId("250831000001")

    return gated(
        place,
        gate=RiskGate(default_checks()),
        limits=limits or RiskLimits(),
        instruments=lambda instrument: stock if instrument == STOCK else None,
        quotes=lambda instrument: quote,
        clock=ReplayClock(NOW),
        label="Appa (zerodha:AB1234)",
    )


# -- what gets through ------------------------------------------------------


async def test_an_ordinary_entry_is_placed(stock: Instrument) -> None:
    placed: list[OrderRequest] = []

    await wrap(stock, quote=a_quote(), placed=placed)(an_order())

    assert len(placed) == 1


async def test_a_breach_stops_the_order_reaching_the_broker(stock: Instrument) -> None:
    placed: list[OrderRequest] = []
    limits = RiskLimits(max_order_quantity=5)

    with pytest.raises(OrderRejectedError):
        await wrap(stock, limits=limits, quote=a_quote(), placed=placed)(an_order(10))

    assert placed == []


async def test_the_refusal_says_which_limit(stock: Instrument) -> None:
    limits = RiskLimits(max_order_quantity=5)

    with pytest.raises(OrderRejectedError, match="10"):
        await wrap(stock, limits=limits, quote=a_quote())(an_order(10))


async def test_a_refusal_is_definitive(stock: Instrument) -> None:
    """`OrderRejectedError` is what the entry service reads as "no order
    exists, so a later attempt may safely send a fresh one". Any other
    exception leaves it believing an order might be resting at the exchange,
    and it will not place again."""
    limits = RiskLimits(max_order_quantity=5)

    with pytest.raises(OrderRejectedError):
        await wrap(stock, limits=limits, quote=a_quote())(an_order(10))


# -- the checks that need no configuration ----------------------------------


async def test_an_order_with_no_price_is_refused(stock: Instrument) -> None:
    """No limit configured, and still protective: nothing about an order can
    be judged without a price."""
    with pytest.raises(OrderRejectedError):
        await wrap(stock, quote=None)(an_order())


async def test_a_stale_price_is_refused(stock: Instrument) -> None:
    stale = a_quote(NOW - timedelta(minutes=5))

    with pytest.raises(OrderRejectedError):
        await wrap(stock, quote=stale)(an_order())


async def test_an_instrument_the_master_does_not_know_is_refused(
    stock: Instrument,
) -> None:
    """Sending it unchecked is the opposite of what a gate is for."""
    unknown = OrderRequest(
        client_order_id=ClientOrderId("gar-2"),
        trading_client=CLIENT,
        instrument=InstrumentId("NSE:NOTLISTED"),
        side=Side.BUY,
        quantity=1,
        order_type=OrderType.MARKET,
        product=ProductType.MIS,
    )

    with pytest.raises(OrderRejectedError, match="instrument master"):
        await wrap(stock, quote=a_quote())(unknown)


# -- the daily loss limit ---------------------------------------------------


async def test_an_account_past_its_daily_loss_takes_no_new_position(
    stock: Instrument,
) -> None:
    """A limit that was configurable and unenforced until now: it was defined,
    a breach type existed for it, and no check ever read it."""
    placed: list[OrderRequest] = []
    place = gated(
        _accepting(placed),
        gate=RiskGate(default_checks()),
        limits=RiskLimits(max_daily_loss=rupees("40000")),
        instruments=lambda instrument: stock,
        quotes=lambda instrument: a_quote(),
        clock=ReplayClock(NOW),
        label="Appa",
        realized_today=lambda: rupees("-50000"),
    )

    with pytest.raises(OrderRejectedError, match="past the limit"):
        await place(an_order())

    assert placed == []


async def test_an_account_inside_its_daily_loss_still_trades(
    stock: Instrument,
) -> None:
    placed: list[OrderRequest] = []
    place = gated(
        _accepting(placed),
        gate=RiskGate(default_checks()),
        limits=RiskLimits(max_daily_loss=rupees("40000")),
        instruments=lambda instrument: stock,
        quotes=lambda instrument: a_quote(),
        clock=ReplayClock(NOW),
        label="Appa",
        realized_today=lambda: rupees("-39999"),
    )

    await place(an_order())

    assert len(placed) == 1


async def test_losing_exactly_the_limit_is_at_it_not_past_it(
    stock: Instrument,
) -> None:
    """A maximum is a value that may be reached. An account down exactly its
    budget has spent it and not exceeded it, and the next rupee is what
    stops."""
    placed: list[OrderRequest] = []
    place = gated(
        _accepting(placed),
        gate=RiskGate(default_checks()),
        limits=RiskLimits(max_daily_loss=rupees("40000")),
        instruments=lambda instrument: stock,
        quotes=lambda instrument: a_quote(),
        clock=ReplayClock(NOW),
        label="Appa",
        realized_today=lambda: rupees("-40000"),
    )

    await place(an_order())

    assert len(placed) == 1


async def test_a_profitable_day_is_never_a_breach(stock: Instrument) -> None:
    placed: list[OrderRequest] = []
    place = gated(
        _accepting(placed),
        gate=RiskGate(default_checks()),
        limits=RiskLimits(max_daily_loss=rupees("40000")),
        instruments=lambda instrument: stock,
        quotes=lambda instrument: a_quote(),
        clock=ReplayClock(NOW),
        label="Appa",
        realized_today=lambda: rupees("120000"),
    )

    await place(an_order())

    assert len(placed) == 1


def test_the_days_result_counts_only_closed_positions() -> None:
    """An open position has a mark, not a result. Counting a mark would trip
    the limit on a position that has not lost anything yet — and stop the
    entries that might have hedged it."""
    closed = _a_trade(entry="100", exit_at="90")
    open_and_down = _a_trade(entry="100", exit_at=None)

    total = realised_today(lambda: [closed, open_and_down])()

    assert total == rupees("-1000")


def test_the_days_result_is_every_closed_position_together() -> None:
    """One loss is not the day. A limit reading only the first would let an
    account lose it several times over."""
    losses = [_a_trade(entry="100", exit_at="90") for _ in range(3)]

    assert realised_today(lambda: losses)() == rupees("-3000")


def test_a_winner_offsets_a_loser() -> None:
    trades = [_a_trade(entry="100", exit_at="90"), _a_trade(entry="100", exit_at="115")]

    assert realised_today(lambda: trades)() == rupees("500")


def test_a_day_with_nothing_closed_has_no_result() -> None:
    """Not zero: nothing realised is not the same as having broken even, and
    a limit comparing against zero would behave the same either way only by
    luck."""
    assert realised_today(lambda: [])() is None


def _a_trade(*, entry: str, exit_at: str | None) -> Trade:
    return Trade(
        id=TradeId("t1"),
        trading_client=CLIENT,
        instrument=STOCK,
        strategy="s",
        direction=Direction.LONG,
        product=ProductType.MIS,
        quantity=100,
        state=TradeState.COMPLETED if exit_at else TradeState.ACTIVE,
        filled_quantity=100,
        entry=rupees(entry),
        exit=rupees(exit_at) if exit_at else None,
        exit_reason=TradeExitReason.TARGET if exit_at else None,
        started_at=NOW,
        ended_at=NOW if exit_at else None,
    )


def _accepting(placed: list[OrderRequest]) -> PlaceOrder:
    async def place(request: OrderRequest) -> BrokerOrderId:
        placed.append(request)
        return BrokerOrderId("250831000001")

    return place
