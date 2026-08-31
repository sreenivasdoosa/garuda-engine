"""Series the engine prices itself.

The rolling straddle is the interesting one: it is the *cheapest* pair on the
board rather than the nearest strike, and it refuses to publish from a chain
too thin to know that.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Money
from garuda.domain.enums import ExpiryKind, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.marketdata.pricing import black_scholes, years_to_expiry
from garuda.marketdata.synthetics import (
    ImpliedVolatility,
    ImpliedVolatilitySkew,
    PutCallRatio,
    RollingStraddle,
    SyntheticFuture,
    SyntheticPublisher,
    build,
    for_symbols,
)

NOW = datetime(2026, 8, 31, 10, 0, tzinfo=UTC)
TODAY = NOW.date()
EXPIRY = date(2026, 9, 3)
NIFTY = InstrumentId("NSE:NIFTY")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


@dataclass
class FakeChain:
    """A chain that quotes whatever a test says."""

    price: Money | None = None
    gap: Decimal | None = Decimal(50)
    expiry_on: date | None = EXPIRY
    calls: dict[int, str] = field(default_factory=dict)
    puts: dict[int, str] = field(default_factory=dict)
    call_oi: dict[int, int] = field(default_factory=dict)
    put_oi: dict[int, int] = field(default_factory=dict)

    def spot(self, underlying: InstrumentId) -> Money | None:
        return self.price

    def strike_gap(self, underlying: InstrumentId) -> Decimal | None:
        return self.gap

    def expiry(self, underlying: InstrumentId, kind: ExpiryKind) -> date | None:
        return self.expiry_on

    def option(
        self,
        underlying: InstrumentId,
        expiry: date,
        strike: Decimal,
        option_type: OptionType,
    ) -> InstrumentId | None:
        side = "CE" if option_type is OptionType.CALL else "PE"
        return InstrumentId(f"NFO:N{int(strike)}{side}")

    def today(self) -> date:
        return TODAY

    def quote(self, instrument: InstrumentId) -> Tick | None:
        text = instrument.value.removeprefix("NFO:N")
        strike, side = int(text[:-2]), text[-2:]
        prices = self.calls if side == "CE" else self.puts
        interest = self.call_oi if side == "CE" else self.put_oi
        if strike not in prices:
            return None
        return Tick(
            instrument=instrument,
            last_price=rupees(prices[strike]),
            timestamp=NOW,
            open_interest=interest.get(strike),
        )


def chain_around(spot: str, pairs: dict[int, tuple[str, str]]) -> FakeChain:
    return FakeChain(
        price=rupees(spot),
        calls={strike: call for strike, (call, _) in pairs.items()},
        puts={strike: put for strike, (_, put) in pairs.items()},
    )


#: Five strikes quoted around a spot of 25010. The combined premium is least
#: at the money and rises either side, which is the shape a real chain has:
#: away from the money one leg gains intrinsic value faster than both lose
#: time value.
FULL = {
    24900: ("200", "60"),  # 260
    24950: ("165", "80"),  # 245
    25000: ("130", "100"),  # 230
    25050: ("105", "135"),  # 240
    25100: ("85", "170"),  # 255
}


# -- the rolling straddle ---------------------------------------------------


def test_the_straddle_is_the_cheapest_pair_on_the_board() -> None:
    """The strike whose call and put together cost least *is* the market's
    at-the-money, and it can sit a strike away from the one nearest spot."""
    chain = chain_around("25010", FULL)

    price = RollingStraddle(underlying=NIFTY, levels=2).price(chain)

    assert price == rupees("230")  # 25000: 130 + 100


def test_the_cheapest_pair_need_not_be_the_nearest_strike() -> None:
    """Which is the whole reason to search rather than to look it up."""
    moved = dict(FULL)
    moved[25050] = ("60", "60")  # cheaper than the nearest strike's pair
    chain = chain_around("25010", moved)

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) == rupees("120")


def test_a_chain_too_thin_publishes_nothing() -> None:
    """A minimum that is only the minimum because its neighbours are missing
    is not a straddle price."""
    chain = chain_around("25010", {25000: ("140", "130")})

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_the_money_itself_must_be_quoted() -> None:
    without_atm = {strike: pair for strike, pair in FULL.items() if strike != 25000}
    chain = chain_around("25010", without_atm)

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_both_sides_must_be_quoted() -> None:
    one_sided = {strike: pair for strike, pair in FULL.items() if strike >= 25000}
    chain = chain_around("25010", one_sided)

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_the_strikes_above_the_money_must_be_quoted_too() -> None:
    """The mirror of the case above. A chain quoted on one side only cannot
    say which pair is cheapest, whichever side is missing."""
    one_sided = {strike: pair for strike, pair in FULL.items() if strike <= 25000}
    chain = chain_around("25010", one_sided)

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_a_strike_with_only_one_side_quoted_is_not_a_pair() -> None:
    chain = chain_around("25010", FULL)
    del chain.puts[24900]

    # 24900 no longer counts towards the strikes below, so two are needed from
    # 24950 alone and there is only one.
    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_no_spot_means_no_straddle() -> None:
    chain = chain_around("25010", FULL)
    chain.price = None

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_no_expiry_means_no_straddle() -> None:
    chain = chain_around("25010", FULL)
    chain.expiry_on = None

    assert RollingStraddle(underlying=NIFTY, levels=2).price(chain) is None


def test_a_chain_of_no_strikes_is_not_a_chain() -> None:
    with pytest.raises(DomainError, match="is not a chain"):
        RollingStraddle(underlying=NIFTY, levels=0)


def test_the_straddle_names_itself_after_its_underlying() -> None:
    assert RollingStraddle(underlying=NIFTY).instrument().value == "SYNTH:STRADDLE-NIFTY"


# -- the put-call ratio -----------------------------------------------------


def test_more_puts_than_calls_reads_above_one() -> None:
    chain = chain_around("25010", FULL)
    chain.call_oi = dict.fromkeys(FULL, 100)
    chain.put_oi = dict.fromkeys(FULL, 200)

    assert PutCallRatio(underlying=NIFTY, levels=2).price(chain) == rupees("2")


def test_a_chain_with_no_call_interest_is_undefined_not_infinite() -> None:
    chain = chain_around("25010", FULL)
    chain.put_oi = dict.fromkeys(FULL, 200)

    assert PutCallRatio(underlying=NIFTY, levels=2).price(chain) is None


def test_the_ratio_names_itself_after_its_underlying() -> None:
    assert PutCallRatio(underlying=NIFTY).instrument().value == "SYNTH:PCR-NIFTY"


# -- the synthetic future ---------------------------------------------------


def test_put_call_parity_gives_the_implied_future() -> None:
    """Strike plus call minus put, at the money."""
    chain = chain_around("25010", FULL)

    assert SyntheticFuture(underlying=NIFTY, levels=2).price(chain) == rupees("25030")


def test_a_missing_side_leaves_the_future_unpriced() -> None:
    chain = chain_around("25010", FULL)
    del chain.calls[25000]

    assert SyntheticFuture(underlying=NIFTY, levels=2).price(chain) is None


# -- publishing -------------------------------------------------------------


def test_a_published_tick_carries_the_day_it_opened_at() -> None:
    """No broker has a synthetic's history, so "10% below its open" is only
    answerable because the open travels on the tick."""
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    chain = chain_around("25010", FULL)

    publisher.ticks(chain, NOW)
    cheaper = dict(FULL)
    cheaper[25000] = ("100", "100")
    [tick] = publisher.ticks(chain_around("25010", cheaper), NOW)

    assert tick.open == rupees("230")
    assert tick.last_price == rupees("200")


def test_the_high_and_low_of_the_day_are_tracked() -> None:
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    publisher.ticks(chain_around("25010", FULL), NOW)

    # Volatility rose: every pair on the board got dearer, so the cheapest
    # one did too.
    dearer = {
        strike: (str(int(call) * 2), str(int(put) * 2)) for strike, (call, put) in FULL.items()
    }
    [tick] = publisher.ticks(chain_around("25010", dearer), NOW)

    assert tick.high == rupees("460")
    assert tick.low == rupees("230")


def test_the_high_is_the_peak_of_the_day_not_the_latest() -> None:
    """A high that follows the price down is not a high."""
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    dearer = {
        strike: (str(int(call) * 2), str(int(put) * 2)) for strike, (call, put) in FULL.items()
    }
    publisher.ticks(chain_around("25010", dearer), NOW)

    [tick] = publisher.ticks(chain_around("25010", FULL), NOW)

    assert tick.high == rupees("460")
    assert tick.last_price == rupees("230")


def test_a_calendar_day_rolling_over_starts_the_opening_value_again() -> None:
    """A session that ran past midnight would otherwise report yesterday's
    open all through today."""
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    publisher.ticks(chain_around("25010", FULL), NOW)

    cheaper = {
        strike: (str(int(call) // 2), str(int(put) // 2)) for strike, (call, put) in FULL.items()
    }
    tomorrow = NOW + timedelta(days=1)
    [tick] = publisher.ticks(chain_around("25010", cheaper), tomorrow)

    assert tick.open == rupees("115")


def test_a_published_tick_says_it_is_synthetic() -> None:
    """Anything keeping a time series must skip it, and anything routing an
    order must never see one."""
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))

    [tick] = publisher.ticks(chain_around("25010", FULL), NOW)

    assert tick.is_synthetic


def test_a_synthetic_the_chain_cannot_answer_publishes_nothing() -> None:
    """A stale repeat is indistinguishable from a quiet market, and one of
    those is a fault."""
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    publisher.ticks(chain_around("25010", FULL), NOW)

    assert publisher.ticks(chain_around("25010", {25000: ("1", "1")}), NOW) == []


def test_a_source_that_raises_does_not_stop_the_others() -> None:
    class Broken:
        underlying = NIFTY

        def instrument(self) -> InstrumentId:
            return InstrumentId("SYNTH:BROKEN")

        def price(self, view: object) -> Money | None:
            raise RuntimeError("this source is broken")

    publisher = SyntheticPublisher(sources=(Broken(), RollingStraddle(underlying=NIFTY, levels=2)))

    produced = publisher.ticks(chain_around("25010", FULL), NOW)

    assert len(produced) == 1


def test_a_new_day_starts_the_opening_value_again() -> None:
    publisher = SyntheticPublisher(sources=(RollingStraddle(underlying=NIFTY, levels=2),))
    publisher.ticks(chain_around("25010", FULL), NOW)

    publisher.forget_day()
    cheaper = dict(FULL)
    cheaper[25000] = ("100", "100")
    [tick] = publisher.ticks(chain_around("25010", cheaper), NOW)

    assert tick.open == rupees("200")


# -- what is maintained -----------------------------------------------------


def test_every_curated_underlying_gets_its_series() -> None:
    sources = for_symbols([NIFTY])

    assert {source.instrument().value for source in sources} == {
        "SYNTH:STRADDLE-NIFTY",
        "SYNTH:PCR-NIFTY",
        "SYNTH:SYNFUT-NIFTY",
        "SYNTH:IV-NIFTY",
        "SYNTH:IVSKEW-NIFTY",
    }


def test_a_synthetic_builds_from_configuration() -> None:
    built = build({"type": "rolling_straddle", "underlying": "NSE:NIFTY", "levels": 5})

    assert isinstance(built, RollingStraddle)
    assert built.levels == 5


# -- implied volatility -----------------------------------------------------


def priced_by_model(volatility: str, *, days: int = 30) -> FakeChain:
    """A chain quoted at exactly what the model says, so the solver should
    recover the volatility it was priced with."""
    spot = Decimal(25010)
    chain = FakeChain(price=Money(spot, Currency.INR), expiry_on=TODAY + timedelta(days=days))
    years = years_to_expiry(Decimal(days))
    for step in range(-2, 3):
        strike = Decimal(25000) + step * 50
        for side, book in ((OptionType.CALL, chain.calls), (OptionType.PUT, chain.puts)):
            book[int(strike)] = str(
                black_scholes(
                    option_type=side,
                    spot=spot,
                    strike=strike,
                    years=years,
                    volatility=Decimal(volatility),
                    rate=Decimal("0.065"),
                )
            )
    return chain


def test_the_volatility_a_price_implies_is_recovered() -> None:
    """Priced at 18% and read back as 18%, which is the round trip that says
    the model and the solver agree."""
    chain = priced_by_model("0.18")

    value = ImpliedVolatility(underlying=NIFTY, levels=2).price(chain)

    assert value is not None
    assert abs(value.amount - Decimal(18)) < Decimal("0.01")


def test_volatility_is_published_as_a_percentage() -> None:
    """Which is how every screen shows it, and therefore how a threshold will
    be configured."""
    chain = priced_by_model("0.18")

    value = ImpliedVolatility(underlying=NIFTY, levels=2).price(chain)

    assert value is not None
    assert value.amount > Decimal(1)  # 18, not 0.18


def test_a_chain_priced_evenly_has_no_skew() -> None:
    chain = priced_by_model("0.18")

    skew = ImpliedVolatilitySkew(underlying=NIFTY, levels=2).price(chain)

    assert skew is not None
    assert abs(skew.amount) < Decimal("0.01")


def test_dearer_puts_read_as_a_negative_skew() -> None:
    """The usual state in an index, where puts carry a protection premium."""
    chain = priced_by_model("0.18")
    chain.puts[25000] = str(Decimal(chain.puts[25000]) * Decimal("1.3"))

    skew = ImpliedVolatilitySkew(underlying=NIFTY, levels=2).price(chain)

    assert skew is not None
    assert skew.amount < 0


def test_dearer_calls_read_as_a_positive_skew() -> None:
    chain = priced_by_model("0.18")
    chain.calls[25000] = str(Decimal(chain.calls[25000]) * Decimal("1.3"))

    skew = ImpliedVolatilitySkew(underlying=NIFTY, levels=2).price(chain)

    assert skew is not None
    assert skew.amount > 0


def test_a_skew_needs_both_sides() -> None:
    """A skew computed from one leg is not a skew."""
    chain = priced_by_model("0.18")
    del chain.puts[25000]

    assert ImpliedVolatilitySkew(underlying=NIFTY, levels=2).price(chain) is None


def test_one_side_is_enough_for_the_level() -> None:
    """The level is what it is whichever leg carries it; only the skew needs
    the pair."""
    chain = priced_by_model("0.18")
    del chain.puts[25000]

    assert ImpliedVolatility(underlying=NIFTY, levels=2).price(chain) is not None


def test_on_expiry_day_there_is_no_volatility_to_imply() -> None:
    """The model has no time left to work with, and a number computed from
    none of it has no meaning rather than a large value."""
    chain = priced_by_model("0.18", days=30)
    chain.expiry_on = TODAY

    assert ImpliedVolatility(underlying=NIFTY, levels=2).price(chain) is None


def test_a_price_at_or_below_intrinsic_implies_nothing() -> None:
    """There is nothing left for volatility to account for."""
    chain = priced_by_model("0.18")
    chain.calls[25000] = "10"  # spot 25010 against strike 25000: all intrinsic
    del chain.puts[25000]

    assert ImpliedVolatility(underlying=NIFTY, levels=2).price(chain) is None


def test_the_level_averages_the_two_sides() -> None:
    """Either leg alone carries the skew; the level is meant to carry the
    level, so it is the mean of the pair rather than whichever came first."""
    chain = priced_by_model("0.18")
    chain.calls[25000] = str(Decimal(chain.calls[25000]) * Decimal("1.4"))

    skew = ImpliedVolatilitySkew(underlying=NIFTY, levels=2).price(chain)
    level = ImpliedVolatility(underlying=NIFTY, levels=2).price(chain)

    assert skew is not None
    assert level is not None
    # The puts are still at 18 and the calls are dearer by the skew, so the
    # mean sits half a skew above 18 — not at either leg's own reading.
    assert abs(level.amount - (Decimal(18) + skew.amount / 2)) < Decimal("0.05")
