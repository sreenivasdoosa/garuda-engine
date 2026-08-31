"""What a strategy sees when it runs against the real hub and registry."""

from __future__ import annotations

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.composition.strategy_context import (
    LiveContext,
    MarketView,
    day_conditions_for,
)
from garuda.core.bus import InProcessEventBus
from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money
from garuda.domain.calendar import Session, TradingCalendar
from garuda.domain.client import TradingClientId
from garuda.domain.enums import (
    ExerciseStyle,
    ExpiryKind,
    InstrumentKind,
    OptionType,
    Segment,
    SettlementType,
)
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.symbol import SymbolInfo
from garuda.engine.config import ResolvedConfig
from garuda.engine.daycondition import DayCondition
from garuda.marketdata.history import CandleCache, HistorySource, Want
from garuda.marketdata.hub import TickHub
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.feed import TicksReceived

IST = ZoneInfo("Asia/Kolkata")
NOW = datetime(2026, 8, 31, 10, 30, tzinfo=UTC)
TODAY = date(2026, 8, 31)
EXPIRY = date(2026, 9, 3)
NIFTY = InstrumentId("NSE:NIFTY")
CLIENT = TradingClientId("appa")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def option(strike: int, side: OptionType, nse: Exchange) -> Instrument:
    letters = "CE" if side is OptionType.CALL else "PE"
    return Instrument(
        id=InstrumentId(f"NFO:N{strike}{letters}"),
        exchange=nse,
        segment=Segment.FNO,
        kind=InstrumentKind.OPTION,
        trading_symbol=f"N{strike}{letters}",
        lot_size=75,
        tick_size=Decimal("0.05"),
        underlying=NIFTY,
        expiry=EXPIRY,
        strike=Decimal(strike),
        option_type=side,
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )


@pytest.fixture
def registry(nse: Exchange) -> InstrumentRegistry:
    return InstrumentRegistry.build(
        [
            option(strike, side, nse)
            for strike in (24900, 25000, 25100)
            for side in (OptionType.CALL, OptionType.PUT)
        ]
    )


@pytest.fixture
def hub() -> TickHub:
    return TickHub(InProcessEventBus(), ReplayClock(NOW))


@pytest.fixture
def context(hub: TickHub, registry: InstrumentRegistry, alerts_book: object) -> LiveContext:
    market = MarketView(
        hub=hub,
        registry=lambda: registry,
        symbols={"NIFTY": SymbolInfo(symbol="NIFTY", exchange_code="NSE", strike_gap=Decimal(50))},
        timezone=IST,
    )
    return LiveContext(
        market=market,
        book=alerts_book,  # type: ignore[arg-type]
        now=NOW,
        trading_day=TODAY,
        strategy="straddle",
        trading_client=CLIENT,
        tranche=0,
        config=ResolvedConfig(strategy="straddle"),
        underlying=NIFTY,
    )


@pytest.fixture
def alerts_book() -> object:
    class Book:
        def trades_for(self, strategy: str) -> list[object]:
            return []

    return Book()


async def publish(hub: TickHub, instrument: InstrumentId, price: str) -> None:
    """Put a price on the hub the way the feed does."""
    tick = Tick(instrument=instrument, last_price=rupees(price), timestamp=NOW)
    await hub.consume([TicksReceived((tick,))])
    # The hub coalesces: a tick is staged on arrival and becomes the latest
    # when it is dispatched.
    await hub.dispatch_once()


# -- prices -----------------------------------------------------------------


async def test_a_price_comes_from_the_hub(context: LiveContext, hub: TickHub) -> None:
    await publish(hub, NIFTY, "25010")

    quote = context.quote(NIFTY)
    assert quote is not None
    assert quote.last_price == rupees("25010")


def test_an_instrument_nobody_is_subscribed_to_has_no_price(
    context: LiveContext,
) -> None:
    assert context.quote(NIFTY) is None


async def test_the_spot_is_the_underlying_s_own_last_trade(
    context: LiveContext, hub: TickHub
) -> None:
    await publish(hub, NIFTY, "25010")

    assert context.spot(NIFTY) == rupees("25010")


async def test_one_pass_sees_one_price(context: LiveContext, hub: TickHub) -> None:
    """A tree whose first rule saw 100 and whose fifth saw 101 can contradict
    itself."""
    await publish(hub, NIFTY, "25010")
    first = context.quote(NIFTY)

    await publish(hub, NIFTY, "25099")

    assert context.quote(NIFTY) == first


# -- the master -------------------------------------------------------------


def test_the_strike_gap_comes_from_the_curated_symbol(context: LiveContext) -> None:
    assert context.strike_gap(NIFTY) == Decimal(50)


def test_an_uncurated_underlying_has_no_strike_gap(context: LiveContext) -> None:
    """Loudly: without a gap nothing can pick a strike, and a default would
    pick the wrong one."""
    assert context.strike_gap(InstrumentId("NSE:NOBODY")) is None


def test_the_expiry_comes_from_the_master(context: LiveContext) -> None:
    assert context.expiry(NIFTY, ExpiryKind.WEEKLY) == EXPIRY


def test_a_listed_option_resolves(context: LiveContext) -> None:
    found = context.option(NIFTY, EXPIRY, Decimal(25000), OptionType.CALL)

    assert found == InstrumentId("NFO:N25000CE")


def test_a_strike_nobody_listed_resolves_to_nothing(context: LiveContext) -> None:
    assert context.option(NIFTY, EXPIRY, Decimal(99000), OptionType.CALL) is None


def test_no_future_is_listed_here(context: LiveContext) -> None:
    assert context.future(NIFTY, EXPIRY) is None


# -- what is not built yet --------------------------------------------------


def test_no_candle_cache_means_no_candles(context: LiveContext) -> None:
    """Saying so is the point: a rule needing them reads UNAVAILABLE rather
    than looking like a condition that did not hold."""
    assert context.candles(NIFTY, BarInterval.ONE_MINUTE, 20) == ()


def test_candles_come_from_the_cache(
    hub: TickHub, registry: InstrumentRegistry, alerts_book: object
) -> None:
    """And asking for a series nobody has fetched registers the demand, so the
    next refresh brings it."""
    cache = CandleCache(source=_never_asked(), clock=ReplayClock(NOW))
    market = MarketView(
        hub=hub,
        registry=lambda: registry,
        symbols={},
        timezone=IST,
        candles=cache,
    )
    context = LiveContext(
        market=market,
        book=alerts_book,  # type: ignore[arg-type]
        now=NOW,
        trading_day=TODAY,
        strategy="straddle",
        trading_client=CLIENT,
        tranche=0,
        config=ResolvedConfig(strategy="straddle"),
        underlying=NIFTY,
    )

    assert context.candles(NIFTY, BarInterval.ONE_MINUTE, 20) == ()
    assert Want(NIFTY, BarInterval.ONE_MINUTE) in cache.wanted


def _never_asked() -> HistorySource:
    class Nothing:
        async def fetch(
            self,
            instrument: InstrumentId,
            interval: BarInterval,
            start: datetime,
            end: datetime,
        ) -> list[Bar]:
            raise AssertionError("a rule must not wait on a broker")

    return Nothing()


def test_an_indicator_with_no_history_answers_nothing(context: LiveContext) -> None:
    """A morning, not a fault."""
    assert context.indicator("RSI", NIFTY, BarInterval.FIVE_MINUTES, period=14) is None


async def test_an_indicator_is_computed_from_the_candles(
    hub: TickHub, registry: InstrumentRegistry, alerts_book: object
) -> None:
    cache = CandleCache(source=_answering(_a_rising_series()), clock=ReplayClock(NOW))
    cache.wants(NIFTY, BarInterval.ONE_DAY)
    await cache.refresh_due(session_start=NOW - timedelta(hours=1))
    context = _context_over(cache, hub, registry, alerts_book)

    # Nothing fell across the whole window, so the index is at its ceiling.
    assert context.indicator("RSI", NIFTY, BarInterval.ONE_DAY, period=14) == Decimal(100)


def _a_rising_series() -> list[Bar]:
    return [
        Bar(
            instrument=NIFTY,
            interval=BarInterval.ONE_DAY,
            start=NOW - timedelta(days=60 - n),
            open=rupees(str(100 + n)),
            high=rupees(str(100 + n)),
            low=rupees(str(100 + n)),
            close=rupees(str(100 + n)),
        )
        for n in range(60)
    ]


def _answering(bars: list[Bar]) -> HistorySource:
    class Source:
        async def fetch(
            self,
            instrument: InstrumentId,
            interval: BarInterval,
            start: datetime,
            end: datetime,
        ) -> list[Bar]:
            return [bar for bar in bars if start <= bar.start < end]

    return Source()


def test_one_evaluation_computes_an_indicator_once(
    hub: TickHub, registry: InstrumentRegistry, alerts_book: object
) -> None:
    """A ten-rule tree must not be ten computations of the same average, and
    all ten must see one number."""
    cache = CandleCache(source=_never_asked(), clock=ReplayClock(NOW))
    context = _context_over(cache, hub, registry, alerts_book)

    first = context.indicator("RSI", NIFTY, BarInterval.ONE_DAY, period=14)
    cache.forget_today()
    second = context.indicator("RSI", NIFTY, BarInterval.ONE_DAY, period=14)

    # The cache was emptied between the two, so a recomputation would have
    # answered differently. It was not recomputed.
    assert first == second


def test_an_indicator_nobody_knows_is_a_configuration_error(
    hub: TickHub, registry: InstrumentRegistry, alerts_book: object
) -> None:
    cache = CandleCache(source=_never_asked(), clock=ReplayClock(NOW))
    context = _context_over(cache, hub, registry, alerts_book)

    with pytest.raises(DomainError, match="not a known indicator"):
        context.indicator("VIBES", NIFTY, BarInterval.ONE_DAY)


def _context_over(
    cache: CandleCache, hub: TickHub, registry: InstrumentRegistry, book: object
) -> LiveContext:
    return LiveContext(
        market=MarketView(
            hub=hub, registry=lambda: registry, symbols={}, timezone=IST, candles=cache
        ),
        book=book,  # type: ignore[arg-type]
        now=NOW,
        trading_day=TODAY,
        strategy="straddle",
        trading_client=CLIENT,
        tranche=0,
        config=ResolvedConfig(strategy="straddle"),
        underlying=NIFTY,
    )


# -- day conditions ---------------------------------------------------------


def nse_calendar_of() -> TradingCalendar:
    return TradingCalendar(
        name="NSE",
        timezone=IST,
        weekly={d: (Session(time(9, 15), time(15, 30)),) for d in range(5)},
    )


def test_expiry_day_is_recognised(registry: InstrumentRegistry) -> None:
    calendar = nse_calendar_of()

    conditions = day_conditions_for(NIFTY, EXPIRY, registry, calendar)

    assert DayCondition.EXPIRY in conditions


def test_the_day_before_expiry_is_recognised(registry: InstrumentRegistry) -> None:
    calendar = nse_calendar_of()

    conditions = day_conditions_for(NIFTY, date(2026, 9, 2), registry, calendar)

    assert DayCondition.ONE_DAY_TO_EXPIRY in conditions
