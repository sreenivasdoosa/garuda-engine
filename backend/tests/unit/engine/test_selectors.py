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
from garuda.domain.strikes import Moneyness
from garuda.engine.selectors import (
    MAX_STRIKES_SEARCHED,
    FixedInstrumentSelector,
    HedgeStrikeSelector,
    NearMonthFutureSelector,
    OptionStrikeSelector,
    PremiumSelector,
    UnderlyingSelector,
)

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
    premiums: dict[InstrumentId, Money] = field(default_factory=dict)

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

    def strikes(self, underlying: InstrumentId, expiry: date) -> list[Decimal]:
        return sorted(self.listed or set())

    def premium(self, instrument: InstrumentId) -> Money | None:
        return self.premiums.get(instrument)


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


# -- by premium -------------------------------------------------------------


def priced(chain: FakeChain, prices: dict[int, str], side: OptionType) -> None:
    """List those strikes and quote them."""
    letters = "CE" if side is OptionType.CALL else "PE"
    chain.listed = {Decimal(strike) for strike in prices}
    chain.premiums = {
        InstrumentId(f"NFO:X{WEEKLY:%y%m%d}{strike}{letters}"): rupees(price)
        for strike, price in prices.items()
    }


def test_the_strike_nearest_a_target_premium_is_chosen(chain: FakeChain) -> None:
    """What an operator means by "sell the hundred-rupee call": a price, not a
    distance, so the same strategy sits far out on a quiet day and close in on
    a busy one."""
    priced(chain, {25000: "180", 25050: "140", 25100: "105", 25150: "70"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325100CE")


def test_a_different_target_finds_a_different_strike(chain: FakeChain) -> None:
    priced(chain, {25000: "180", 25050: "140", 25100: "105", 25150: "70"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(70)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325150CE")


def test_a_target_nobody_is_near_is_refused_when_a_tolerance_is_set(
    chain: FakeChain,
) -> None:
    """Without one, whichever strike happened to be least wrong is answered."""
    priced(chain, {25000: "180", 25100: "105"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(10), tolerance=Decimal(5)).select(
        NIFTY, chain
    )

    assert chosen is None


def test_within_the_tolerance_it_is_chosen(chain: FakeChain) -> None:
    priced(chain, {25100: "105"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100), tolerance=Decimal(10)).select(
        NIFTY, chain
    )

    assert chosen == InstrumentId("NFO:X26090325100CE")


def test_a_tie_goes_to_the_strike_further_out(chain: FakeChain) -> None:
    """The safer side for a seller, and without a tie-break the answer depends
    on the order the exchange listed them."""
    priced(chain, {25050: "110", 25100: "90"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325100CE")


def test_the_tie_break_can_be_reversed(chain: FakeChain) -> None:
    priced(chain, {25050: "110", 25100: "90"}, OptionType.CALL)

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100), prefer_further_out=False).select(
        NIFTY, chain
    )

    assert chosen == InstrumentId("NFO:X26090325050CE")


def test_a_strike_nobody_is_quoting_is_skipped(chain: FakeChain) -> None:
    """The ordinary state outside the chain the engine subscribes to."""
    priced(chain, {25100: "105"}, OptionType.CALL)
    chain.listed = {Decimal(25100), Decimal(30000)}  # 30000 listed, unquoted

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325100CE")


def test_nothing_quoted_at_all_finds_nothing(chain: FakeChain) -> None:
    chain.listed = {Decimal(25000)}

    assert PremiumSelector(OptionType.CALL).select(NIFTY, chain) is None


def test_a_put_is_priced_on_its_own_side(chain: FakeChain) -> None:
    priced(chain, {24900: "70", 24950: "105"}, OptionType.PUT)

    chosen = PremiumSelector(OptionType.PUT, target=Decimal(100)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090324950PE")


def test_no_spot_means_no_search(chain: FakeChain) -> None:
    """The search runs outward from the money, and without a price there is
    no money to run outward from."""
    priced(chain, {25100: "105"}, OptionType.CALL)
    chain.price = None

    assert PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain) is None


def test_no_expiry_means_no_option(chain: FakeChain) -> None:
    priced(chain, {25100: "105"}, OptionType.CALL)
    chain.expiries = {}

    assert PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain) is None


def test_a_target_premium_of_nothing_is_not_a_premium() -> None:
    with pytest.raises(DomainError, match="not a premium"):
        PremiumSelector(OptionType.CALL, target=Decimal(0))


def test_a_negative_tolerance_is_not_a_tolerance() -> None:
    with pytest.raises(DomainError, match="not a tolerance"):
        PremiumSelector(OptionType.CALL, tolerance=Decimal(-1))


def test_the_search_runs_outward_from_the_money(chain: FakeChain) -> None:
    """A real chain lists far more strikes than the search will walk, and the
    ones worth walking are near the money. Taken in listed order the search
    spends its whole budget on deep in-the-money strikes nobody quotes and
    finds nothing."""
    deep = {Decimal(20000 + step * 50) for step in range(100)}
    chain.listed = deep | {Decimal(25000), Decimal(25100)}
    chain.premiums = {
        InstrumentId(f"NFO:X{WEEKLY:%y%m%d}25100CE"): rupees("105"),
    }

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain)

    assert chosen == InstrumentId("NFO:X26090325100CE")


def test_a_premium_only_found_far_from_the_money_is_not_found(chain: FakeChain) -> None:
    """A deliberate bound. The search walks a fixed distance either side and
    stops: a target that matches only fifty strikes out is a target nobody
    meant, and scanning a whole chain every second for every leg costs more
    than it can ever be worth."""
    far = Decimal(25000 + MAX_STRIKES_SEARCHED * 50 + 500)
    chain.listed = {Decimal(25000 + step * 50) for step in range(MAX_STRIKES_SEARCHED + 20)} | {far}
    chain.premiums = {InstrumentId(f"NFO:X{WEEKLY:%y%m%d}{int(far)}CE"): rupees("100")}

    chosen = PremiumSelector(OptionType.CALL, target=Decimal(100)).select(NIFTY, chain)

    assert chosen is None
