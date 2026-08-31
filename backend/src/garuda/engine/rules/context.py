"""Everything a rule may look at.

Getting this surface right matters more than any individual rule: every rule
written later is limited by it, and widening it afterwards means revisiting
each one.

Three properties it must have, and the concrete implementation owes all three:

* **Lazy.** A rule that never runs because an earlier one failed costs
  nothing. Candles are not fetched until asked for.
* **Cached for the length of one evaluation.** Two rules asking for the same
  indicator compute it once. Without that, a ten-rule tree is ten redundant
  computations every time it runs.
* **Consistent within one evaluation.** Every rule in a pass sees the same
  ``now`` and the same prices. A tree where the first rule saw 100 and the
  fifth saw 101 can contradict itself.

Nothing here raises when data is missing. It answers ``None``, and the rule
turns that into ``UNAVAILABLE`` with a sentence naming what was absent.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime
from decimal import Decimal
from typing import Protocol, runtime_checkable
from zoneinfo import ZoneInfo

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval, Tick
from garuda.domain.trade import Trade
from garuda.engine.config import ResolvedConfig


@runtime_checkable
class RuleContext(Protocol):
    """One evaluation's view of the world."""

    @property
    def now(self) -> datetime:
        """The instant this evaluation is for. Never the wall clock."""
        ...

    @property
    def trading_day(self) -> date: ...

    @property
    def timezone(self) -> ZoneInfo:
        """The venue's own clock.

        A rule configured for 13:00 means the venue's one o'clock, not the
        server's. A strategy runs on one venue, so there is one answer.
        """
        ...

    @property
    def strategy(self) -> str: ...

    @property
    def trading_client(self) -> TradingClientId: ...

    @property
    def tranche(self) -> int: ...

    @property
    def config(self) -> ResolvedConfig: ...

    @property
    def underlying(self) -> InstrumentId:
        """What the strategy is about. The default subject of a rule that does
        not name an instrument of its own."""
        ...

    @property
    def trade(self) -> Trade | None:
        """The position being judged. Set for exit rules, None for entry."""
        ...

    def quote(self, instrument: InstrumentId) -> Tick | None:
        """The latest tick. The *present*, as opposed to closed history."""
        ...

    def candles(self, instrument: InstrumentId, interval: BarInterval, count: int) -> Sequence[Bar]:
        """The last ``count`` **closed** bars, oldest first.

        Never the bar still forming. The day's first bar is a fact; the current
        one is a guess that will change, and a rule reading it as history is
        the repainting bug.

        Short history is not an error: fewer bars than asked for are returned,
        and a rule that needs them all says so.
        """
        ...

    def indicator(
        self,
        name: str,
        instrument: InstrumentId,
        interval: BarInterval,
        **params: object,
    ) -> Decimal | None:
        """An indicator value, computed from closed bars only."""
        ...

    def positions(self) -> Sequence[Trade]:
        """What this strategy holds on this account right now."""
        ...
