"""Loading seed data into a real database."""

from __future__ import annotations

from decimal import Decimal

import pytest

from garuda.persistence import UnitOfWork, load_seed, read_seed
from garuda.persistence.seed import SEED_ORDER

pytestmark = pytest.mark.integration


class TestWhatIsSeeded:
    def test_every_seed_file_has_a_table_to_load_into(self):
        for name, _repository in SEED_ORDER:
            assert read_seed(name) is not None

    def test_the_stock_universe_is_not_seeded(self):
        """It is detected from the instrument master every morning; a stale
        copy would be worse than none."""
        symbols = read_seed("symbols")
        assert all(row["is_index"] for row in symbols)
        assert {row["symbol"] for row in symbols} >= {"NIFTY", "BANKNIFTY", "CRUDEOIL"}

    def test_only_the_supported_brokers_are_seeded(self):
        assert {row["broker_name"] for row in read_seed("brokers")} == {
            "zerodha",
            "fyers",
            "kotak",
            "dhan",
        }

    def test_only_the_modelled_venues_are_seeded(self):
        assert {row["exchange_code"] for row in read_seed("exchanges")} == {
            "NSE",
            "BSE",
            "MCX",
        }

    def test_commodity_multipliers_survive_the_extraction(self):
        """The number that makes an MCX P&L right."""
        symbols = {row["symbol"]: row for row in read_seed("symbols")}
        assert symbols["CRUDEOIL"]["contract_multiplier"] == 100
        assert symbols["NATURALGAS"]["contract_multiplier"] == 1250

    def test_the_index_spot_mapping_survives(self):
        symbols = {row["symbol"]: row for row in read_seed("symbols")}
        assert symbols["NIFTY"]["index_symbol"] == "NIFTY 50"
        assert symbols["CRUDEOIL"]["index_symbol"] is None


class TestLoading:
    async def test_a_fresh_database_gets_every_file(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            result = await load_seed(uow.repositories)
        assert result.total > 100
        assert result.skipped == ()

    async def test_the_rows_are_actually_there(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await load_seed(uow.repositories)

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.exchanges.count() == 3
            assert await uow.repositories.symbols.count() == 8
            assert await uow.repositories.brokers.count() == 4
            assert await uow.repositories.holidays.count() == 82

    async def test_a_seeded_symbol_reads_back_intact(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await load_seed(uow.repositories)

        async with UnitOfWork(session_factory) as uow:
            crude = await uow.repositories.symbols.require("CRUDEOIL")
        assert crude.contract_multiplier == 100
        assert crude.freeze_limit_qty == 1000
        assert crude.strike_gap == 50

    async def test_loading_twice_changes_nothing(self, session_factory):
        """Safe to run on every start."""
        async with UnitOfWork(session_factory) as uow:
            await load_seed(uow.repositories)
        async with UnitOfWork(session_factory) as uow:
            before = await uow.repositories.symbols.count()
            await load_seed(uow.repositories)
        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.symbols.count() == before

    async def test_an_operator_edit_survives_a_reload_of_other_rows(self, session_factory):
        """Seeding upserts by primary key, so an edited row is overwritten —
        which is why a release note has to say when a seed value changes."""
        async with UnitOfWork(session_factory) as uow:
            await load_seed(uow.repositories)
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.symbols.update("NIFTY", strike_gap=Decimal(100))

        async with UnitOfWork(session_factory) as uow:
            await load_seed(uow.repositories, only=["exchanges"])

        async with UnitOfWork(session_factory) as uow:
            nifty = await uow.repositories.symbols.require("NIFTY")
        assert nifty.strike_gap == 100, "reloading another file left this row alone"

    async def test_loading_one_file_only(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            result = await load_seed(uow.repositories, only=["exchanges"])
        assert set(result.loaded) == {"exchanges"}

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.symbols.count() == 0

    async def test_a_failure_leaves_nothing_half_seeded(self, session_factory):
        async def seed_then_fail() -> None:
            async with UnitOfWork(session_factory) as uow:
                await load_seed(uow.repositories)
                raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await seed_then_fail()

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.exchanges.count() == 0


class TestOrder:
    async def test_venues_load_before_the_symbols_that_reference_them(self, session_factory):
        """A foreign key is a fact about order, not a suggestion."""
        names = [name for name, _ in SEED_ORDER]
        assert names.index("exchanges") < names.index("symbols")
        assert names.index("brokerage_plans") < names.index("brokerage_plan_rates")
