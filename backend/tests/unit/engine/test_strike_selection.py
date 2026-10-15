"""Choosing strikes, by each of the reference's six strike types."""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from decimal import Decimal
from zoneinfo import ZoneInfo

from garuda.domain.enums import Direction, OptionType
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, DepthLevel, Tick
from garuda.domain.money import Currency, Money
from garuda.engine.config import ResolvedConfig
from garuda.engine.strike_selection import (
    StrikePair,
    StrikeRequest,
    book_price,
    select_strikes,
)
from garuda.engine.vocabulary import StrikeType

IST = ZoneInfo("Asia/Kolkata")
NOW = dt.datetime(2026, 10, 15, 10, 0, tzinfo=IST)
EXPIRY = dt.date(2026, 10, 20)
NIFTY = InstrumentId("NSE:NIFTY")


def rupees(value: str | int | Decimal) -> Money:
    return Money(Decimal(value), Currency.INR)


def oid(strike: Decimal, option_type: OptionType) -> InstrumentId:
    return InstrumentId(f"NFO:N{int(strike)}{'CE' if option_type is OptionType.CALL else 'PE'}")


def call_premium(strike: Decimal) -> Decimal:
    """A call loses 1 point of premium per point of strike above 22000, floored at 1."""
    return max(Decimal(1), Decimal(700) - (strike - Decimal(22000)) * Decimal("0.6"))


def put_premium(strike: Decimal) -> Decimal:
    return max(Decimal(1), Decimal(700) - (Decimal(23000) - strike) * Decimal("0.6"))


@dataclass
class Chain:
    premiums: dict[InstrumentId, Decimal] = field(default_factory=dict)
    oi: dict[InstrumentId, int] = field(default_factory=dict)
    lows: dict[InstrumentId, Decimal] = field(default_factory=dict)

    def __post_init__(self) -> None:
        for n in range(-30, 31):
            strike = Decimal(22500 + 50 * n)
            self.premiums.setdefault(oid(strike, OptionType.CALL), call_premium(strike))
            self.premiums.setdefault(oid(strike, OptionType.PUT), put_premium(strike))

    def option(
        self, underlying: InstrumentId, expiry: dt.date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None:
        listed = oid(strike, option_type)
        return listed if listed in self.premiums else None

    def quote(self, instrument: InstrumentId) -> Tick | None:
        premium = self.premiums.get(instrument)
        if premium is None:
            return None
        return Tick(
            instrument=instrument,
            last_price=rupees(premium),
            timestamp=NOW,
            open_interest=self.oi.get(instrument),
        )

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        low = self.lows.get(instrument)
        if low is None:
            return []
        return [
            Bar(
                instrument=instrument,
                interval=BarInterval.ONE_MINUTE,
                start=NOW - dt.timedelta(minutes=5),
                open=rupees(low + 5),
                high=rupees(low + 10),
                low=rupees(low),
                close=rupees(low + 2),
                volume=100,
            )
        ]


def request(chain: Chain, *, spot: str = "22512", **values: object) -> StrikeRequest:
    return StrikeRequest(
        underlying=NIFTY,
        expiry=EXPIRY,
        price=rupees(spot),
        gap=Decimal(50),
        config=ResolvedConfig(strategy="s", values=values),
        chain=chain,
        now=NOW,
        expires_at=dt.datetime(2026, 10, 20, 15, 30, tzinfo=IST),
    )


def strikes(result: StrikePair | str) -> tuple[object, object]:
    assert isinstance(result, StrikePair), result
    return result.call, result.put


class TestMoneyness:
    def test_atm_and_offsets(self) -> None:
        chain = Chain()
        assert strikes(select_strikes(StrikeType.MONEYNESS, request(chain))) == (22500, 22500)
        otm = request(chain, strike_value="OTM+2")
        assert strikes(select_strikes(StrikeType.MONEYNESS, otm)) == (22600, 22400)
        itm = request(chain, strike_value="ITM+1")
        assert strikes(select_strikes(StrikeType.MONEYNESS, itm)) == (22450, 22550)


class TestBalancedStraddle:
    def balanced(self, chain: Chain) -> StrikePair | str:
        req = request(chain)
        return select_strikes(
            StrikeType.MONEYNESS,
            replace(req, use_premium_balancing=True),
        )

    def test_a_balanced_atm_straddle_stays_at_the_money(self) -> None:
        chain = Chain()
        chain.premiums[oid(Decimal(22500), OptionType.CALL)] = Decimal(200)
        chain.premiums[oid(Decimal(22500), OptionType.PUT)] = Decimal(210)
        assert strikes(self.balanced(chain)) == (22500, 22500)

    def test_an_unbalanced_atm_moves_to_a_balanced_nearby_straddle(self) -> None:
        chain = Chain()
        chain.premiums[oid(Decimal(22500), OptionType.CALL)] = Decimal(300)
        chain.premiums[oid(Decimal(22500), OptionType.PUT)] = Decimal(150)
        chain.premiums[oid(Decimal(22550), OptionType.CALL)] = Decimal(190)
        chain.premiums[oid(Decimal(22550), OptionType.PUT)] = Decimal(180)
        result = self.balanced(chain)
        assert strikes(result) == (22550, 22550)


class TestFixedPremium:
    def test_the_strike_nearest_the_target_out_of_the_money(self) -> None:
        call, put = strikes(
            select_strikes(StrikeType.FIXED_PREMIUM, request(Chain(), option_premium=100))
        )
        assert isinstance(call, Decimal)
        assert isinstance(put, Decimal)
        assert abs(call_premium(call) - 100) <= 30
        assert abs(put_premium(put) - 100) <= 30
        assert call > 22500
        assert put < 22500

    def test_without_a_target_it_is_refused(self) -> None:
        assert select_strikes(StrikeType.FIXED_PREMIUM, request(Chain())) == (
            "FixedPremium needs optionPremium"
        )


class TestPremiumRange:
    def test_the_furthest_strike_still_above_the_floor(self) -> None:
        wide = replace(request(Chain(), option_premium=50, option_premium_upper=200), levels=40)
        call, _ = strikes(select_strikes(StrikeType.PREMIUM_RANGE, wide))
        assert isinstance(call, Decimal)
        assert call_premium(call) > 50
        assert call_premium(call + 50) <= 50

    def test_the_search_stops_at_the_chain_levels(self) -> None:
        narrow = request(Chain(), option_premium=50, option_premium_upper=200)
        call, _ = strikes(select_strikes(StrikeType.PREMIUM_RANGE, narrow))
        assert call == 22950  # ATM + 9 strikes: the furthest the 10 levels reach

    def test_refused_when_the_floor_strike_is_above_the_ceiling(self) -> None:
        result = select_strikes(
            StrikeType.PREMIUM_RANGE,
            request(Chain(), option_premium=50, option_premium_upper=55),
        )
        assert isinstance(result, str)


class TestOiRanked:
    def test_the_nth_highest_open_interest_inside_the_range(self) -> None:
        chain = Chain()
        for strike, oi in ((22550, 500), (22600, 900), (22650, 700)):
            chain.oi[oid(Decimal(strike), OptionType.CALL)] = oi
        for strike, oi in ((22400, 800), (22350, 600)):
            chain.oi[oid(Decimal(strike), OptionType.PUT)] = oi
        first = request(chain, option_premium=300, option_premium_upper=600, oi_rank=1)
        assert strikes(select_strikes(StrikeType.PREMIUM_RANGE_OI_RANKED, first)) == (22600, 22400)
        second = request(chain, option_premium=300, option_premium_upper=600, oi_rank=2)
        assert strikes(select_strikes(StrikeType.PREMIUM_RANGE_OI_RANKED, second)) == (22650, 22350)


class TestCandleLow:
    def test_the_strike_whose_recent_low_is_nearest_the_target(self) -> None:
        chain = Chain()
        chain.lows[oid(Decimal(22600), OptionType.CALL)] = Decimal(140)
        chain.lows[oid(Decimal(22700), OptionType.CALL)] = Decimal(98)
        chain.lows[oid(Decimal(22300), OptionType.PUT)] = Decimal(103)
        result = select_strikes(
            StrikeType.CANDLE_LOW_NEAR_PREMIUM, request(chain, option_premium=100)
        )
        assert strikes(result) == (22700, 22300)

    def test_no_history_is_refused(self) -> None:
        result = select_strikes(
            StrikeType.CANDLE_LOW_NEAR_PREMIUM, request(Chain(), option_premium=100)
        )
        assert isinstance(result, str)


class TestFixedDelta:
    def test_a_quarter_delta_is_out_of_the_money_on_both_sides(self) -> None:
        chain = Chain()
        call, put = strikes(
            select_strikes(StrikeType.FIXED_DELTA, request(chain, target_delta="0.25"))
        )
        assert isinstance(call, Decimal)
        assert isinstance(put, Decimal)
        assert call > 22512 > put

    def test_an_impossible_target_is_refused(self) -> None:
        result = select_strikes(StrikeType.FIXED_DELTA, request(Chain(), target_delta="1.5"))
        assert isinstance(result, str)


def test_book_price_weights_the_side_the_order_meets() -> None:
    tick = Tick(
        instrument=NIFTY,
        last_price=rupees(100),
        timestamp=NOW,
        bids=(
            DepthLevel(price=rupees(99), quantity=100),
            DepthLevel(price=rupees(98), quantity=300),
        ),
        asks=(DepthLevel(price=rupees(101), quantity=50),),
    )
    assert book_price(tick, Direction.SHORT) == Decimal("98.25")
    assert book_price(tick, Direction.LONG) == Decimal("101.00")
    bare = Tick(instrument=NIFTY, last_price=rupees(100), timestamp=NOW)
    assert book_price(bare, Direction.SHORT) == Decimal(100)
