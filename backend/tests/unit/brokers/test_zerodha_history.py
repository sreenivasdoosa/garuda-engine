"""Asking Kite for candles.

The claim worth pinning is the range: Kite's `from` and `to` carry no offset
and are read as exchange local time, so what matters is which zone the request
was formatted in -- not which zone the caller happened to be in.
"""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from garuda.brokers.zerodha.history import ZerodhaHistory
from garuda.domain.enums import (
    ExerciseStyle,
    InstrumentKind,
    Segment,
    SettlementType,
)
from garuda.domain.exchange import Exchange
from garuda.domain.instrument import Instrument, InstrumentId
from garuda.domain.market import BarInterval
from garuda.marketdata.registry import InstrumentRegistry

IST = ZoneInfo("Asia/Kolkata")
NIFTY = InstrumentId("NSE:NIFTY_50")


class RecordingClient:
    """Answers no candles, and remembers what it was asked for."""

    def __init__(self) -> None:
        self.asked: list[dict[str, Any]] = []

    async def get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        self.asked.append(dict(params or {}))
        return {"candles": []}


def registry_with(nse: Exchange) -> InstrumentRegistry:
    spot = Instrument(
        id=NIFTY,
        exchange=nse,
        segment=Segment.EQUITY,
        kind=InstrumentKind.INDEX,
        trading_symbol="NIFTY 50",
        lot_size=1,
        tick_size=Decimal("0.05"),
        exercise_style=ExerciseStyle.EUROPEAN,
        settlement_type=SettlementType.CASH,
    )
    return InstrumentRegistry.build([spot], {NIFTY: "256265"})


class TestTheRangeAsked:
    @pytest.mark.asyncio
    async def test_a_utc_instant_is_asked_for_in_indian_time(self, nse: Exchange) -> None:
        """The failure this prevents is quiet: Kite reads the string as
        exchange local time, so a UTC instant asks for a window five and a
        half hours early. Today's tail comes back missing and the provider
        looks like it stopped publishing."""
        client = RecordingClient()
        history = ZerodhaHistory(client, lambda: registry_with(nse))  # type: ignore[arg-type]

        await history.fetch(
            NIFTY,
            BarInterval.ONE_MINUTE,
            datetime(2026, 9, 2, 3, 45, tzinfo=UTC),  # 09:15 IST
            datetime(2026, 9, 2, 12, 7, tzinfo=UTC),  # 17:37 IST
        )

        [asked] = client.asked
        assert asked["from"] == "2026-09-02 09:15:00"
        assert asked["to"] == "2026-09-02 17:37:00"

    @pytest.mark.asyncio
    async def test_an_instant_already_in_indian_time_is_unchanged(self, nse: Exchange) -> None:
        client = RecordingClient()
        history = ZerodhaHistory(client, lambda: registry_with(nse))  # type: ignore[arg-type]

        await history.fetch(
            NIFTY,
            BarInterval.ONE_MINUTE,
            datetime(2026, 9, 2, 9, 15, tzinfo=IST),
            datetime(2026, 9, 2, 17, 37, tzinfo=IST),
        )

        [asked] = client.asked
        assert asked["from"] == "2026-09-02 09:15:00"
        assert asked["to"] == "2026-09-02 17:37:00"

    @pytest.mark.asyncio
    async def test_an_instrument_the_master_does_not_know_asks_nothing(self, nse: Exchange) -> None:
        client = RecordingClient()
        history = ZerodhaHistory(client, lambda: registry_with(nse))  # type: ignore[arg-type]

        bars = await history.fetch(
            InstrumentId("NSE:MISSING"),
            BarInterval.ONE_MINUTE,
            datetime(2026, 9, 2, 3, 45, tzinfo=UTC),
            datetime(2026, 9, 2, 12, 7, tzinfo=UTC),
        )

        assert bars == ()
        assert client.asked == []
