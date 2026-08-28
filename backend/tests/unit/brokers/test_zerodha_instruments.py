"""Parsing the Zerodha instrument master."""

from __future__ import annotations

from datetime import UTC, date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from garuda.brokers.zerodha.instruments import (
    canonical_symbol,
    is_stale,
    next_refresh_after,
    parse_instruments,
)
from garuda.domain import DomainError, InstrumentKind, OptionType, Segment
from garuda.domain.instrument import InstrumentId

IST = ZoneInfo("Asia/Kolkata")

HEADER = (
    "instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,"
    "strike,tick_size,lot_size,instrument_type,segment,exchange"
)

ROWS = {
    "equity": "738561,2885,RELIANCE,RELIANCE INDUSTRIES,0,,0,0.05,1,EQ,NSE,NSE",
    "index": "256265,1001,NIFTY 50,NIFTY 50,0,,0,0.05,1,EQ,INDICES,NSE",
    "future": "12345678,48186,NIFTY26AUGFUT,NIFTY,0,2026-08-27,0,0.05,75,FUT,NFO-FUT,NFO",
    "call": "12345679,48187,NIFTY26AUG25000CE,NIFTY,0,2026-08-27,25000,0.05,75,CE,NFO-OPT,NFO",
    "put": "12345680,48188,NIFTY26AUG25000PE,NIFTY,0,2026-08-27,25000,0.05,75,PE,NFO-OPT,NFO",
    "fractional_strike": (
        "12345681,48189,BANKNIFTY26AUG52500.5CE,BANKNIFTY,0,2026-08-27,52500.5,"
        "0.05,15,CE,NFO-OPT,NFO"
    ),
    "calendar_spread": (
        "99999999,49999,NIFTY26MAY26JULFUT,NIFTY,0,2026-07-30,0,0.05,75,FUT,NFO-FUT,NFO"
    ),
    "commodity": "53496327,208970,GOLD26OCTFUT,GOLD,0,2026-10-05,0,1,100,FUT,MCX,MCX",
    "unmodelled_venue": "111,222,SOMETHING,SOMETHING,0,,0,0.05,1,EQ,XYZ,XYZ",
}


def csv_of(*keys: str) -> str:
    return "\n".join([HEADER, *(ROWS[key] for key in keys)]) + "\n"


@pytest.fixture
def venues(nse, mcx):
    return {"NSE": nse, "MCX": mcx}


class TestShape:
    def test_something_that_is_not_a_kite_master_is_refused(self, venues):
        with pytest.raises(DomainError, match="not a Kite instrument master"):
            parse_instruments("name,price\nfoo,1\n", venues)

    def test_an_empty_master_parses_to_nothing(self, venues):
        assert len(parse_instruments(HEADER + "\n", venues)) == 0


class TestKinds:
    def test_an_equity_row(self, venues):
        (instrument,) = parse_instruments(csv_of("equity"), venues).instruments
        assert instrument.kind is InstrumentKind.EQUITY
        assert instrument.segment is Segment.EQUITY
        assert instrument.id == InstrumentId("NSE:RELIANCE")
        assert instrument.expiry is None

    def test_an_index_is_priced_but_never_routed(self, venues):
        (instrument,) = parse_instruments(csv_of("index"), venues).instruments
        assert instrument.kind is InstrumentKind.INDEX
        assert not instrument.is_tradable

    def test_a_future_row(self, venues):
        (instrument,) = parse_instruments(csv_of("future"), venues).instruments
        assert instrument.kind is InstrumentKind.FUTURE
        assert instrument.expiry == date(2026, 8, 27)
        assert instrument.underlying == InstrumentId("NSE:NIFTY")
        assert instrument.lot_size == 75

    @pytest.mark.parametrize(
        ("row", "expected"), [("call", OptionType.CALL), ("put", OptionType.PUT)]
    )
    def test_an_option_row_carries_its_type(self, venues, row, expected):
        (instrument,) = parse_instruments(csv_of(row), venues).instruments
        assert instrument.kind is InstrumentKind.OPTION
        assert instrument.option_type is expected
        assert instrument.strike == Decimal(25000)

    def test_options_carry_exercise_style_and_settlement(self, venues):
        """Absent from Kite's CSV, so they come from configuration."""
        (instrument,) = parse_instruments(csv_of("call"), venues).instruments
        assert instrument.exercise_style is not None
        assert instrument.settlement_type is not None


class TestSymbolNormalisation:
    """An engine id appears in log lines and journal keys; a space breaks both."""

    @pytest.mark.parametrize(
        ("broker_symbol", "expected"),
        [
            ("NIFTY 50", "NIFTY_50"),
            ("NIFTY BANK", "NIFTY_BANK"),
            ("RELIANCE", "RELIANCE"),
            ("NIFTY26AUG25000CE", "NIFTY26AUG25000CE"),
        ],
    )
    def test_whitespace_is_removed_from_the_identifier(self, broker_symbol, expected):
        assert canonical_symbol(broker_symbol) == expected

    def test_an_index_gets_a_usable_id(self, venues):
        (instrument,) = parse_instruments(csv_of("index"), venues).instruments
        assert instrument.id == InstrumentId("NSE:NIFTY_50")

    def test_the_brokers_own_spelling_is_not_lost(self, venues):
        """It is what the adapter sends back to the broker."""
        (instrument,) = parse_instruments(csv_of("index"), venues).instruments
        assert instrument.trading_symbol == "NIFTY 50"


class TestVenueMapping:
    def test_nfo_is_nses_derivatives_segment_not_a_separate_venue(self, venues, nse):
        (instrument,) = parse_instruments(csv_of("future"), venues).instruments
        assert instrument.exchange is nse
        assert instrument.segment is Segment.FNO

    def test_a_commodity_lands_on_its_own_venue(self, venues, mcx):
        (instrument,) = parse_instruments(csv_of("commodity"), venues).instruments
        assert instrument.exchange is mcx
        assert instrument.segment is Segment.COMMODITY

    def test_a_venue_the_engine_does_not_model_is_skipped_not_invented(self, venues):
        """A guessed calendar and currency produce a plausible, wrong trading day."""
        catalogue = parse_instruments(csv_of("unmodelled_venue"), venues)
        assert len(catalogue) == 0

    def test_a_venue_the_operator_has_not_configured_is_skipped(self, nse):
        catalogue = parse_instruments(csv_of("commodity"), {"NSE": nse})
        assert len(catalogue) == 0


class TestExactness:
    def test_a_fractional_strike_survives(self, venues):
        """The reference engine rounds strikes through a double and loses this."""
        (instrument,) = parse_instruments(csv_of("fractional_strike"), venues).instruments
        assert instrument.strike == Decimal("52500.5")

    def test_tick_size_is_exact(self, venues):
        (instrument,) = parse_instruments(csv_of("equity"), venues).instruments
        assert instrument.tick_size == Decimal("0.05")


class TestCalendarSpreadGuard:
    def test_a_calendar_spread_is_refused(self, venues):
        """Loaded, it poisons every near-month lookup for its underlying."""
        catalogue = parse_instruments(csv_of("calendar_spread"), venues)
        assert len(catalogue) == 0
        (symbol, reason) = catalogue.skipped[0]
        assert symbol == "NIFTY26MAY26JULFUT"
        assert "calendar spread" in reason

    def test_a_genuine_future_is_not_caught_by_the_guard(self, venues):
        assert len(parse_instruments(csv_of("future"), venues)) == 1

    def test_the_rest_of_the_master_still_loads(self, venues):
        catalogue = parse_instruments(csv_of("equity", "calendar_spread", "future"), venues)
        assert len(catalogue) == 2
        assert len(catalogue.skipped) == 1


class TestTokens:
    def test_the_broker_token_is_kept_beside_the_instrument(self, venues):
        catalogue = parse_instruments(csv_of("equity"), venues)
        assert catalogue.token_for(InstrumentId("NSE:RELIANCE")) == 738561

    def test_the_instrument_itself_carries_no_broker_token(self, venues):
        """Or the same instrument on two brokers becomes two instruments."""
        (instrument,) = parse_instruments(csv_of("equity"), venues).instruments
        assert not hasattr(instrument, "token")

    def test_an_unknown_instrument_has_no_token(self, venues):
        catalogue = parse_instruments(csv_of("equity"), venues)
        assert catalogue.token_for(InstrumentId("NSE:NOTHING")) is None


class TestSkippedRowsAreVisible:
    def test_a_malformed_row_is_reported_not_swallowed(self, venues):
        """A master that silently lost a third of its rows looks like it worked."""
        broken = HEADER + "\nnot-a-number,2885,RELIANCE,RELIANCE,0,,0,0.05,1,EQ,NSE,NSE\n"
        catalogue = parse_instruments(broken, venues)
        assert len(catalogue) == 0
        assert catalogue.skipped[0][0] == "RELIANCE"

    def test_a_derivative_without_an_underlying_is_reported(self, venues):
        row = "1,2,NIFTY26AUGFUT,,0,2026-08-27,0,0.05,75,FUT,NFO-FUT,NFO"
        catalogue = parse_instruments(HEADER + "\n" + row + "\n", venues)
        assert "underlying" in catalogue.skipped[0][1]


class TestStaleness:
    """The master is republished each morning with that day's new strikes."""

    def test_never_downloaded_is_stale(self):
        assert is_stale(None, datetime(2026, 8, 27, 9, 0, tzinfo=IST), timezone=IST)

    def test_yesterdays_file_is_stale(self):
        downloaded = datetime(2026, 8, 26, 9, 0, tzinfo=IST)
        assert is_stale(downloaded, datetime(2026, 8, 27, 9, 0, tzinfo=IST), timezone=IST)

    def test_a_file_downloaded_before_0800_is_stale_once_0800_passes(self):
        """An early restart downloads yesterday's master and must refresh."""
        downloaded = datetime(2026, 8, 27, 7, 40, tzinfo=IST)
        assert is_stale(downloaded, datetime(2026, 8, 27, 8, 1, tzinfo=IST), timezone=IST)

    def test_that_same_file_is_not_stale_before_0800(self):
        downloaded = datetime(2026, 8, 27, 7, 40, tzinfo=IST)
        assert not is_stale(downloaded, datetime(2026, 8, 27, 7, 55, tzinfo=IST), timezone=IST)

    def test_todays_post_publication_file_is_fresh(self):
        downloaded = datetime(2026, 8, 27, 8, 30, tzinfo=IST)
        assert not is_stale(downloaded, datetime(2026, 8, 27, 15, 0, tzinfo=IST), timezone=IST)

    def test_the_publication_hour_is_configurable(self):
        downloaded = datetime(2026, 8, 27, 8, 30, tzinfo=IST)
        assert is_stale(
            downloaded,
            datetime(2026, 8, 27, 9, 30, tzinfo=IST),
            timezone=IST,
            published_at=time(9, 0),
        )

    def test_the_comparison_is_in_the_venues_zone_not_utc(self):
        """20:00 UTC is already the next morning in India."""
        downloaded = datetime(2026, 8, 26, 20, 0, tzinfo=UTC)  # 27th 01:30 IST
        assert not is_stale(downloaded, datetime(2026, 8, 27, 2, 0, tzinfo=IST), timezone=IST)


class TestRefreshSchedule:
    def test_before_publication_the_next_refresh_is_today(self):
        now = datetime(2026, 8, 27, 6, 0, tzinfo=IST)
        assert next_refresh_after(now, timezone=IST) == datetime(2026, 8, 27, 8, 0, tzinfo=IST)

    def test_after_publication_the_next_refresh_is_tomorrow(self):
        now = datetime(2026, 8, 27, 10, 0, tzinfo=IST)
        assert next_refresh_after(now, timezone=IST) == datetime(2026, 8, 28, 8, 0, tzinfo=IST)
