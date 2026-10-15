"""Choosing the strikes an option entry trades.

`STRATEGY_ENGINE.md` §4 step 4: the tranche's `strike_type` names a selector,
which answers a call strike and a put strike from the reference price and the
chain. Each is the reference's own rule:

* ``MoneyNess`` -- ATM or n strikes either side; with premium balancing on
  and ATM asked for, the reference's three-step straddle selector;
* ``FixedPremium`` -- the strike, walking out of the money from ATM, whose
  premium is nearest the target;
* ``PremiumRange`` -- the furthest strike out whose premium is still above
  the lower bound, refused if that premium is above the upper;
* ``PremiumRange_OIRanked`` -- of the strikes priced inside the range, the
  one with the n-th highest open interest;
* ``CandleLow_NearPremium`` -- of the strikes within n levels of ATM, the one
  whose lowest one-minute low over the lookback is nearest the target;
* ``FixedDelta`` -- the strike whose delta, solved from its own price, is
  nearest the target, refused when it misses by more than the allowed
  deviation.

Premiums are read the way the reference reads them: the quantity-weighted
average of the top five levels on the side the order will meet -- the bids
for a sale, the asks for a purchase -- and the last price when there is no
depth.

A strike type the engine does not implement is refused by name rather than
read as at-the-money: a strategy that silently trades a different strike than
configured is worse than one that does not trade.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol

from garuda.domain.enums import Direction, OptionType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.money import Money
from garuda.domain.pricing import absolute_delta_from_price
from garuda.domain.strikes import Moneyness, atm_strike
from garuda.engine.config import ResolvedConfig
from garuda.engine.vocabulary import StrikeType

#: The reference's default balance for a straddle, in premium points.
DEFAULT_STRADDLE_MAX_DIFF = Decimal(25)
#: The reference's default `maxDeltaDeviation`.
DEFAULT_MAX_DELTA_DEVIATION = Decimal("0.1")
#: The reference's ITM strikes considered by the OI-ranked search.
OI_RANKED_ITM_STRIKES = 5
SECONDS_PER_YEAR = Decimal(365 * 24 * 60 * 60)


class ChainView(Protocol):
    """What a selector may consult."""

    def option(
        self, underlying: InstrumentId, expiry: date, strike: Decimal, option_type: OptionType
    ) -> InstrumentId | None: ...

    def quote(self, instrument: InstrumentId) -> Tick | None: ...

    def candles(
        self, instrument: InstrumentId, interval: BarInterval, count: int
    ) -> Sequence[Bar]: ...


@dataclass(frozen=True, slots=True)
class StrikeRequest:
    underlying: InstrumentId
    expiry: date
    #: The price strikes are chosen around: spot for an index, the future for
    #: a future-based strategy.
    price: Money
    gap: Decimal
    config: ResolvedConfig
    chain: ChainView
    #: Which way the main legs trade, so premiums are read off the right side.
    direction: Direction = Direction.SHORT
    need_call: bool = True
    need_put: bool = True
    #: How many strikes out from ATM a premium search walks.
    levels: int = 10
    use_premium_balancing: bool = False
    straddle_max_diff: Decimal = DEFAULT_STRADDLE_MAX_DIFF
    now: datetime | None = None
    #: The expiry's close, for the time left in a delta.
    expires_at: datetime | None = None

    @property
    def atm(self) -> Decimal:
        return atm_strike(self.price, self.gap)

    def out_of_the_money(
        self, option_type: OptionType, count: int, *, start: int = 0
    ) -> list[Decimal]:
        """Strikes from ATM (``start`` steps in) walking out, ``count`` of them."""
        step = self.gap if option_type is OptionType.CALL else -self.gap
        return [
            self.atm + step * (start + n) for n in range(count) if self.atm + step * (start + n) > 0
        ]


@dataclass(frozen=True, slots=True)
class StrikePair:
    call: Decimal | None
    put: Decimal | None
    because: str


type StrikeSelector = Callable[[StrikeRequest], StrikePair | str]

_SELECTORS: dict[StrikeType, StrikeSelector] = {}


def strike_selector(kind: StrikeType) -> Callable[[StrikeSelector], StrikeSelector]:
    def register(selector: StrikeSelector) -> StrikeSelector:
        _SELECTORS[kind] = selector
        return selector

    return register


def select_strikes(kind: StrikeType, request: StrikeRequest) -> StrikePair | str:
    """The pair, or why there is none. Never a guess."""
    selector = _SELECTORS.get(kind)
    if selector is None:
        raise DomainError(f"strike type {kind.value} is not implemented by this engine")
    return selector(request)


def implemented() -> tuple[str, ...]:
    return tuple(kind.value for kind in StrikeType if kind in _SELECTORS)


def book_price(tick: Tick, direction: Direction) -> Decimal:
    """The reference's `calculateAverageAskOrBidPrice`: the quantity-weighted
    top five on the side the order meets, or the last price without depth."""
    levels = tick.asks if direction is Direction.LONG else tick.bids
    quantity = 0
    value = Decimal(0)
    for level in levels[:5]:
        quantity += level.quantity
        value += level.price.amount * level.quantity
    if quantity > 0:
        return (value / quantity).quantize(Decimal("0.01"))
    return tick.last_price.amount


# -- helpers -------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class _Priced:
    strike: Decimal
    instrument: InstrumentId
    tick: Tick
    premium: Decimal


def _priced(
    request: StrikeRequest, option_type: OptionType, strikes: Sequence[Decimal]
) -> list[_Priced]:
    """The listed, quoted strikes, in the order given, passing the filters."""
    volume = request.config.whole("volume_filter") or 0
    oi = request.config.whole("oi_filter") or 0
    out: list[_Priced] = []
    for strike in strikes:
        listed = request.chain.option(request.underlying, request.expiry, strike, option_type)
        if listed is None:
            continue
        tick = request.chain.quote(listed)
        if tick is None:
            continue
        if volume > 0 and (tick.volume or 0) < volume:
            continue
        if oi > 0 and (tick.open_interest or 0) < oi:
            continue
        out.append(_Priced(strike, listed, tick, book_price(tick, request.direction)))
    return out


def _atm_if_itm(request: StrikeRequest, pair: StrikePair) -> StrikePair:
    """The reference's `useATMIfITM`: an in-the-money pick becomes ATM."""
    if not request.config.flag("use_atm_if_itm"):
        return pair
    spot = request.price.amount
    call, put = pair.call, pair.put
    if call is not None and call < spot:
        call = request.atm
    if put is not None and put > spot:
        put = request.atm
    return StrikePair(call, put, pair.because)


def _both(
    request: StrikeRequest,
    pick: Callable[[OptionType], Decimal | None],
    because: str,
    missing: str,
) -> StrikePair | str:
    call = pick(OptionType.CALL) if request.need_call else None
    put = pick(OptionType.PUT) if request.need_put else None
    if (request.need_call and call is None) or (request.need_put and put is None):
        return f"{missing} (call {call}, put {put})"
    return _atm_if_itm(request, StrikePair(call, put, because))


# -- the selectors -------------------------------------------------------------


@strike_selector(StrikeType.MONEYNESS)
def moneyness(request: StrikeRequest) -> StrikePair | str:
    """ATM, or a number of strikes either side of it. Call and put move in
    opposite directions: OTM+1 is one above the money for the call and one
    below for the put."""
    value = request.config.text("strike_value") or "ATM"
    steps = Moneyness.parse(value).steps
    atm = request.atm
    if steps == 0 and request.use_premium_balancing and request.need_call and request.need_put:
        balanced = balanced_straddle(request)
        if balanced is not None:
            return balanced
    call = atm + steps * request.gap
    put = atm - steps * request.gap
    if call <= 0 or put <= 0:
        return f"{value} from {atm} walks past zero"
    return StrikePair(call, put, f"{value}: ATM {atm} at {request.price.amount}")


def balanced_straddle(request: StrikeRequest) -> StrikePair | None:
    """The reference's `StraddleSelector.selectBestStraddle`.

    1. ATM, if its call and put premiums are within the allowed difference;
    2. else the same-strike straddle within two strikes of ATM, balanced and
       paying the most;
    3. else the strangle among those strikes (put below call), balanced and
       paying the most;
    4. else plain ATM.
    """
    atm, gap, limit = request.atm, request.gap, request.straddle_max_diff
    strikes = [atm - gap * 2, atm - gap, atm, atm + gap, atm + gap * 2]

    def last(strike: Decimal, option_type: OptionType) -> Decimal | None:
        listed = request.chain.option(request.underlying, request.expiry, strike, option_type)
        tick = request.chain.quote(listed) if listed is not None else None
        if tick is None or tick.last_price.amount <= 0:
            return None
        return tick.last_price.amount

    def pair(call: Decimal, put: Decimal) -> tuple[Decimal, Decimal] | None:
        c, p = last(call, OptionType.CALL), last(put, OptionType.PUT)
        return (c, p) if c is not None and p is not None else None

    at_money = pair(atm, atm)
    if at_money is not None and abs(at_money[0] - at_money[1]) < limit:
        return StrikePair(atm, atm, f"balanced ATM straddle at {atm}")

    best: tuple[Decimal, Decimal, Decimal] | None = None
    for strike in strikes:
        if strike == atm:
            continue
        premiums = pair(strike, strike)
        if premiums is None or abs(premiums[0] - premiums[1]) >= limit:
            continue
        combined = premiums[0] + premiums[1]
        if best is None or combined > best[2]:
            best = (strike, strike, combined)
    if best is not None:
        return StrikePair(best[0], best[1], f"balanced straddle near the money at {best[0]}")

    for low_index, put in enumerate(strikes):
        for call in strikes[low_index + 1 :]:
            premiums = pair(call, put)
            if premiums is None or abs(premiums[0] - premiums[1]) >= limit:
                continue
            combined = premiums[0] + premiums[1]
            if best is None or combined > best[2]:
                best = (call, put, combined)
    if best is not None:
        return StrikePair(best[0], best[1], f"balanced strangle {best[1]}/{best[0]}")
    if at_money is not None:
        return StrikePair(atm, atm, f"no balanced straddle within {limit}; ATM {atm}")
    return None


@strike_selector(StrikeType.FIXED_PREMIUM)
def fixed_premium(request: StrikeRequest) -> StrikePair | str:
    target = request.config.number("option_premium")
    if target is None or target <= 0:
        return "FixedPremium needs optionPremium"

    def pick(option_type: OptionType) -> Decimal | None:
        best: _Priced | None = None
        for priced in _priced(
            request, option_type, request.out_of_the_money(option_type, request.levels)
        ):
            # Nearest wins; a tie goes to the strike further out, as the
            # reference's search settles it.
            if best is None or abs(priced.premium - target) <= abs(best.premium - target):
                best = priced
        return best.strike if best is not None else None

    return _both(request, pick, f"premium nearest {target}", f"no strike near premium {target}")


@strike_selector(StrikeType.PREMIUM_RANGE)
def premium_range(request: StrikeRequest) -> StrikePair | str:
    lower = request.config.number("option_premium")
    upper = request.config.number("option_premium_upper")
    if lower is None or upper is None:
        return "PremiumRange needs optionPremium and optionPremiumUpper"

    def pick(option_type: OptionType) -> Decimal | None:
        chosen: _Priced | None = None
        for priced in _priced(
            request, option_type, request.out_of_the_money(option_type, request.levels)
        ):
            if priced.premium > lower:
                chosen = priced  # the furthest out still above the floor
        if chosen is None or (upper > 0 and chosen.premium > upper):
            return None
        return chosen.strike

    return _both(
        request, pick, f"premium in {lower}..{upper}", f"no strike priced in {lower}..{upper}"
    )


@strike_selector(StrikeType.PREMIUM_RANGE_OI_RANKED)
def premium_range_oi_ranked(request: StrikeRequest) -> StrikePair | str:
    lower = request.config.number("option_premium")
    upper = request.config.number("option_premium_upper")
    if lower is None or upper is None:
        return "PremiumRange_OIRanked needs optionPremium and optionPremiumUpper"
    rank = request.config.whole("oi_rank") or 1
    if rank < 1 or rank > 5:
        rank = 1
    ignore_itm = request.config.flag("ignore_itm_strikes")
    spot = request.price.amount

    def pick(option_type: OptionType) -> Decimal | None:
        itm = 0 if ignore_itm else OI_RANKED_ITM_STRIKES
        strikes = request.out_of_the_money(option_type, itm + request.levels, start=-itm)
        candidates = []
        for priced in _priced(request, option_type, strikes):
            if not (lower <= priced.tick.last_price.amount <= upper):
                continue
            in_the_money = (
                priced.strike < spot if option_type is OptionType.CALL else priced.strike > spot
            )
            if ignore_itm and in_the_money:
                continue
            candidates.append(priced)
        if not candidates:
            return None
        candidates.sort(key=lambda p: p.tick.open_interest or 0, reverse=True)
        return candidates[min(rank, len(candidates)) - 1].strike

    return _both(
        request,
        pick,
        f"OI rank {rank} priced in {lower}..{upper}",
        f"no strike priced in {lower}..{upper}",
    )


@strike_selector(StrikeType.CANDLE_LOW_NEAR_PREMIUM)
def candle_low_near_premium(request: StrikeRequest) -> StrikePair | str:
    target = request.config.number("option_premium")
    if target is None or target <= 0:
        return "CandleLow_NearPremium needs optionPremium"
    lookback = request.config.whole("lookback_minutes") or 60
    levels = request.config.whole("otm_levels") or 10
    # The reference's tolerance of 100%: a low anywhere in (0, 2x target].
    floor, ceiling = Decimal(0), target * 2

    def pick(option_type: OptionType) -> Decimal | None:
        strikes = [request.atm + request.gap * n for n in range(-levels, levels + 1)]
        best: tuple[Decimal, Decimal] | None = None
        for priced in _priced(request, option_type, [s for s in strikes if s > 0]):
            bars = request.chain.candles(priced.instrument, BarInterval.ONE_MINUTE, lookback)
            if not bars:
                continue
            low = min(bar.low.amount for bar in bars)
            if not (floor <= low <= ceiling):
                continue
            miss = abs(low - target)
            if best is None or miss < best[1]:
                best = (priced.strike, miss)
        return best[0] if best is not None else None

    return _both(
        request,
        pick,
        f"{lookback}-minute low nearest {target}",
        f"no strike with a {lookback}-minute low near {target}",
    )


@strike_selector(StrikeType.FIXED_DELTA)
def fixed_delta(request: StrikeRequest) -> StrikePair | str:
    target = request.config.number("target_delta")
    if target is None or not (0 < target < 1):
        return "FixedDelta needs an absolute targetDelta between 0 and 1, e.g. 0.25"
    if request.now is None or request.expires_at is None:
        return "FixedDelta needs the time to expiry"
    seconds = Decimal(int((request.expires_at - request.now).total_seconds()))
    if seconds <= 0:
        return "the expiry has passed"
    years = seconds / SECONDS_PER_YEAR
    deviation = request.config.number("max_delta_deviation")
    allowed = DEFAULT_MAX_DELTA_DEVIATION if deviation is None else deviation
    spot = request.price.amount

    def pick(option_type: OptionType) -> Decimal | None:
        strikes = [
            request.atm + request.gap * n for n in range(-request.levels, request.levels + 1)
        ]
        best: tuple[Decimal, Decimal] | None = None
        for priced in _priced(request, option_type, [s for s in strikes if s > 0]):
            absolute = absolute_delta_from_price(
                option_type=option_type,
                price=priced.tick.last_price.amount,
                spot=spot,
                strike=priced.strike,
                years=years,
            )
            if absolute is None:
                continue  # unusable strike: skipped, never guessed at
            miss = abs(target - absolute)
            if best is None or miss < best[1]:
                best = (priced.strike, miss)
        if best is None or (allowed > 0 and best[1] > allowed):
            return None
        return best[0]

    return _both(
        request,
        pick,
        f"delta nearest {target}",
        f"no strike within {allowed} of delta {target}",
    )
