"""Dhan's scrip master, and the symbol grammar it has to rebuild.

The grammar is a convention, not something derivable, and getting it wrong
does not fail loudly: it produces a symbol nothing matches, and that
instrument silently never ticks. So every form is pinned.
"""

from __future__ import annotations

from datetime import date

import pytest

from garuda.marketdata.providers.dhan_master import (
    canonical_symbol,
    parse_master,
    segment_for,
)

HEADER = (
    "SEM_SMST_SECURITY_ID,SEM_EXM_EXCH_ID,SEM_SEGMENT,SEM_EXCH_INSTRUMENT_TYPE,"
    "SEM_OPTION_TYPE,SEM_TRADING_SYMBOL,SEM_CUSTOM_SYMBOL,UNDERLYING_SYMBOL,"
    "SEM_LOT_UNITS,SEM_STRIKE_PRICE,SEM_EXPIRY_DATE"
)


def a_master(*rows: str) -> str:
    return HEADER + "\n" + "\n".join(rows) + "\n"


class TestTheSymbolGrammar:
    def test_a_future_uses_the_month_name(self) -> None:
        built = canonical_symbol(
            "NIFTY", date(2026, 6, 25), option_type="", is_future=True, strike=None, monthly=True
        )

        assert built == "NIFTY26JUNFUT"

    def test_a_monthly_option_uses_the_month_name(self) -> None:
        built = canonical_symbol(
            "CRUDEOIL",
            date(2026, 6, 18),
            option_type="CE",
            is_future=False,
            strike=8600,
            monthly=True,
        )

        assert built == "CRUDEOIL26JUN8600CE"

    def test_a_weekly_option_uses_a_month_code_and_the_day(self) -> None:
        """A two-digit month would run into the day that follows it."""
        built = canonical_symbol(
            "NIFTY",
            date(2026, 6, 9),
            option_type="CE",
            is_future=False,
            strike=21100,
            monthly=False,
        )

        assert built == "NIFTY2660921100CE"

    @pytest.mark.parametrize(
        ("month", "code"), [(10, "O"), (11, "N"), (12, "D"), (1, "1"), (9, "9")]
    )
    def test_the_last_three_months_are_letters(self, month: int, code: str) -> None:
        built = canonical_symbol(
            "NIFTY",
            date(2026, month, 7),
            option_type="PE",
            is_future=False,
            strike=100,
            monthly=False,
        )

        assert built == f"NIFTY26{code}07100PE"


class TestSegments:
    @pytest.mark.parametrize(
        ("exchange", "code", "expected"),
        [
            ("NSE", "E", "NSE_EQ"),
            ("NSE", "D", "NSE_FNO"),
            ("NSE", "C", "NSE_CURRENCY"),
            ("BSE", "D", "BSE_FNO"),
            ("MCX", "M", "MCX_COMM"),
        ],
    )
    def test_each_exchange_and_code_maps_to_dhans_segment(
        self, exchange: str, code: str, expected: str
    ) -> None:
        assert segment_for(exchange, code, is_index=False) == expected

    def test_an_index_is_its_own_segment_whatever_the_exchange(self) -> None:
        """It decides both how a packet is decoded and which mode it is
        subscribed in, so it wins over the exchange."""
        assert segment_for("NSE", "E", is_index=True) == "IDX_I"
        assert segment_for("BSE", "D", is_index=True) == "IDX_I"


class TestParsing:
    def test_the_last_expiry_of_a_month_is_the_monthly_one(self) -> None:
        """Two NIFTY expiries in June: the later is monthly, the earlier
        weekly. It cannot be read off a single row."""
        master = a_master(
            "1,NSE,D,OPTIDX,CE,X,X,NIFTY,75,21100,2026-06-09",
            "2,NSE,D,OPTIDX,CE,Y,Y,NIFTY,75,21100,2026-06-25",
        )

        rows = {row.security_id: row.trading_symbol for row in parse_master(master)}

        assert rows["1"] == "NIFTY2660921100CE"
        assert rows["2"] == "NIFTY26JUN21100CE"

    def test_an_index_keeps_its_published_name(self) -> None:
        master = a_master("13,NSE,I,INDEX,,NIFTY 50,NIFTY 50,,1,0,")

        [row] = parse_master(master)

        assert row.is_index is True
        assert row.trading_symbol == "NIFTY 50"
        assert row.segment == "IDX_I"

    def test_equity_keeps_the_brokers_own_symbol(self) -> None:
        master = a_master("2885,NSE,E,EQUITY,,RELIANCE,Reliance,,1,0,")

        [row] = parse_master(master)

        assert row.trading_symbol == "RELIANCE"
        assert row.segment == "NSE_EQ"

    def test_a_row_with_no_security_id_is_skipped(self) -> None:
        master = a_master(",NSE,E,EQUITY,,RELIANCE,Reliance,,1,0,")

        assert parse_master(master) == []

    def test_one_bad_row_does_not_cost_the_others(self) -> None:
        master = a_master(
            "2885,NSE,E,EQUITY,,RELIANCE,Reliance,,1,0,",
            "not,enough,columns",
            "1594,NSE,E,EQUITY,,INFY,Infosys,,1,0,",
        )

        assert {row.security_id for row in parse_master(master)} >= {"2885", "1594"}

    def test_the_lot_size_and_expiry_come_through(self) -> None:
        master = a_master("3,NSE,D,FUTIDX,,X,X,NIFTY,75,0,2026-06-25")

        [row] = parse_master(master)

        assert row.lot_size == 75
        assert row.expiry == date(2026, 6, 25)
        assert row.trading_symbol == "NIFTY26JUNFUT"

    def test_an_empty_master_is_empty_rather_than_an_error(self) -> None:
        assert parse_master("") == []
