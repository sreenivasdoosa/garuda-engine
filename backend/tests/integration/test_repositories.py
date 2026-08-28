"""The repository layer, against a real PostgreSQL.

The generic base is exercised through one table; the claims are about
behaviour every table inherits.
"""

from __future__ import annotations

import datetime as dt

import pytest

from garuda.persistence import (
    Page,
    RowNotFoundError,
    UnitOfWork,
    UnitOfWorkError,
    UnknownColumnError,
    models,
)

pytestmark = pytest.mark.integration

NOW = dt.datetime(2026, 8, 29, 9, 0, tzinfo=dt.UTC)


def a_client(
    name: str, broker: str = "ZERODHA", client_id: str = "AB1234"
) -> models.TradingClientRow:
    return models.TradingClientRow(
        id=name,
        display_name=name.replace("-", " ").title(),
        broker=broker,
        client_id=client_id,
        enabled=True,
        created_at=NOW,
        updated_at=NOW,
    )


class TestReading:
    async def test_a_row_comes_back_by_primary_key(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("appa-zerodha"))

        async with UnitOfWork(session_factory) as uow:
            row = await uow.repositories.trading_clients.get("appa-zerodha")
        assert row is not None
        assert row.broker == "ZERODHA"

    async def test_a_missing_row_is_none_not_an_error(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.get("nobody") is None

    async def test_require_raises_when_absence_is_a_bug(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(RowNotFoundError, match="has no row"):
                await uow.repositories.trading_clients.require("nobody")

    async def test_filters_are_equality_by_default(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("a", "ZERODHA", "A1"))
            uow.repositories.trading_clients.add(a_client("b", "FYERS", "B1"))

        async with UnitOfWork(session_factory) as uow:
            rows = await uow.repositories.trading_clients.find(broker="FYERS")
        assert [row.id for row in rows] == ["b"]

    async def test_a_list_filter_becomes_an_in_clause(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("a", "ZERODHA", "A1"))
            uow.repositories.trading_clients.add(a_client("b", "FYERS", "B1"))
            uow.repositories.trading_clients.add(a_client("c", "DHAN", "C1"))

        async with UnitOfWork(session_factory) as uow:
            rows = await uow.repositories.trading_clients.find(broker=["FYERS", "DHAN"])
        assert {row.id for row in rows} == {"b", "c"}

    async def test_find_one_refuses_an_ambiguous_match(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("a", "ZERODHA", "A1"))
            uow.repositories.trading_clients.add(a_client("b", "ZERODHA", "B1"))

        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(Exception, match="matched more than one row"):
                await uow.repositories.trading_clients.find_one(broker="ZERODHA")

    async def test_an_unknown_column_is_refused_not_ignored(self, session_factory):
        """A silently dropped filter returns every row."""
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(UnknownColumnError, match="has no column"):
                await uow.repositories.trading_clients.find(nonexistent="x")

    async def test_counting_uses_the_same_filters(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            for index in range(5):
                uow.repositories.trading_clients.add(
                    a_client(f"c{index}", "ZERODHA" if index < 3 else "FYERS", f"X{index}")
                )

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.count() == 5
            assert await uow.repositories.trading_clients.count(broker="ZERODHA") == 3
            assert await uow.repositories.trading_clients.exists(broker="DHAN") is False


class TestPaging:
    async def test_a_page_reports_the_total_behind_it(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            for index in range(10):
                uow.repositories.trading_clients.add(
                    a_client(f"c{index:02d}", client_id=f"X{index}")
                )

        async with UnitOfWork(session_factory) as uow:
            page = await uow.repositories.trading_clients.page(limit=3, order_by="id")
        assert isinstance(page, Page)
        assert len(page.rows) == 3
        assert page.total == 10
        assert page.has_more

    async def test_the_total_answers_the_same_question_as_the_rows(self, session_factory):
        """Otherwise a filtered page reports an unfiltered total."""
        async with UnitOfWork(session_factory) as uow:
            for index in range(6):
                uow.repositories.trading_clients.add(
                    a_client(f"c{index}", "ZERODHA" if index < 2 else "FYERS", f"X{index}")
                )

        async with UnitOfWork(session_factory) as uow:
            page = await uow.repositories.trading_clients.page(limit=10, broker="ZERODHA")
        assert page.total == 2
        assert not page.has_more

    async def test_the_last_page_reports_no_more(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            for index in range(4):
                uow.repositories.trading_clients.add(a_client(f"c{index}", client_id=f"X{index}"))

        async with UnitOfWork(session_factory) as uow:
            page = await uow.repositories.trading_clients.page(limit=2, offset=2, order_by="id")
        assert not page.has_more


class TestUpsert:
    async def test_it_inserts_when_the_row_is_new(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.app_config.upsert({"key": "login.start.time", "value": "07:30"})

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.app_config.value_of("login.start.time") == "07:30"

    async def test_it_updates_when_the_row_is_already_there(self, session_factory):
        """What the reference engine calls insertOrUpdate, used wherever a
        broker restates something the engine already recorded."""
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.app_config.set("login.start.time", "07:30")
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.app_config.set("login.start.time", "08:15")

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.app_config.value_of("login.start.time") == "08:15"
            assert await uow.repositories.app_config.count() == 1

    async def test_upserting_nothing_is_not_an_error(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.app_config.upsert_all([])

    async def test_an_unknown_column_is_refused(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(UnknownColumnError):
                await uow.repositories.app_config.upsert({"key": "k", "nonexistent": "v"})

    async def test_rows_setting_different_columns_are_refused(self, session_factory):
        """Filling the gaps with NULL would wipe values the row already has."""
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(Exception, match="same columns"):
                await uow.repositories.app_config.upsert_all(
                    [{"key": "a", "value": "1"}, {"key": "b"}]
                )


class TestWriting:
    async def test_update_changes_one_row_by_key(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("appa"))

        async with UnitOfWork(session_factory) as uow:
            changed = await uow.repositories.trading_clients.update("appa", enabled=False)
        assert changed == 1

        async with UnitOfWork(session_factory) as uow:
            row = await uow.repositories.trading_clients.require("appa")
        assert row.enabled is False

    async def test_deleting_by_key(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("appa"))

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.delete("appa") == 1

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.get("appa") is None

    async def test_deleting_without_a_filter_is_refused(self, session_factory):
        """Refusing to delete every row by accident."""
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(Exception, match="refusing to delete every row"):
                await uow.repositories.trading_clients.delete_where()

    async def test_the_wrong_number_of_key_values_is_refused(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            with pytest.raises(Exception, match="primary key"):
                await uow.repositories.trading_clients.delete("a", "b")


class TestTransactionality:
    async def test_writes_roll_back_with_the_unit_of_work(self, session_factory):
        async def write_then_fail() -> None:
            async with UnitOfWork(session_factory) as uow:
                uow.repositories.trading_clients.add(a_client("appa"))
                raise RuntimeError("boom")

        with pytest.raises(RuntimeError):
            await write_then_fail()

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.get("appa") is None

    async def test_a_write_and_a_journal_entry_commit_together(self, session_factory):
        from garuda.domain.journal import trading_halted

        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("appa"))
            await uow.journal.append(
                [trading_halted("test", occurred_at=NOW, trading_day=NOW.date())]
            )

        async with UnitOfWork(session_factory) as uow:
            assert await uow.repositories.trading_clients.get("appa") is not None
            assert len([e async for e in uow.journal.replay(NOW.date())]) == 1

    async def test_repositories_outside_the_block_are_refused(self, session_factory):
        uow = UnitOfWork(session_factory)
        with pytest.raises(UnitOfWorkError, match="not open"):
            _ = uow.repositories


class TestEveryTableIsReachable:
    async def test_each_repository_can_count_its_table(self, session_factory):
        """A model that does not match its table fails here rather than in use."""
        from garuda.persistence.repositories import Repositories

        names = [name for name in dir(Repositories) if not name.startswith("_") and name != "of"]
        assert len(names) == 67

        async with UnitOfWork(session_factory) as uow:
            for name in names:
                repository = getattr(uow.repositories, name)
                assert await repository.count() >= 0, name

    async def test_the_same_repository_is_returned_each_time(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            assert uow.repositories.trades is uow.repositories.trades


class TestSpecificFinders:
    async def test_a_trading_client_is_found_by_its_natural_key(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("appa", "ZERODHA", "AB1234"))

        async with UnitOfWork(session_factory) as uow:
            row = await uow.repositories.trading_clients.by_account("ZERODHA", "AB1234")
        assert row is not None
        assert row.id == "appa"

    async def test_only_enabled_accounts_are_routed_to(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            uow.repositories.trading_clients.add(a_client("on", "ZERODHA", "A1"))
            disabled = a_client("off", "FYERS", "B1")
            disabled.enabled = False
            uow.repositories.trading_clients.add(disabled)

        async with UnitOfWork(session_factory) as uow:
            rows = await uow.repositories.trading_clients.enabled()
        assert [row.id for row in rows] == ["on"]

    async def test_symbol_info_lists_the_indices(self, session_factory):
        async with UnitOfWork(session_factory) as uow:
            await uow.repositories.symbols.upsert_all(
                [
                    {
                        "symbol": "NIFTY",
                        "exchange": "NSE",
                        "is_index": True,
                        "index_symbol": "NIFTY 50",
                        "strike_gap": 50,
                    },
                    {
                        "symbol": "RELIANCE",
                        "exchange": "NSE",
                        "is_index": False,
                        "index_symbol": None,
                        "strike_gap": 20,
                    },
                ]
            )

        async with UnitOfWork(session_factory) as uow:
            indices = await uow.repositories.symbols.indices()
        assert [row.symbol for row in indices] == ["NIFTY"]
