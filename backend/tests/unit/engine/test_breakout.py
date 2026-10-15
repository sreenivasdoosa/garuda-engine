"""Breakout watches: levels, breaches, and the pipeline arming and entering."""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

import pytest

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.engine.breakout import BreakoutSettings, Watch
from garuda.engine.config import ResolvedConfig
from garuda.engine.vocabulary import (
    BreakoutDirection,
    BreakoutSide,
    BreakoutTriggerMode,
    BreakoutWatchType,
)

IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
NOW = dt.datetime(2026, 10, 15, 10, 0, tzinfo=IST)


def watch(direction: BreakoutDirection, above: str | None, below: str | None) -> Watch:
    return Watch(
        key="k",
        trading_client=TradingClientId("appa"),
        strategy="s",
        tranche=1,
        kind=BreakoutWatchType.OPTION_SYMBOL,
        watched=InstrumentId("NFO:X"),
        direction=direction,
        mode=BreakoutTriggerMode.PERCENTAGE,
        reference_price=Decimal(100),
        above=Decimal(above) if above else None,
        below=Decimal(below) if below else None,
        valid_till=NOW + dt.timedelta(hours=5),
        group="g",
    )


class TestBreaches:
    def test_below_fires_at_or_under_the_lower_level_only(self) -> None:
        w = watch(BreakoutDirection.BELOW, "120", "80")
        assert w.breached(Decimal(81)) is None
        assert w.breached(Decimal(125)) is None
        assert w.breached(Decimal(80)) is BreakoutSide.SHORT

    def test_above_and_either(self) -> None:
        assert (
            watch(BreakoutDirection.ABOVE, "120", "80").breached(Decimal(120)) is BreakoutSide.LONG
        )
        either = watch(BreakoutDirection.EITHER, "120", "80")
        assert either.breached(Decimal(79)) is BreakoutSide.SHORT
        assert either.breached(Decimal(121)) is BreakoutSide.LONG

    def test_a_fired_or_lapsed_watch_never_fires_again(self) -> None:
        w = watch(BreakoutDirection.BELOW, None, "80").fired(NOW, Decimal(79))
        assert w.breached(Decimal(70)) is None
        lapsing = watch(BreakoutDirection.BELOW, None, "80")
        assert lapsing.due_to_lapse(NOW + dt.timedelta(hours=6))
        assert lapsing.lapsed(NOW).breached(Decimal(70)) is None


class TestSettings:
    def test_the_reference_defaults(self) -> None:
        settings = BreakoutSettings.of(ResolvedConfig("s", {}))
        assert settings.kind is BreakoutWatchType.OPTION_SYMBOL
        assert settings.direction is BreakoutDirection.BELOW
        assert settings.mode is BreakoutTriggerMode.PERCENTAGE
        assert settings.levels(Decimal(100)) == (Decimal(120), Decimal(80))

    def test_absolute_levels(self) -> None:
        settings = BreakoutSettings.of(
            ResolvedConfig("s", {"breakout_trigger_mode": "ABSOLUTE", "breakout_trigger_value": 15})
        )
        assert settings.levels(Decimal(100)) == (Decimal(115), Decimal(85))

    def test_a_range_needs_its_window_and_waits_for_it(self) -> None:
        settings = BreakoutSettings.of(
            ResolvedConfig(
                "s",
                {
                    "breakout_trigger_mode": "RANGE",
                    "breakout_range_start": "09:15",
                    "breakout_range_end": "09:30",
                },
            )
        )
        assert settings.pending_until() == dt.time(9, 30)

    def test_a_range_without_times_is_refused(self) -> None:
        from garuda.domain.errors import DomainError

        with pytest.raises(DomainError):
            BreakoutSettings.of(ResolvedConfig("s", {"breakout_trigger_mode": "RANGE"}))
