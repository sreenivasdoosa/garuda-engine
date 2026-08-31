"""Picking the instrument a leg trades.

Selection fails for ordinary reasons — no spot yet, a strike the exchange never
listed, an expiry the master lost — and every one answers None. What to do
about that is the evaluator's decision, not the selector's.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.engine.selectors import (
    FixedInstrumentSelector,
    HedgeStrikeSelector,
    NearMonthFutureSelector,
    OptionStrikeSelector,
    UnderlyingSelector,
)
from garuda.engine.strikes import Moneyness

NIFTY = InstrumentId("NSE:NIFTY")
WEEKLY = date(2026, 9, 3)
MONTHLY = date(2026, 9, 24)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@dataclass
class FakeChain:
    """A master that lists whatever a test says it lists."""

    price: Money | None = None
    gap: Decimal | None = Decimal(50)
    expiries: dict[ExpiryKind, date] = field(
        default_factory=lambda: {ExpiryKind.WEEKLY: WEEKLY, ExpiryKind.MONTHLY: MONTHLY}
    )
    listed: set[Decimal] | None = None
    futures: dict[date, InstrumentId] = field(default_factory=dict)

    def spot(self, underlying: InstrumentId) -> Money | None:
        return self.price

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        return self.gap

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        return self.expiries.get(kind)

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        if self.listed is not None and strike not in self.listed:
            return None
        side = "CE" if option_type is OptionType.CALL else "PE"
        return InstrumentId(f"NFO:X{expiry:%y%m%d}{int(strike)}{side}")

    def future(self, underlying: InstrumentId, expiry: date) -> InstrumentId | None:
        return self.futures.get(expiry)


@pytest.fixture
def chain() -> FakeChain:
    return FakeChain(price=rupees("25010"))


# -- the simple ones --------------------------------------------------------


def test_a_fixed_selector_always_names_the_same_instrument(chain: FakeChain) -> None:
    stock = InstrumentId("NSE:RELIANCE")

    assert FixedInstrumentSelector(stock).select(NIFTY, chain) == stock


def test_the_underlying_selector_trades_the_underlying(chain: FakeChain) -> None:
    assert UnderlyingSelector().select(NIFTY, chain) == NIFTY


# -- options ----------------------------------------------------------------


def test_an_at_the_money_call_is_picked_around_the_spot(chain: FakeChain) -> None:
    chosen = OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325000CE")


def test_a_straddle_is_two_legs_differing_only_in_side(chain: FakeChain) -> None:
    call = OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain)
    put = OptionStrikeSelector(OptionType.PUT).select(NIFTY, chain)

    assert call == InstrumentId("NFO:X26090325000CE")
    assert put == InstrumentId("NFO:X26090325000PE")


def test_a_strangle_sits_either_side_of_the_money(chain: FakeChain) -> None:
    two_out = Moneyness.parse("OTM+2")

    call = OptionStrikeSelector(OptionType.CALL, moneyness=two_out).select(NIFTY, chain)
    put = OptionStrikeSelector(OptionType.PUT, moneyness=two_out).select(NIFTY, chain)

    assert call == InstrumentId("NFO:X26090325100CE")
    assert put == InstrumentId("NFO:X26090324900PE")


def test_the_monthly_series_is_a_different_expiry(chain: FakeChain) -> None:
    chosen = OptionStrikeSelector(OptionType.CALL, expiry_kind=ExpiryKind.MONTHLY).select(
        NIFTY, chain
    )

    assert chosen == InstrumentId("NFO:X26092425000CE")


def test_no_spot_price_means_no_strike(chain: FakeChain) -> None:
    chain.price = None

    assert OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain) is None


def test_no_strike_gap_means_no_strike(chain: FakeChain) -> None:
    """Without spacing there is nothing to round to."""
    chain.gap = None

    assert OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain) is None


def test_a_gap_of_nothing_is_refused_quietly(chain: FakeChain) -> None:
    chain.gap = Decimal(0)

    assert OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain) is None


def test_an_expiry_the_master_lost_means_no_option(chain: FakeChain) -> None:
    """The staleness guard answers None, and a leg must not be resolved
    against the wrong series."""
    chain.expiries = {}

    assert OptionStrikeSelector(OptionType.CALL).select(NIFTY, chain) is None


def test_a_strike_the_exchange_never_listed_is_no_instrument(chain: FakeChain) -> None:
    """Ordinary in the wings."""
    chain.listed = {Decimal(25000)}

    far = OptionStrikeSelector(OptionType.CALL, moneyness=Moneyness(20))

    assert far.select(NIFTY, chain) is None


def test_a_strike_walked_past_zero_is_not_looked_up(chain: FakeChain) -> None:
    """A deep in-the-money offset on a low-priced underlying. Asking the master
    for it would be a lookup that can only fail."""
    chain.price = rupees("100")
    deep = OptionStrikeSelector(OptionType.CALL, moneyness=Moneyness(-10))

    assert deep.select(NIFTY, chain) is None


# -- hedges -----------------------------------------------------------------


def test_a_hedge_sits_further_out_than_the_money(chain: FakeChain) -> None:
    hedge = HedgeStrikeSelector(OptionType.CALL, steps_out=2).select(NIFTY, chain)

    assert hedge == InstrumentId("NFO:X26090325100CE")


def test_a_put_hedge_goes_the_other_way(chain: FakeChain) -> None:
    hedge = HedgeStrikeSelector(OptionType.PUT, steps_out=2).select(NIFTY, chain)

    assert hedge == InstrumentId("NFO:X26090324900PE")


def test_a_hedge_at_the_money_is_not_a_hedge() -> None:
    with pytest.raises(DomainError, match="not further out"):
        HedgeStrikeSelector(OptionType.CALL, steps_out=0)


def test_a_hedge_is_further_out_than_what_it_protects(chain: FakeChain) -> None:
    """The property that makes it a hedge at all."""
    sold = OptionStrikeSelector(OptionType.CALL, moneyness=Moneyness.parse("OTM+1"))
    bought = HedgeStrikeSelector(OptionType.CALL, steps_out=3)

    sold_strike = int(str(sold.select(NIFTY, chain)).split("X260903")[1][:-2])
    hedge_strike = int(str(bought.select(NIFTY, chain)).split("X260903")[1][:-2])

    assert hedge_strike > sold_strike


# -- futures ----------------------------------------------------------------


def test_a_future_is_picked_on_its_expiry(chain: FakeChain) -> None:
    listed = InstrumentId("NFO:XSEPFUT")
    chain.futures = {MONTHLY: listed}

    assert NearMonthFutureSelector().select(NIFTY, chain) == listed


def test_a_future_nobody_listed_is_no_instrument(chain: FakeChain) -> None:
    assert NearMonthFutureSelector().select(NIFTY, chain) is None
