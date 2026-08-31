"""Venues, built from the rows an operator edits."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from garuda.composition.venues import DEFAULT_WEEKEND, Venues, venues_from
from garuda.domain.enums import ProductType, Segment
from garuda.domain.money import Currency
from garuda.persistence.models import ExchangesRow, HolidaysRow

IST = ZoneInfo("Asia/Kolkata")
MONDAY = date(2026, 8, 31)


def exchange_row(**overrides: object) -> ExchangesRow:
    defaults: dict[str, object] = {
        "exchange_code": "NSE",
        "exchange_name": "National Stock Exchange",
        "timezone": "Asia/Kolkata",
        "market_open": time(9, 15),
        "market_close": time(15, 30),
        "currency": "INR",
        "segments": "EQUITY,FNO",
        "is_active": True,
    }
    return ExchangesRow(**{**defaults, **overrides})


def test_a_venue_is_built_from_its_row() -> None:
    venues = venues_from([exchange_row()], [])

    nse = venues.exchanges["NSE"]
    assert nse.timezone == IST
    assert nse.calendar.windows_on(MONDAY)[0].end == datetime(2026, 8, 31, 15, 30, tzinfo=IST)
    assert Segment.FNO in nse.segments


def test_an_inactive_venue_is_not_built() -> None:
    venues = venues_from([exchange_row(is_active=False)], [])

    assert venues.exchanges == {}
    assert venues.all == []


def test_holidays_belong_to_their_own_venue() -> None:
    """A BSE holiday must not close NSE."""
    rows = [exchange_row(), exchange_row(exchange_code="BSE", exchange_name="BSE")]
    holidays = [HolidaysRow(date="2026-09-02", exchange="BSE", description="something")]

    venues = venues_from(rows, holidays)

    wednesday = date(2026, 9, 2)
    assert venues.exchanges["NSE"].calendar.is_trading_day(wednesday)
    assert not venues.exchanges["BSE"].calendar.is_trading_day(wednesday)


def test_an_unreadable_holiday_does_not_stop_the_load() -> None:
    holidays = [
        HolidaysRow(date="not-a-date", exchange="NSE"),
        HolidaysRow(date="2026-09-02", exchange="NSE"),
    ]

    venues = venues_from([exchange_row()], holidays)

    assert not venues.exchanges["NSE"].calendar.is_trading_day(date(2026, 9, 2))


@pytest.mark.parametrize(
    ("configured", "closed_on"),
    [
        ("SAT,SUN", date(2026, 9, 5)),
        ("5,6", date(2026, 9, 5)),
        ("Saturday; Sunday", date(2026, 9, 5)),
        ("FRI,SAT", date(2026, 9, 4)),
    ],
)
def test_weekend_days_are_read_however_they_are_spelled(configured: str, closed_on: date) -> None:
    venues = venues_from([exchange_row(weekend_days=configured)], [])

    assert not venues.exchanges["NSE"].calendar.is_trading_day(closed_on)


def test_an_unreadable_weekend_falls_back_rather_than_trading_every_day() -> None:
    """A venue with no weekend would have the engine expecting Sunday ticks."""
    venues = venues_from([exchange_row(weekend_days="whenever")], [])

    calendar = venues.exchanges["NSE"].calendar
    assert not any(calendar.is_trading_day(date(2026, 9, 5) + timedelta(days=d)) for d in (0, 1))
    assert set(DEFAULT_WEEKEND) == {5, 6}


def test_a_half_configured_pre_open_window_is_no_window() -> None:
    venues = venues_from([exchange_row(pre_market_start=time(9, 0))], [])

    assert venues.exchanges["NSE"].calendar.pre_open_window_on(MONDAY) is None


def test_a_configured_pre_open_window_is_kept() -> None:
    row = exchange_row(pre_market_start=time(9, 0), pre_market_end=time(9, 8))

    window = venues_from([row], []).exchanges["NSE"].calendar.pre_open_window_on(MONDAY)

    assert window is not None
    assert window.start == datetime(2026, 8, 31, 9, 0, tzinfo=IST)


# -- the exit window --------------------------------------------------------


def test_the_exit_window_ends_at_the_close() -> None:
    venues = venues_from([exchange_row()], [])

    window = venues.exit_window(venues.exchanges["NSE"], MONDAY)

    assert window is not None
    assert window.market_close == datetime(2026, 8, 31, 15, 30, tzinfo=IST)


def test_intraday_products_stop_being_squared_off_before_the_close() -> None:
    """The venue takes over at the block; attempts after it can only be refused."""
    row = exchange_row(intraday_squareoff_block_minutes_before_close=10)
    venues = venues_from([row], [])

    window = venues.exit_window(venues.exchanges["NSE"], MONDAY)

    assert window is not None
    at_1522 = datetime(2026, 8, 31, 15, 22, tzinfo=IST)
    assert window.is_closed_for(ProductType.MIS, at_1522)
    assert not window.is_closed_for(ProductType.NRML, at_1522)


def test_a_venue_without_a_block_squares_off_intraday_until_the_close() -> None:
    venues = venues_from([exchange_row()], [])

    window = venues.exit_window(venues.exchanges["NSE"], MONDAY)

    assert window is not None
    assert window.intraday_block is None
    assert not window.is_closed_for(ProductType.MIS, datetime(2026, 8, 31, 15, 29, tzinfo=IST))


def test_a_day_the_venue_does_not_trade_has_no_exit_window() -> None:
    """No close to measure from. Inventing one makes every retry look open."""
    venues = venues_from([exchange_row()], [])

    assert venues.exit_window(venues.exchanges["NSE"], date(2026, 9, 5)) is None


def test_the_engine_squares_off_before_the_venue_forces_it() -> None:
    row = exchange_row(
        intraday_squareoff_minutes_before_close=20,
        intraday_squareoff_block_minutes_before_close=10,
    )
    venues = venues_from([row], [])
    nse = venues.exchanges["NSE"]

    cutoff = venues.intraday_cutoff(nse, MONDAY)
    window = venues.exit_window(nse, MONDAY)

    assert cutoff == datetime(2026, 8, 31, 15, 10, tzinfo=IST)
    assert window is not None
    assert window.intraday_block is not None
    assert cutoff < window.intraday_block


def test_a_venue_with_no_configured_offsets_still_has_a_cutoff() -> None:
    venues = venues_from([exchange_row()], [])

    cutoff = venues.intraday_cutoff(venues.exchanges["NSE"], MONDAY)

    assert cutoff is not None
    assert cutoff < datetime(2026, 8, 31, 15, 30, tzinfo=IST)


def test_venues_are_listed_in_a_stable_order() -> None:
    """So a startup log line reads the same on every restart."""
    rows = [
        exchange_row(exchange_code="MCX", exchange_name="MCX", market_close=time(23, 30)),
        exchange_row(),
        exchange_row(exchange_code="BSE", exchange_name="BSE"),
    ]

    listed = [e.code for e in venues_from(rows, []).all]

    assert listed == ["BSE", "MCX", "NSE"]


def test_a_venue_nobody_configured_segments_for_still_builds() -> None:
    row = exchange_row(exchange_code="XYZ", exchange_name="Somewhere")

    venues = venues_from([row], [])

    assert venues.exchanges["XYZ"].segments


def test_no_configured_venues_is_an_empty_engine_not_a_crash() -> None:
    venues = venues_from([], [])

    assert isinstance(venues, Venues)
    assert venues.all == []


def test_a_reversed_pre_open_window_does_not_take_the_venue_down_with_it() -> None:
    """A session that ends before it starts is refused by the domain.

    Letting that refusal out of the loader would cost every venue, not just
    the misconfigured window.
    """
    row = exchange_row(pre_market_start=time(9, 8), pre_market_end=time(9, 0))

    venues = venues_from([row], [])

    assert "NSE" in venues.exchanges
    assert venues.exchanges["NSE"].calendar.pre_open_window_on(MONDAY) is None


def test_a_weekend_of_nothing_is_still_a_weekend() -> None:
    """An empty setting must not turn Saturday into a trading day."""
    venues = venues_from([exchange_row(weekend_days=" , , ")], [])

    calendar = venues.exchanges["NSE"].calendar
    assert not calendar.is_trading_day(date(2026, 9, 5))
    assert not calendar.is_trading_day(date(2026, 9, 6))
    assert calendar.is_trading_day(MONDAY)


def test_a_venue_settles_in_the_currency_its_row_names() -> None:
    row = exchange_row(exchange_code="NYSE", exchange_name="New York", currency="USD")

    venues = venues_from([row], [])

    assert venues.exchanges["NYSE"].currency is Currency.USD


def test_a_currency_the_engine_does_not_know_takes_only_that_venue_down() -> None:
    """A P&L figure in the wrong currency is worse than a venue that will not load."""
    rows = [
        exchange_row(exchange_code="XXX", exchange_name="Nowhere", currency="ZZZ"),
        exchange_row(),
    ]

    venues = venues_from(rows, [])

    assert "XXX" not in venues.exchanges
    assert venues.exchanges["NSE"].currency is Currency.INR


def test_a_venue_with_no_currency_is_not_traded() -> None:
    venues = venues_from([exchange_row(currency=None)], [])

    assert venues.exchanges == {}


def test_a_venue_lists_the_segments_its_row_names() -> None:
    row = exchange_row(exchange_code="MCX", exchange_name="Commodities", segments="COMMODITY")

    venues = venues_from([row], [])

    assert venues.exchanges["MCX"].segments == frozenset({Segment.COMMODITY})


def test_a_venue_that_does_not_say_what_it_trades_is_not_traded() -> None:
    """A default of "all of them" tells a strategy a commodity exchange lists
    equities, which is worse than a venue that will not load."""
    venues = venues_from(
        [exchange_row(segments=None), exchange_row(exchange_code="BSE", exchange_name="BSE")], []
    )

    assert "NSE" not in venues.exchanges
    assert "BSE" in venues.exchanges


def test_a_venue_with_no_segments_says_what_it_should_have_said(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The domain would refuse an empty segment set anyway. The reason for
    catching it here is the message: "expected some of ..." is something an
    operator can act on, and "trades no segments" is not."""
    with caplog.at_level("ERROR"):
        venues_from([exchange_row(segments="")], [])

    assert "does not say which segments" in caplog.text
    assert "EQUITY" in caplog.text


def test_a_segment_that_is_not_one_takes_only_that_venue_down() -> None:
    rows = [
        exchange_row(exchange_code="XXX", exchange_name="Nowhere", segments="BULLION"),
        exchange_row(),
    ]

    venues = venues_from(rows, [])

    assert "XXX" not in venues.exchanges
    assert "NSE" in venues.exchanges


def test_segments_are_read_however_they_are_spaced() -> None:
    row = exchange_row(segments=" equity , fno ")

    venues = venues_from([row], [])

    assert venues.exchanges["NSE"].segments == frozenset({Segment.EQUITY, Segment.FNO})
