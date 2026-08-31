"""Putting the risk gate in front of orders.

The checks existed and nothing ran them. These are about the wiring: that an
entry is refused when it should be, that an exit is refused only by the two
checks with any business stopping one, and that a refusal arrives in the shape
the entry service knows how to handle.

Every check is pinned from both sides here — stands down on an exit, still
fires on an entry — because a `guards_exits` that silently read True would
trap a position on exactly the day the limit was reached.
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
from garuda.domain.market import DepthLevel, Tick
from garuda.domain.order import BrokerOrderId, ClientOrderId, OrderRequest, Side
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.broker import OrderRejectedError
from garuda.rms.checks import default_checks
from garuda.rms.gate import RiskContext, RiskGate
from garuda.rms.limits import RiskLimits
from garuda.rms.scope import LimitBook, LimitScope, ScopedLimits

#: 10:30 IST on a Monday — inside the session, because the gate now asks the
#: venue calendar and every order outside it is refused.
NOW = datetime(2026, 8, 31, 5, 0, tzinfo=UTC)
CLIENT = TradingClientId("appa")
STOCK = InstrumentId("NSE:RELIANCE")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def everywhere(limits: RiskLimits) -> LimitBook:
    """One row, scoped to nothing, so it applies to every order."""
    return LimitBook((ScopedLimits(LimitScope(), limits),))


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


def a_wide_quote() -> Tick:
    """A hundred rupees across, on a 2,500 stock: 4% of the price."""
    return Tick(
        instrument=STOCK,
        last_price=rupees("2500"),
        timestamp=NOW,
        bids=(DepthLevel(price=rupees("2450"), quantity=100),),
        asks=(DepthLevel(price=rupees("2550"), quantity=100),),
    )


def a_thin_quote() -> Tick:
    return Tick(instrument=STOCK, last_price=rupees("2500"), timestamp=NOW, volume=12)


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
        limits=everywhere(limits or RiskLimits()),
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
        limits=everywhere(RiskLimits(max_daily_loss=rupees("40000"))),
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
        limits=everywhere(RiskLimits(max_daily_loss=rupees("40000"))),
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
        limits=everywhere(RiskLimits(max_daily_loss=rupees("40000"))),
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
        limits=everywhere(RiskLimits(max_daily_loss=rupees("40000"))),
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


# -- exits are gated differently, not ungated -------------------------------


def leaving(
    stock: Instrument,
    *,
    limits: RiskLimits | None = None,
    quote: Tick | None = None,
    placed: list[OrderRequest] | None = None,
    realized: Money | None = None,
    at: datetime = NOW,
) -> PlaceOrder:
    """The placement the protective and square-off services are given."""

    async def place(request: OrderRequest) -> BrokerOrderId:
        if placed is not None:
            placed.append(request)
        return BrokerOrderId("250831000001")

    return gated(
        place,
        gate=RiskGate(default_checks()),
        limits=everywhere(limits or RiskLimits()),
        instruments=lambda instrument: stock,
        quotes=lambda instrument: quote,
        clock=ReplayClock(at),
        label="Appa",
        realized_today=(lambda: realized) if realized is not None else None,
        is_exit=True,
    )


async def test_a_stop_loss_goes_out_on_the_day_the_limit_was_reached(
    stock: Instrument,
) -> None:
    """The one that matters. A loss limit that blocked an exit would turn a
    bad day into an uncapped one."""
    placed: list[OrderRequest] = []
    place = leaving(
        stock,
        limits=RiskLimits(max_daily_loss=rupees("40000")),
        quote=a_quote(),
        placed=placed,
        realized=rupees("-500000"),
    )

    await place(an_order())

    assert len(placed) == 1


async def test_an_exit_is_not_stopped_by_a_size_cap(stock: Instrument) -> None:
    """A cap on how much may be taken on has nothing to say about leaving."""
    placed: list[OrderRequest] = []
    place = leaving(stock, limits=RiskLimits(max_order_quantity=5), quote=a_quote(), placed=placed)

    await place(an_order(10))

    assert len(placed) == 1


async def test_an_exit_is_not_stopped_by_a_missing_price(stock: Instrument) -> None:
    """Not knowing the price is a reason not to open a position and never a
    reason to keep one."""
    placed: list[OrderRequest] = []
    place = leaving(stock, quote=None, placed=placed)

    await place(an_order())

    assert len(placed) == 1


async def test_an_exit_is_not_stopped_by_a_stale_price(stock: Instrument) -> None:
    placed: list[OrderRequest] = []
    place = leaving(stock, quote=a_quote(NOW - timedelta(minutes=5)), placed=placed)

    await place(an_order())

    assert len(placed) == 1


async def test_an_exit_is_still_stopped_by_what_the_exchange_would_refuse(
    nse: Exchange,
) -> None:
    """Above the freeze limit the exchange refuses it whichever way the order
    points, so an exit above it has to be sliced too — and being told here is
    a clearer reason than a broker rejection."""
    small = Instrument(
        id=STOCK,
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.EQUITY,
        trading_symbol="RELIANCE",
        lot_size=1,
        tick_size=Decimal("0.05"),
        freeze_quantity=5,
    )
    placed: list[OrderRequest] = []
    place = leaving(small, quote=a_quote(), placed=placed)

    with pytest.raises(OrderRejectedError, match="freeze"):
        await place(an_order(10))

    assert placed == []


async def test_an_exit_is_not_gated_away_entirely(stock: Instrument) -> None:
    """It goes through the gate; it is not waved past it. An exit for an
    instrument nobody can identify is still refused."""
    unknown = OrderRequest(
        client_order_id=ClientOrderId("gar-3"),
        trading_client=CLIENT,
        instrument=InstrumentId("NSE:NOTLISTED"),
        side=Side.SELL,
        quantity=1,
        order_type=OrderType.MARKET,
        product=ProductType.MIS,
    )
    place = gated(
        _accepting([]),
        gate=RiskGate(default_checks()),
        limits=LimitBook(),
        instruments=lambda instrument: None,
        quotes=lambda instrument: a_quote(),
        clock=ReplayClock(NOW),
        label="Appa",
        is_exit=True,
    )

    with pytest.raises(OrderRejectedError, match="instrument master"):
        await place(unknown)


async def test_an_exit_is_not_stopped_by_a_kill_switch(stock: Instrument) -> None:
    """The one an operator would guess wrong. A kill switch stops an account
    taking risk; the risk already taken still has to be closable, and the
    reference engine says so in as many words."""
    context = RiskContext(
        request=an_order(),
        instrument=stock,
        now=NOW,
        limits=RiskLimits(),
        quote=a_quote(),
        kill_switch_reason="operator halted trading",
        is_exit=True,
    )

    assert RiskGate(default_checks()).evaluate(context).allowed


async def test_an_entry_is_stopped_by_a_kill_switch(stock: Instrument) -> None:
    """The other half, so the check is not merely unreachable."""
    context = RiskContext(
        request=an_order(),
        instrument=stock,
        now=NOW,
        limits=RiskLimits(),
        quote=a_quote(),
        kill_switch_reason="operator halted trading",
    )

    decision = RiskGate(default_checks()).evaluate(context)

    assert not decision.allowed
    assert "operator halted" in decision.reason


async def test_an_exit_is_not_stopped_by_a_zero_price(stock: Instrument) -> None:
    """A zero print is a feed defect. It stops an entry -- it reads as a free
    trade -- and it is not a reason to sit in a position."""
    placed: list[OrderRequest] = []
    zero = Tick(instrument=STOCK, last_price=rupees("0"), timestamp=NOW)
    place = leaving(stock, quote=zero, placed=placed)

    await place(an_order())

    assert len(placed) == 1


async def test_an_exit_is_not_stopped_by_an_order_value_cap(stock: Instrument) -> None:
    placed: list[OrderRequest] = []
    place = leaving(
        stock,
        limits=RiskLimits(max_order_value=rupees("1000")),
        quote=a_quote(),
        placed=placed,
    )

    await place(an_order(10))

    assert len(placed) == 1


async def test_an_exit_is_not_stopped_by_a_wide_spread(stock: Instrument) -> None:
    """A wide spread makes leaving expensive. Staying is more expensive."""
    placed: list[OrderRequest] = []
    place = leaving(
        stock,
        limits=RiskLimits(max_spread_fraction=Decimal("0.01")),
        quote=a_wide_quote(),
        placed=placed,
    )

    await place(an_order())

    assert len(placed) == 1


async def test_an_entry_is_stopped_by_a_wide_spread(stock: Instrument) -> None:
    with pytest.raises(OrderRejectedError, match="spread"):
        await wrap(
            stock,
            limits=RiskLimits(max_spread_fraction=Decimal("0.01")),
            quote=a_wide_quote(),
        )(an_order())


async def test_an_exit_is_not_stopped_by_thin_volume(stock: Instrument) -> None:
    placed: list[OrderRequest] = []
    place = leaving(
        stock,
        limits=RiskLimits(min_volume=100_000),
        quote=a_thin_quote(),
        placed=placed,
    )

    await place(an_order())

    assert len(placed) == 1


async def test_an_entry_is_stopped_by_thin_volume(stock: Instrument) -> None:
    with pytest.raises(OrderRejectedError):
        await wrap(stock, limits=RiskLimits(min_volume=100_000), quote=a_thin_quote())(an_order())


async def test_an_exit_after_the_close_is_refused(stock: Instrument) -> None:
    """The exchange refuses it whichever way the order points, and a named
    refusal here is clearer than a broker rejection an hour later."""
    placed: list[OrderRequest] = []
    after_hours = datetime(2026, 8, 31, 12, 0, tzinfo=UTC)
    place = leaving(stock, quote=a_quote(after_hours), placed=placed, at=after_hours)

    with pytest.raises(OrderRejectedError, match="closed"):
        await place(an_order())

    assert placed == []
