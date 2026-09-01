"""Venues, built from the rows an operator edits."""

from __future__ import annotations

from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from garuda.composition.venues import DEFAULT_WEEKEND, Venues, venues_from
from garuda.domain.calendar import TradingCalendar
from garuda.domain.enums import ProductType, Segment
from garuda.domain.money import Currency
from garuda.persistence.models import (
    ExchangesRow,
    HolidaysRow,
    SpecialTradingDaysRow,
)

IST = ZoneInfo("Asia/Kolkata")
MONDAY = date(2026, 8, 31)
SATURDAY = date(2026, 9, 5)


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


def special_day(**overrides: object) -> SpecialTradingDaysRow:
    defaults: dict[str, object] = {
        "exchange": "NSE",
        "trading_date": "2026-09-05",
        "trading_day_name": "Union Budget",
    }
    return SpecialTradingDaysRow(**{**defaults, **overrides})


class TestSpecialTradingDays:
    """The case that motivates the table: the Budget lands on a Saturday and
    the exchange trades anyway."""

    def test_a_saturday_is_shut_without_one(self) -> None:
        calendar = venues_from([exchange_row()], []).exchanges["NSE"].calendar

        assert calendar.is_trading_day(SATURDAY) is False

    def test_a_special_day_opens_a_weekend_at_the_venues_usual_hours(self) -> None:
        venues = venues_from([exchange_row()], [], [special_day()])

        calendar = venues.exchanges["NSE"].calendar
        assert calendar.is_trading_day(SATURDAY) is True
        window = calendar.windows_on(SATURDAY)[0]
        assert window.start == datetime(2026, 9, 5, 9, 15, tzinfo=IST)
        assert window.end == datetime(2026, 9, 5, 15, 30, tzinfo=IST)
        assert calendar.is_open(datetime(2026, 9, 5, 10, 0, tzinfo=IST)) is True
        assert calendar.is_open(datetime(2026, 9, 5, 16, 0, tzinfo=IST)) is False

    def test_its_own_hours_replace_the_usual_ones(self) -> None:
        """Diwali muhurat: a short evening session, not the normal day."""
        row = special_day(market_open=time(18, 15), market_close=time(19, 15))

        calendar = venues_from([exchange_row()], [], [row]).exchanges["NSE"].calendar

        window = calendar.windows_on(SATURDAY)[0]
        assert window.start == datetime(2026, 9, 5, 18, 15, tzinfo=IST)
        assert window.end == datetime(2026, 9, 5, 19, 15, tzinfo=IST)
        assert calendar.is_open(datetime(2026, 9, 5, 10, 0, tzinfo=IST)) is False
        assert calendar.is_open(datetime(2026, 9, 5, 18, 30, tzinfo=IST)) is True

    def test_it_opens_a_day_that_is_also_a_holiday(self) -> None:
        """Diwali is a holiday and has a muhurat session, so the special day
        has to win over the holiday as well as over the weekend."""
        holiday = HolidaysRow(date="2026-09-05", exchange="NSE")
        row = special_day(market_open=time(18, 15), market_close=time(19, 15))

        calendar = venues_from([exchange_row()], [holiday], [row]).exchanges["NSE"].calendar

        assert calendar.is_trading_day(SATURDAY) is True
        assert calendar.is_open(datetime(2026, 9, 5, 18, 30, tzinfo=IST)) is True

    def test_one_side_of_the_hours_falls_back_rather_than_inventing_the_other(self) -> None:
        row = special_day(market_open=time(18, 15))

        calendar = venues_from([exchange_row()], [], [row]).exchanges["NSE"].calendar

        window = calendar.windows_on(SATURDAY)[0]
        assert window.start == datetime(2026, 9, 5, 9, 15, tzinfo=IST)
        assert window.end == datetime(2026, 9, 5, 15, 30, tzinfo=IST)

    def test_a_special_day_for_another_venue_does_not_open_this_one(self) -> None:
        row = special_day(exchange="BSE")

        calendar = venues_from([exchange_row()], [], [row]).exchanges["NSE"].calendar

        assert calendar.is_trading_day(SATURDAY) is False

    def test_an_unparseable_date_is_ignored_rather_than_failing_the_venue(self) -> None:
        row = special_day(trading_date="05-09-2026")

        venues = venues_from([exchange_row()], [], [row])

        assert "NSE" in venues.exchanges
        assert venues.exchanges["NSE"].calendar.is_trading_day(SATURDAY) is False

    def test_a_weekday_special_day_changes_nothing_it_should_not(self) -> None:
        """A Monday is already open; naming it special must not shorten it."""
        row = special_day(trading_date="2026-08-31")

        calendar = venues_from([exchange_row()], [], [row]).exchanges["NSE"].calendar

        window = calendar.windows_on(MONDAY)[0]
        assert window.start == datetime(2026, 8, 31, 9, 15, tzinfo=IST)
        assert window.end == datetime(2026, 8, 31, 15, 30, tzinfo=IST)


class TestTheSeededSpecialDays:
    """The three shapes the seed file exists to demonstrate, checked through
    the calendar rather than by reading the rows back.

    The rows are real sessions: the FY2026 Union Budget on Saturday
    01-Feb-2025, Diwali muhurat for Samvat 2082 on 21-Oct-2025, and Holi
    14-Mar-2025 where commodities trade the evening and equities do not. If a
    seed edit breaks one of these, it breaks here with the case named.
    """

    @staticmethod
    def venues_from_seed() -> Venues:
        """Through `coerce_row`, which is what the loader uses.

        Building the rows straight from the YAML leaves `market_open` a string
        and `Session` refuses it -- so a test that skipped the coercion would
        be exercising a path production does not have.
        """
        from garuda.persistence.seed import coerce_row, read_seed

        def rows_of[T](model: type[T], name: str) -> list[T]:
            return [model(**coerce_row(model, row)) for row in read_seed(name)]

        return venues_from(
            rows_of(ExchangesRow, "exchanges"),
            rows_of(HolidaysRow, "holidays"),
            rows_of(SpecialTradingDaysRow, "special_trading_days"),
        )

    def calendars(self) -> dict[str, TradingCalendar]:
        return {code: venue.calendar for code, venue in self.venues_from_seed().exchanges.items()}

    def test_the_budget_saturday_trades_the_usual_session(self) -> None:
        budget = date(2025, 2, 1)
        assert budget.weekday() == 5, "the point of the row is that it is a Saturday"

        calendars = self.calendars()

        for code in ("NSE", "BSE"):
            windows = calendars[code].windows_on(budget)
            assert len(windows) == 1, code
            assert windows[0].start.time() == time(9, 15)
            assert windows[0].end.time() == time(15, 40)

    def test_every_other_saturday_stays_shut(self) -> None:
        calendars = self.calendars()

        for code in ("NSE", "BSE", "MCX"):
            assert calendars[code].is_trading_day(date(2025, 2, 8)) is False, code

    def test_muhurat_is_one_evening_hour_on_a_day_that_is_a_holiday(self) -> None:
        diwali = date(2025, 10, 21)
        calendars = self.calendars()

        for code in ("NSE", "BSE"):
            calendar = calendars[code]
            windows = calendar.windows_on(diwali)
            assert [(w.start.time(), w.end.time()) for w in windows] == [
                (time(13, 45), time(14, 45))
            ], code
            # The holiday is still there; the session is what wins.
            assert calendar.is_open(datetime(2025, 10, 21, 10, 0, tzinfo=IST)) is False
            assert calendar.is_open(datetime(2025, 10, 21, 14, 0, tzinfo=IST)) is True

    def test_mcx_is_shut_for_muhurat_because_no_row_names_it(self) -> None:
        calendars = self.calendars()

        assert calendars["MCX"].is_trading_day(date(2025, 10, 21)) is False

    def test_on_holi_commodities_trade_the_evening_and_equities_do_not(self) -> None:
        holi = date(2025, 3, 14)
        calendars = self.calendars()

        for code in ("NSE", "BSE"):
            assert calendars[code].is_trading_day(holi) is False, code

        mcx = calendars["MCX"]
        windows = mcx.windows_on(holi)
        assert [(w.start.time(), w.end.time()) for w in windows] == [(time(17, 0), time(23, 30))]
        # The morning MCX would otherwise have run from 09:00 is shut, which is
        # the whole reason the holiday row on MCX has to be there too.
        assert mcx.is_open(datetime(2025, 3, 14, 10, 0, tzinfo=IST)) is False
        assert mcx.is_open(datetime(2025, 3, 14, 19, 0, tzinfo=IST)) is True
