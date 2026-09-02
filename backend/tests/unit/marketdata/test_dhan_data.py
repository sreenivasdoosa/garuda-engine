"""Dhan as a QuoteSource and a HistorySource.

Driven through httpx's mock transport, so the claims are about the request
that leaves and the engine objects that come back -- not about a broker.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx
import pytest

from garuda.core.clock import ReplayClock
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import BarInterval
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_data import DhanHistory, DhanQuotes
from garuda.marketdata.providers.dhan_master import DhanInstrument
from garuda.marketdata.providers.dhan_rest import DhanDataError, DhanRest
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.throttle import RateGate

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CALL = InstrumentId("NSE:NIFTY26AUG25000CE")
SECURITY_ID = "44234"


def a_row(**overrides: object) -> DhanInstrument:
    fields: dict[str, object] = {
        "security_id": SECURITY_ID,
        "segment": "NSE_FNO",
        "exchange": "NSE",
        "trading_symbol": "NIFTY26AUG25000CE",
        "underlying": "NIFTY",
        "lot_size": 75,
        "option_type": "CE",
        "is_index": True,
    }
    fields.update(overrides)
    return DhanInstrument(**fields)  # type: ignore[arg-type]


class Recorder:
    """Answers a canned payload and keeps what was asked."""

    def __init__(self, payload: object, status: int = 200) -> None:
        self.payload = payload
        self.status = status
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return httpx.Response(self.status, json=self.payload)

    @property
    def body(self) -> dict[str, Any]:
        return dict(json.loads(self.requests[-1].content))


def a_rest(recorder: Recorder) -> DhanRest:
    clock = ReplayClock(T0)
    return DhanRest(
        "token",
        "client",
        httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
        clock,
        quote_gate=RateGate(timedelta(0), clock),
        history_gate=RateGate(timedelta(0), clock),
    )


@pytest.fixture
def registry(nifty_call: Instrument) -> InstrumentRegistry:
    return InstrumentRegistry.build([nifty_call])


@pytest.fixture
def catalogue() -> DhanCatalogue:
    return DhanCatalogue([a_row()])


def quotes(
    recorder: Recorder, catalogue: DhanCatalogue, registry: InstrumentRegistry
) -> DhanQuotes:
    return DhanQuotes(a_rest(recorder), lambda: catalogue, lambda: registry, ReplayClock(T0))


def history(
    recorder: Recorder, catalogue: DhanCatalogue, registry: InstrumentRegistry
) -> DhanHistory:
    return DhanHistory(a_rest(recorder), lambda: catalogue, lambda: registry)


A_QUOTE = {
    "last_price": 101.5,
    "last_quantity": 75,
    "volume": 5000,
    "average_price": 100.25,
    "buy_quantity": 900,
    "sell_quantity": 1100,
    "oi": 4321,
    "ohlc": {"open": 99.0, "high": 103.0, "low": 97.0, "close": 98.0},
}
ANSWERED = {"data": {"NSE_FNO": {SECURITY_ID: A_QUOTE}}}


class TestQuotes:
    async def test_the_request_is_posted_as_a_segment_map(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """Dhan quotes are posted, not fetched, and grouped by segment."""
        recorder = Recorder(ANSWERED)

        await quotes(recorder, catalogue, registry).quotes([CALL])

        assert recorder.requests[-1].method == "POST"
        assert recorder.body == {"NSE_FNO": [int(SECURITY_ID)]}

    async def test_both_headers_go_out_and_neither_is_a_bearer(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """A request missing client-id is refused in a way that reads like a
        bad token."""
        recorder = Recorder(ANSWERED)

        await quotes(recorder, catalogue, registry).quotes([CALL])

        headers = recorder.requests[-1].headers
        assert headers["access-token"] == "token"
        assert headers["client-id"] == "client"
        assert "authorization" not in headers

    async def test_a_quote_becomes_a_tick(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        answered = await quotes(recorder := Recorder(ANSWERED), catalogue, registry).quotes([CALL])

        assert recorder.requests
        assert answered[CALL].last_price.amount == Decimal("101.5")
        assert answered[CALL].open_interest == 4321

    async def test_an_instrument_dhan_answers_nothing_for_is_absent(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """Absent, never a zero price -- which the risk gate would trade on."""
        answered = await quotes(Recorder({"data": {}}), catalogue, registry).quotes([CALL])

        assert answered == {}

    async def test_an_instrument_dhan_does_not_list_is_never_asked_for(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """An unknown security id has Dhan refuse the whole batch."""
        recorder = Recorder(ANSWERED)

        await quotes(recorder, catalogue, registry).quotes([CALL, InstrumentId("NSE:NOPE")])

        assert recorder.body == {"NSE_FNO": [int(SECURITY_ID)]}

    async def test_nothing_is_sent_for_an_empty_request(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        recorder = Recorder(ANSWERED)

        assert await quotes(recorder, catalogue, registry).quotes([]) == {}
        assert recorder.requests == []

    async def test_a_refusal_is_raised_with_the_status(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        recorder = Recorder({"error": "bad token"}, status=401)

        with pytest.raises(DhanDataError, match="401"):
            await quotes(recorder, catalogue, registry).quotes([CALL])


class TestTodaysBar:
    async def test_the_days_bar_comes_from_the_same_call(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """Dhan carries the day's range inside the quote, so there is no
        second endpoint to spend a rate-gate slot on."""
        recorder = Recorder(ANSWERED)

        bars = await quotes(recorder, catalogue, registry).ohlc([CALL])

        assert len(recorder.requests) == 1
        assert bars[CALL].open.amount == Decimal("99.0")
        assert bars[CALL].high.amount == Decimal("103.0")

    async def test_the_bar_closes_at_the_last_price_not_the_close_field(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """In a quote, `close` is the *previous* day's close. Reading it as
        today's would make every bar close where yesterday did."""
        bars = await quotes(Recorder(ANSWERED), catalogue, registry).ohlc([CALL])

        assert bars[CALL].close.amount == Decimal("101.5")

    async def test_a_quote_with_no_nested_ohlc_yields_no_bar(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        payload = {"data": {"NSE_FNO": {SECURITY_ID: {"last_price": 101.5}}}}

        assert await quotes(Recorder(payload), catalogue, registry).ohlc([CALL]) == {}


DAILY = {
    "timestamp": [1788000000, 1788086400],
    "open": [99.0, 101.0],
    "high": [103.0, 105.0],
    "low": [97.0, 100.0],
    "close": [101.0, 104.0],
    "volume": [5000, 6000],
}


class TestHistory:
    async def test_daily_goes_to_the_historical_endpoint_with_plain_dates(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        recorder = Recorder(DAILY)

        await history(recorder, catalogue, registry).fetch(
            CALL, BarInterval.ONE_DAY, T0 - timedelta(days=5), T0
        )

        assert recorder.requests[-1].url.path.endswith("/charts/historical")
        assert recorder.body["fromDate"] == "2026-08-26"
        assert "interval" not in recorder.body

    async def test_intraday_goes_to_the_other_endpoint_with_datetimes(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """Two endpoints, two date formats. Posting a plain date to the
        intraday one is refused."""
        recorder = Recorder(DAILY)

        await history(recorder, catalogue, registry).fetch(
            CALL, BarInterval.FIVE_MINUTES, T0 - timedelta(hours=2), T0
        )

        assert recorder.requests[-1].url.path.endswith("/charts/intraday")
        assert recorder.body["interval"] == "5"
        assert recorder.body["fromDate"] == "2026-08-31 12:50:00"

    async def test_the_request_carries_the_derived_instrument_kind(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        recorder = Recorder(DAILY)

        await history(recorder, catalogue, registry).fetch(
            CALL, BarInterval.ONE_DAY, T0 - timedelta(days=5), T0
        )

        assert recorder.body["instrument"] == "OPTIDX"
        assert recorder.body["exchangeSegment"] == "NSE_FNO"
        assert recorder.body["securityId"] == SECURITY_ID

    async def test_columnar_candles_become_bars_oldest_first(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        bars = await history(Recorder(DAILY), catalogue, registry).fetch(
            CALL, BarInterval.ONE_DAY, T0 - timedelta(days=5), T0
        )

        assert len(bars) == 2
        assert bars[0].start < bars[1].start
        assert bars[1].close.amount == Decimal("104.0")

    async def test_an_instrument_dhan_does_not_list_answers_nothing(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """The ordinary state for a strike listed after this morning's master
        was written -- the same answer as no history, not an error."""
        recorder = Recorder(DAILY)

        bars = await history(recorder, catalogue, registry).fetch(
            InstrumentId("NSE:NOPE"), BarInterval.ONE_DAY, T0 - timedelta(days=5), T0
        )

        assert bars == ()
        assert recorder.requests == []

    async def test_an_inverted_range_asks_for_nothing(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        recorder = Recorder(DAILY)

        bars = await history(recorder, catalogue, registry).fetch(
            CALL, BarInterval.ONE_DAY, T0, T0 - timedelta(days=5)
        )

        assert bars == ()
        assert recorder.requests == []


class TestTheRateGates:
    async def test_history_does_not_spend_the_quote_budget(
        self, catalogue: DhanCatalogue, registry: InstrumentRegistry
    ) -> None:
        """Dhan meters them separately. Sharing one gate would let a history
        sweep delay the quote that sizes an order."""
        clock = ReplayClock(T0)
        quote_gate = RateGate(timedelta(seconds=10), clock)
        history_gate = RateGate(timedelta(seconds=10), clock)
        recorder = Recorder(DAILY)
        rest = DhanRest(
            "t",
            "c",
            httpx.AsyncClient(transport=httpx.MockTransport(recorder)),
            clock,
            quote_gate=quote_gate,
            history_gate=history_gate,
        )
        source = DhanHistory(rest, lambda: catalogue, lambda: registry)

        await source.fetch(CALL, BarInterval.ONE_DAY, T0 - timedelta(days=5), T0)

        assert quote_gate.is_open is True
        assert history_gate.is_open is False
