"""Exchanges.

**The venue is data, not code.** Currency, timezone, calendar, settlement and
the segments traded are attributes of an :class:`Exchange`. There is no
``if exchange == "NSE"`` anywhere in the core, which is what lets NSE, MCX and
a US venue coexist without special-casing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime
from zoneinfo import ZoneInfo

from garuda.domain.calendar import TradingCalendar
from garuda.domain.enums import Segment, SettlementCycle
from garuda.domain.errors import DomainError
from garuda.domain.money import Currency


@dataclass(frozen=True)
class Exchange:
    """One trading venue."""

    code: str
    name: str
    currency: Currency
    calendar: TradingCalendar
    settlement: SettlementCycle
    segments: frozenset[Segment] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        if not self.code or self.code != self.code.strip().upper():
            raise DomainError(f"exchange code {self.code!r} must be upper-case and unpadded")
        if not self.segments:
            raise DomainError(f"{self.code} trades no segments")

    @property
    def timezone(self) -> ZoneInfo:
        """The venue's local timezone, owned by its calendar."""
        return self.calendar.timezone

    def trades(self, segment: Segment) -> bool:
        return segment in self.segments

    def trading_day_for(self, instant: datetime) -> date:
        return self.calendar.trading_day_for(instant)

    def is_open(self, instant: datetime) -> bool:
        return self.calendar.is_open(instant)

    def settlement_day(self, trade_day: date) -> date:
        """The day a trade on ``trade_day`` settles, counted in trading days."""
        day = trade_day
        for _ in range(self.settlement.days):
            day = self.calendar.next_trading_day(day)
        return day

    def __str__(self) -> str:
        return self.code
