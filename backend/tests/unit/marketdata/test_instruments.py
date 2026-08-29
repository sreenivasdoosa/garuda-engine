"""Loading, caching and indexing the instrument master."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from garuda.core.clock import ReplayClock
from garuda.core.runner import EngineRunner, InMemoryPhaseRecorder, TaskRegistry
from garuda.domain.enums import OptionType
from garuda.domain.errors import DomainError
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import InstrumentId
from garuda.domain.phases import DayPhase
from garuda.domain.symbol import SymbolInfo
from garuda.marketdata.cache import InstrumentCache
from garuda.marketdata.loader import InstrumentLoader, InstrumentRegistryHolder
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.tasks import register_instrument_load

IST = ZoneInfo("Asia/Kolkata")

HEADER = (
    "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,"
    "strike,tick_size,lot_size,instrument_type,segment,exchange"
)


type Venues = dict[str, Exchange]
type Symbols = dict[str, SymbolInfo]


def master(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


def option(token: int, symbol: str, expiry: str, strike: int, kind: str) -> str:
    return f"{token},1,{symbol},NIFTY,0,{expiry},{strike},0.05,75,{kind},NFO-OPT,NFO"


FULL_MASTER = master(
    "738561,2885,RELIANCE,RELIANCE,0,,0,0.05,1,EQ,NSE,NSE",
    "256265,1001,NIFTY 50,NIFTY 50,0,,0,0.05,1,EQ,INDICES,NSE",
    "111,1,NIFTY26AUGFUT,NIFTY,0,2026-08-27,0,0.05,75,FUT,NFO-FUT,NFO",
    "112,1,NIFTY26SEPFUT,NIFTY,0,2026-09-24,0,0.05,75,FUT,NFO-FUT,NFO",
    option(201, "NIFTY26AUG24900CE", "2026-08-27", 24900, "CE"),
    option(202, "NIFTY26AUG24900PE", "2026-08-27", 24900, "PE"),
    option(203, "NIFTY26AUG25000CE", "2026-08-27", 25000, "CE"),
    option(204, "NIFTY26AUG25000PE", "2026-08-27", 25000, "PE"),
    option(205, "NIFTY26SEP25000CE", "2026-09-24", 25000, "CE"),
)

AT_NINE = datetime(2026, 8, 27, 9, 0, tzinfo=IST)
#: A Monday, after both venues' day-init lead and before either starts trading.
DAY_INIT_TIME = datetime(2026, 8, 31, 7, 0, tzinfo=IST)
NIFTY = InstrumentId("NSE:NIFTY")
AUGUST = date(2026, 8, 27)
SEPTEMBER = date(2026, 9, 24)


@pytest.fixture
def venues(nse: Exchange, mcx: Exchange) -> Venues:
    return {"NSE": nse, "MCX": mcx}


@pytest.fixture
def symbols() -> Symbols:
    return {
        "NIFTY": SymbolInfo(
            symbol="NIFTY",
            exchange_code="NSE",
            is_index=True,
            index_symbol="NIFTY 50",
            strike_gap=Decimal(50),
            freeze_limit_quantity=1755,
        )
    }


@pytest.fixture
def registry(venues: Venues, symbols: Symbols) -> InstrumentRegistry:
    from garuda.brokers.zerodha.instruments import parse_instruments

    catalogue = parse_instruments(FULL_MASTER, venues, symbols)
    return InstrumentRegistry.build(catalogue.instruments, catalogue.tokens)


class TestRegistryLookups:
    def test_an_instrument_is_found_by_id(self, registry: InstrumentRegistry) -> None:
        assert registry.require(InstrumentId("NSE:RELIANCE")).trading_symbol == "RELIANCE"

    def test_an_unknown_instrument_says_so_clearly(self, registry: InstrumentRegistry) -> None:
        with pytest.raises(DomainError, match="not in today's instrument master"):
            registry.require(InstrumentId("NSE:NOTLISTED"))

    def test_an_instrument_is_found_by_what_the_broker_calls_it(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        found = registry.by_trading_symbol("NSE", "NIFTY 50")
        assert found is not None
        assert found.id == InstrumentId("NSE:NIFTY_50")

    def test_the_broker_token_is_available_without_being_on_the_instrument(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        assert registry.token_for(InstrumentId("NSE:RELIANCE")) == 738561


class TestExpiries:
    def test_expiries_come_back_soonest_first(self, registry: InstrumentRegistry) -> None:
        assert list(registry.expiries_for(NIFTY)) == [AUGUST, SEPTEMBER]

    def test_the_nearest_expiry_is_the_weekly(self, registry: InstrumentRegistry) -> None:
        assert registry.nearest_expiry(NIFTY, date(2026, 8, 20)) == AUGUST

    def test_on_expiry_day_that_expiry_is_still_the_nearest(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        """It trades until the close, so it is not yet the next one."""
        assert registry.nearest_expiry(NIFTY, AUGUST) == AUGUST

    def test_after_the_last_expiry_there_is_none(self, registry: InstrumentRegistry) -> None:
        assert registry.nearest_expiry(NIFTY, date(2027, 1, 1)) is None


class TestOptionChain:
    def test_a_chain_holds_only_its_own_expiry(self, registry: InstrumentRegistry) -> None:
        chain = registry.option_chain(NIFTY, AUGUST)
        assert len(chain) == 4
        assert all(instrument.expiry == AUGUST for instrument in chain)

    def test_one_option_is_found_by_strike_and_type(self, registry: InstrumentRegistry) -> None:
        found = registry.option_at(NIFTY, AUGUST, Decimal(25000), OptionType.CALL)
        assert found is not None
        assert found.trading_symbol == "NIFTY26AUG25000CE"

    def test_an_unlisted_strike_is_none_rather_than_invented(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        """The far wings often are not listed, whatever the strike gap implies."""
        assert registry.option_at(NIFTY, AUGUST, Decimal(99000), OptionType.CALL) is None

    def test_the_listed_strikes_are_reported(self, registry: InstrumentRegistry) -> None:
        assert list(registry.strikes_for(NIFTY, AUGUST)) == [
            Decimal(24900),
            Decimal(25000),
        ]

    def test_an_expiry_with_no_options_is_empty_not_missing(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        assert registry.option_chain(NIFTY, date(2030, 1, 1)) == []


class TestFutures:
    def test_futures_come_back_nearest_first(self, registry: InstrumentRegistry) -> None:
        symbols = [f.trading_symbol for f in registry.futures_for(NIFTY)]
        assert symbols == ["NIFTY26AUGFUT", "NIFTY26SEPFUT"]

    def test_the_near_month_is_the_first_unexpired(self, registry: InstrumentRegistry) -> None:
        near = registry.near_month_future(NIFTY, date(2026, 8, 20))
        assert near is not None
        assert near.trading_symbol == "NIFTY26AUGFUT"

    def test_after_the_near_month_expires_the_next_takes_over(
        self,
        registry: InstrumentRegistry,
    ) -> None:
        near = registry.near_month_future(NIFTY, date(2026, 8, 28))
        assert near is not None
        assert near.trading_symbol == "NIFTY26SEPFUT"


class TestCache:
    def test_a_master_survives_a_round_trip(self, tmp_path: Path) -> None:
        cache = InstrumentCache(tmp_path, ReplayClock(AT_NINE))
        cache.write("zerodha", FULL_MASTER)
        cached = cache.read("zerodha")
        assert cached is not None
        assert cached.text == FULL_MASTER

    def test_nothing_cached_reads_as_none(self, tmp_path: Path) -> None:
        assert InstrumentCache(tmp_path, ReplayClock(AT_NINE)).read("zerodha") is None

    def test_the_download_time_is_the_engines_clock_not_the_file_time(self, tmp_path: Path) -> None:
        """A replay compares simulated instants; a file mtime is real time."""
        cache = InstrumentCache(tmp_path, ReplayClock(AT_NINE))
        cached = cache.write("zerodha", FULL_MASTER)
        assert cached.downloaded_at == AT_NINE
        reread = cache.read("zerodha")
        assert reread is not None
        assert reread.downloaded_at == AT_NINE

    def test_a_master_with_no_recorded_time_reads_as_absent(self, tmp_path: Path) -> None:
        """Without a time there is no way to tell whether it is today's, and
        re-downloading costs one request while trusting it costs a day."""
        cache = InstrumentCache(tmp_path, ReplayClock(AT_NINE))
        cache.write("zerodha", FULL_MASTER)
        cache.metadata_path_for("zerodha").unlink()
        assert cache.read("zerodha") is None

    def test_an_empty_master_is_refused(self, tmp_path: Path) -> None:
        """An empty master means the download failed, not that nothing is listed."""
        with pytest.raises(DomainError, match="refusing to cache an empty"):
            InstrumentCache(tmp_path, ReplayClock(AT_NINE)).write("zerodha", "   ")

    def test_a_rewrite_leaves_no_partial_file(self, tmp_path: Path) -> None:
        cache = InstrumentCache(tmp_path, ReplayClock(AT_NINE))
        cache.write("zerodha", FULL_MASTER)
        cache.write("zerodha", master("738561,2885,RELIANCE,RELIANCE,0,,0,0.05,1,EQ,NSE,NSE"))
        assert list(tmp_path.glob("*.partial")) == []

    def test_a_broker_name_that_would_escape_the_directory_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(DomainError, match="not usable as a file name"):
            InstrumentCache(tmp_path, ReplayClock(AT_NINE)).path_for("../etc/passwd")


class TestLoader:
    def loader(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
        text: str = FULL_MASTER,
        calls: list[int] | None = None,
        clock: ReplayClock | None = None,
    ) -> InstrumentLoader:
        async def download() -> str:
            if calls is not None:
                calls.append(1)
            return text

        return InstrumentLoader(
            broker="zerodha",
            cache=InstrumentCache(tmp_path, clock or ReplayClock(AT_NINE)),
            download=download,
            exchanges=venues,
            symbols=symbols,
            timezone=IST,
        )

    async def test_an_empty_cache_downloads(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
    ) -> None:
        calls: list[int] = []
        result = await self.loader(tmp_path, venues, symbols, calls=calls).load(
            datetime(2026, 8, 27, 9, 0, tzinfo=IST)
        )
        assert result.downloaded
        assert calls == [1]
        assert result.count == 9

    async def test_a_fresh_cache_is_not_downloaded_again(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
    ) -> None:
        """A restart at eleven must not re-fetch a hundred thousand rows."""
        calls: list[int] = []
        loader = self.loader(tmp_path, venues, symbols, calls=calls)
        now = datetime(2026, 8, 27, 9, 0, tzinfo=IST)
        await loader.load(now)
        second = await loader.load(now + timedelta(hours=2))
        assert calls == [1]
        assert not second.downloaded
        assert second.count == 9

    async def test_a_stale_cache_is_replaced(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
    ) -> None:
        """Yesterday's master is not today's: the weekly strikes differ."""
        calls: list[int] = []
        clock = ReplayClock(AT_NINE)
        loader = self.loader(tmp_path, venues, symbols, calls=calls, clock=clock)
        await loader.load(clock.now())

        await clock.advance_to(datetime(2026, 8, 28, 9, 0, tzinfo=IST))
        await loader.load(clock.now())
        assert calls == [1, 1]

    async def test_a_forced_load_downloads_whatever_the_cache_says(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
    ) -> None:
        calls: list[int] = []
        loader = self.loader(tmp_path, venues, symbols, calls=calls)
        now = datetime(2026, 8, 27, 9, 0, tzinfo=IST)
        await loader.load(now)
        await loader.load(now, force=True)
        assert calls == [1, 1]

    async def test_skipped_rows_are_reported_through(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
    ) -> None:
        broken = master(
            "738561,2885,RELIANCE,RELIANCE,0,,0,0.05,1,EQ,NSE,NSE",
            "99999999,4,NIFTY26MAY26JULFUT,NIFTY,0,2026-07-30,0,0.05,75,FUT,NFO-FUT,NFO",
        )
        result = await self.loader(tmp_path, venues, symbols, text=broken).load(
            datetime(2026, 8, 27, 9, 0, tzinfo=IST)
        )
        assert result.count == 1
        assert result.skipped[0][0] == "NIFTY26MAY26JULFUT"


class TestRegistryHolder:
    def test_it_starts_empty_rather_than_absent(self) -> None:
        """A lookup before day-init should fail as a missing instrument."""
        holder = InstrumentRegistryHolder()
        assert holder.current.is_empty
        assert holder.current.get(NIFTY) is None

    def test_publishing_swaps_the_whole_registry(self, registry: InstrumentRegistry) -> None:
        holder = InstrumentRegistryHolder()
        holder.publish(registry)
        assert len(holder.current) == 9

    def test_an_empty_registry_is_refused(self, registry: InstrumentRegistry) -> None:
        """An empty master means the download failed."""
        holder = InstrumentRegistryHolder()
        holder.publish(registry)
        with pytest.raises(ValueError, match="refusing to publish an empty"):
            holder.publish(InstrumentRegistry())
        assert len(holder.current) == 9, "the previous registry is untouched"


class TestDayInitWiring:
    """The load as the runner actually drives it."""

    def parts(
        self, tmp_path: Path, venues: Venues, symbols: Symbols, calls: list[int]
    ) -> tuple[TaskRegistry, InstrumentRegistryHolder, ReplayClock]:
        clock = ReplayClock(DAY_INIT_TIME)

        async def download() -> str:
            calls.append(1)
            return FULL_MASTER

        loader = InstrumentLoader(
            broker="zerodha",
            cache=InstrumentCache(tmp_path, clock),
            download=download,
            exchanges=venues,
            symbols=symbols,
            timezone=IST,
        )
        holder = InstrumentRegistryHolder()
        registry = TaskRegistry()
        register_instrument_load(registry, loader, holder, broker="zerodha")
        return registry, holder, clock

    async def test_day_init_leaves_the_engine_with_todays_instruments(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
        nse: Exchange,
    ) -> None:
        calls: list[int] = []
        registry, holder, clock = self.parts(tmp_path, venues, symbols, calls)
        assert holder.current.is_empty

        runner = EngineRunner(
            exchanges=[nse], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )
        result = await runner.run_once()

        assert DayPhase.DAY_INIT in {instant.phase for instant in result.ran}
        assert len(holder.current) == 9
        assert calls == [1]

    async def test_a_download_failure_leaves_day_init_to_be_retried(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
        nse: Exchange,
    ) -> None:
        """Recording it complete would turn a minute's outage into a lost day."""
        clock = ReplayClock(DAY_INIT_TIME)
        attempts: list[int] = []

        async def download() -> str:
            attempts.append(1)
            if len(attempts) == 1:
                raise ConnectionError("the broker is unreachable")
            return FULL_MASTER

        loader = InstrumentLoader(
            broker="zerodha",
            cache=InstrumentCache(tmp_path, clock),
            download=download,
            exchanges=venues,
            symbols=symbols,
            timezone=IST,
        )
        holder = InstrumentRegistryHolder()
        registry = TaskRegistry()
        register_instrument_load(registry, loader, holder, broker="zerodha")
        runner = EngineRunner(
            exchanges=[nse], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )

        first = await runner.run_once()
        assert [instant.phase for instant, _ in first.failed] == [DayPhase.DAY_INIT]
        assert holder.current.is_empty

        second = await runner.run_once()
        assert DayPhase.DAY_INIT in {instant.phase for instant in second.ran}
        assert len(holder.current) == 9

    async def test_a_second_venue_reuses_the_days_master(
        self,
        tmp_path: Path,
        venues: Venues,
        symbols: Symbols,
        nse: Exchange,
        mcx: Exchange,
    ) -> None:
        """An equity holiday on which commodities trade still gets instruments,
        and a normal day does not download the master twice."""
        calls: list[int] = []
        registry, _holder, clock = self.parts(tmp_path, venues, symbols, calls)
        runner = EngineRunner(
            exchanges=[nse, mcx], clock=clock, registry=registry, recorder=InMemoryPhaseRecorder()
        )

        result = await runner.run_once()

        ran = {(instant.exchange, instant.phase) for instant in result.ran}
        assert (nse.code, DayPhase.DAY_INIT) in ran
        assert (mcx.code, DayPhase.DAY_INIT) in ran
        assert calls == [1]


class TestTokenLookup:
    def test_a_token_resolves_back_to_its_instrument(self, registry: InstrumentRegistry) -> None:
        """The direction a tick arrives in: the wire carries a token, not a name."""
        token = registry.token_for(InstrumentId("NSE:RELIANCE"))
        assert token == 738561
        found = registry.by_token(token)
        assert found is not None
        assert found.id == InstrumentId("NSE:RELIANCE")

    def test_an_unknown_token_is_none(self, registry: InstrumentRegistry) -> None:
        assert registry.by_token(999999) is None
