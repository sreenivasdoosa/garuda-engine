"""Dhan addresses an instrument by a pair, not a number.

Everything here is about that pair surviving the round trip: master row to
subscribe frame to packet header and back to an instrument the engine routes.
"""

from __future__ import annotations

from datetime import date

from garuda.domain.instrument import InstrumentId
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_master import DhanInstrument


def a_row(**overrides: object) -> DhanInstrument:
    fields: dict[str, object] = {
        "security_id": "44234",
        "segment": "NSE_FNO",
        "exchange": "NSE",
        "trading_symbol": "NIFTY26JUN21100CE",
        "underlying": "NIFTY",
        "lot_size": 75,
        "expiry": date(2026, 6, 25),
        "strike": 21100,
        "is_index": False,
        "option_type": "CE",
        "is_future": False,
    }
    fields.update(overrides)
    return DhanInstrument(**fields)  # type: ignore[arg-type]


OPTION = InstrumentId("NSE:NIFTY26JUN21100CE")
INDEX = InstrumentId("NSE:NIFTY")


class TestAddressing:
    def test_a_token_carries_both_halves(self) -> None:
        """A security id alone is not unique across segments."""
        catalogue = DhanCatalogue([a_row()])

        assert catalogue.token_for(OPTION) == "NSE_FNO:44234"

    def test_a_token_round_trips(self) -> None:
        catalogue = DhanCatalogue([a_row()])

        token = catalogue.token_for(OPTION)

        assert token is not None
        assert catalogue.instrument_for(token) == OPTION

    def test_the_packet_header_resolves_to_the_instrument(self) -> None:
        """The binary carries the segment as a number and no symbol at all."""
        catalogue = DhanCatalogue([a_row()])

        assert catalogue.by_wire(2, 44234) == OPTION

    def test_the_same_security_id_in_two_segments_stays_distinct(self) -> None:
        """Dhan reuses security ids across segments; keying on the id alone
        would route one segment's ticks to the other's instrument."""
        catalogue = DhanCatalogue(
            [
                a_row(),
                a_row(
                    segment="NSE_EQ",
                    trading_symbol="INFY",
                    strike=None,
                    expiry=None,
                    option_type="",
                    underlying="INFY",
                ),
            ]
        )

        assert catalogue.by_wire(2, 44234) == OPTION
        assert catalogue.by_wire(1, 44234) == InstrumentId("NSE:INFY")

    def test_an_unlisted_instrument_has_no_token(self) -> None:
        catalogue = DhanCatalogue([a_row()])

        assert catalogue.token_for(InstrumentId("NSE:NOTLISTED")) is None

    def test_a_segment_the_feed_does_not_carry_is_not_addressable(self) -> None:
        """It still quotes and answers history -- only the socket cannot
        reach it, because its segment has no number."""
        catalogue = DhanCatalogue([a_row(segment="NSE_XX")])

        assert catalogue.details_for(OPTION) is not None
        assert catalogue.segment_number_for(OPTION) is None

    def test_a_non_numeric_security_id_is_skipped_not_fatal(self) -> None:
        catalogue = DhanCatalogue([a_row(security_id="not-a-number"), a_row(security_id="7")])

        assert catalogue.by_wire(2, 7) == OPTION


class TestIndexRows:
    def test_an_index_is_recognised_by_its_segment(self) -> None:
        """It subscribes in a different mode and decodes from a different
        packet, so getting this wrong means it never ticks at all."""
        catalogue = DhanCatalogue(
            [
                a_row(
                    segment="IDX_I",
                    trading_symbol="NIFTY",
                    is_index=True,
                    strike=None,
                    expiry=None,
                    option_type="",
                )
            ]
        )

        assert catalogue.is_index(INDEX) is True
        assert catalogue.segment_number_for(INDEX) == 0

    def test_a_tradable_is_not_an_index(self) -> None:
        catalogue = DhanCatalogue([a_row()])

        assert catalogue.is_index(OPTION) is False


class TestHistoryKind:
    def test_an_index_option(self) -> None:
        catalogue = DhanCatalogue([a_row(is_index=True)])

        assert catalogue.history_kind(OPTION) == "OPTIDX"

    def test_a_commodity_future(self) -> None:
        row = a_row(
            segment="MCX_COMM",
            exchange="MCX",
            trading_symbol="CRUDEOIL26JUNFUT",
            option_type="",
            is_future=True,
            strike=None,
        )
        catalogue = DhanCatalogue([row])

        assert catalogue.history_kind(InstrumentId("MCX:CRUDEOIL26JUNFUT")) == "FUTCOM"

    def test_an_unlisted_instrument_has_no_kind(self) -> None:
        catalogue = DhanCatalogue([a_row()])

        assert catalogue.history_kind(InstrumentId("NSE:NOTLISTED")) is None


class TestGroupingForQuotes:
    def test_instruments_group_by_segment(self) -> None:
        """The quote call is posted as a segment map, so this split is the
        request's shape, not a convenience."""
        catalogue = DhanCatalogue(
            [
                a_row(),
                a_row(
                    security_id="1",
                    segment="NSE_EQ",
                    trading_symbol="INFY",
                    strike=None,
                    expiry=None,
                    option_type="",
                ),
            ]
        )

        grouped = catalogue.group_by_segment([OPTION, InstrumentId("NSE:INFY")])

        assert set(grouped) == {"NSE_FNO", "NSE_EQ"}
        assert grouped["NSE_FNO"] == [OPTION]

    def test_an_unlisted_instrument_is_left_out_entirely(self) -> None:
        """Sending an unknown security id has Dhan refuse the whole batch, not
        just that one."""
        catalogue = DhanCatalogue([a_row()])

        grouped = catalogue.group_by_segment([OPTION, InstrumentId("NSE:NOTLISTED")])

        assert grouped == {"NSE_FNO": [OPTION]}
