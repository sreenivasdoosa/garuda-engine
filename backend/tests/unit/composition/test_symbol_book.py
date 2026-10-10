"""Turning a derived series on and off while the engine runs.

The failure this fixes is quiet: the engine read the symbols once at startup
and handed the snapshot to four components, so a row saved from the Symbols
page changed nothing until a restart. A series switched on stayed off, and the
card said "waiting for the chain" -- which was true of the chain and false
about the reason.
"""

from __future__ import annotations

from garuda.composition.instruments import SymbolBook
from garuda.domain.symbol import SymbolInfo


def nifty(**flags: object) -> SymbolInfo:
    return SymbolInfo(symbol="NIFTY", exchange_code="NSE", **flags)  # type: ignore[arg-type]


class TestReadingTheBook:
    def test_it_reads_as_an_ordinary_mapping(self) -> None:
        """Everything that already took a Mapping is unchanged."""
        book = SymbolBook({"NIFTY": nifty()})

        assert book["NIFTY"].symbol == "NIFTY"
        assert book.get("NIFTY") is not None
        assert book.get("MISSING") is None
        assert len(book) == 1
        assert [info.symbol for info in book.values()] == ["NIFTY"]

    def test_an_empty_book_is_readable(self) -> None:
        assert len(SymbolBook()) == 0


class TestSwappingIt:
    def test_holders_see_the_new_configuration(self) -> None:
        """The point: a component handed the book at startup must observe a
        change made an hour later without being rebuilt."""
        book = SymbolBook({"NIFTY": nifty()})
        held = book  # what a component captured at build time

        book.replace({"NIFTY": nifty(derives_straddle=True)})

        assert held["NIFTY"].derives_straddle is True

    def test_the_version_moves_so_a_consumer_can_notice(self) -> None:
        book = SymbolBook({"NIFTY": nifty()})
        before = book.version

        book.replace({"NIFTY": nifty(derives_iv=True)})

        assert book.version == before + 1

    def test_it_replaces_rather_than_merges(self) -> None:
        """A symbol deleted from the table has to disappear; a merge would
        keep it for the life of the process."""
        book = SymbolBook({"NIFTY": nifty(), "BANKNIFTY": nifty()})

        book.replace({"NIFTY": nifty()})

        assert set(book) == {"NIFTY"}

    def test_a_series_can_be_switched_off_again(self) -> None:
        """Both directions at runtime, not just on."""
        book = SymbolBook({"NIFTY": nifty(derives_straddle=True)})

        book.replace({"NIFTY": nifty(derives_straddle=False)})

        assert book["NIFTY"].derives_anything is False
