"""What a tick means for the positions already open.

Entry asks what a price means for a signal. This asks what it means for
everything already in the book, and the two are separate passes because they
answer to different things: entry stops mattering once a signal has fired, and
this starts mattering exactly then.

Three things happen here, in this order:

**The high and low since entry are recorded.** Not a decision, a fact, and
every trade in the instrument needs it whether or not it trails -- trailing
measures from it, and a restart that forgot it would trail from the price at
restart, giving back everything the position had earned.

**Stops trail.** One trade at a time, because a trailing stop is about that
trade's own entry and its own extremes.

**Groups are checked against their combined levels.** One group at a time,
because the whole point of a combined level is that no single leg can answer
it. A group is only ever evaluated when one of its own instruments ticks; the
prices of the other legs come from the quote cache, which is the same place a
combined level would read them from on any other tick.

**A group exits whole.** Every leg gets a square-off request with the same
reason, and the ordering between them -- primary before hedge -- belongs to
the coordinator, not here.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field

from garuda.alerts.manager import AlertManager
from garuda.domain.alert import EntityType
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.trade import Trade
from garuda.domain.trade_state import TradeExitReason
from garuda.trademgmt.client import TradingClientManager
from garuda.trademgmt.combined_rules import (
    CombinedDecision,
    CombinedOutcome,
    combinable,
    evaluate,
    levels_of,
)
from garuda.trademgmt.squareoff import SquareOffService
from garuda.trademgmt.trailing import TrailingService

logger = logging.getLogger(__name__)

type QuoteLookup = Callable[[InstrumentId], Tick | None]


@dataclass(frozen=True, slots=True)
class GroupKey:
    """What makes a set of legs one position for combined purposes."""

    strategy: str
    group: str


@dataclass
class WatchReport:
    """What one tick did. Returned for tests and for the operator's counters."""

    #: Positions this tick was handed to. Live ones only: the book keeps every
    #: trade of the day, and a tick is the hot path -- walking the closed ones
    #: makes each tick cost what the whole day has traded.
    watched: int = 0
    trailed: int = 0
    groups_checked: int = 0
    groups_exited: int = 0
    unavailable: list[str] = field(default_factory=list)


class PositionWatch:
    """Hands each tick to the positions it bears on."""

    def __init__(
        self,
        book: TradingClientManager,
        trailing: TrailingService,
        square_off: SquareOffService,
        quotes: QuoteLookup,
        alerts: AlertManager,
    ) -> None:
        self._book = book
        self._trailing = trailing
        self._square_off = square_off
        self._quotes = quotes
        self._alerts = alerts
        #: Groups already told to come out, so a decision that stays true for
        #: several ticks does not queue the same square-off over and over. The
        #: queue itself is idempotent per trade; this keeps the log readable
        #: and the arithmetic off the hot path once it has answered.
        self._exited: set[GroupKey] = set()

    async def on_tick(self, tick: Tick) -> WatchReport:
        report = WatchReport()
        holdings = [trade for trade in self._book.trades_in(tick.instrument) if trade.is_live]
        report.watched = len(holdings)
        if not holdings:
            return report

        for trade in holdings:
            result = await self._trailing.on_tick(trade, tick)
            if result.moved:
                report.trailed += 1

        for key in _groups_of(holdings):
            await self._check_group(key, report)
        return report

    async def _check_group(self, key: GroupKey, report: WatchReport) -> None:
        if key in self._exited:
            return

        legs = [
            trade for trade in self._book.trades_for(key.strategy, key.group) if combinable(trade)
        ]
        if not legs:
            return

        report.groups_checked += 1
        levels = levels_of(legs)
        if levels is None:
            report.unavailable.append(
                f"{key.strategy}/{key.group}: its legs carry different combined levels"
            )
            logger.error(
                "%s: %s/%s has legs configured with different combined levels; "
                "the group has no level until they agree",
                self._book.label,
                key.strategy,
                key.group,
            )
            return

        decision = evaluate(
            legs,
            levels,
            entry_of=lambda trade: trade.entry,
            current_of=self._last_price,
        )

        if decision.outcome is CombinedOutcome.UNAVAILABLE:
            # Named rather than swallowed. A group whose level cannot be
            # computed is unprotected, and reading it as "held" would make
            # that indistinguishable from a position that is simply fine.
            report.unavailable.append(f"{key.strategy}/{key.group}: {decision.detail}")
            logger.warning(
                "%s: %s/%s has a combined level that cannot be evaluated: %s",
                self._book.label,
                key.strategy,
                key.group,
                decision.detail,
            )
            return

        reason = decision.exit_reason
        if reason is None:
            return

        await self._exit_group(key, legs, decision, reason, report)

    async def _exit_group(
        self,
        key: GroupKey,
        legs: list[Trade],
        decision: CombinedDecision,
        reason: TradeExitReason,
        report: WatchReport,
    ) -> None:
        self._exited.add(key)
        report.groups_exited += 1
        logger.info(
            "%s: %s/%s comes out on its combined level: %s",
            self._book.label,
            key.strategy,
            key.group,
            decision.detail,
        )
        await self._alerts.warning(
            EntityType.TRADE,
            self._book.label,
            f"{key.strategy}/{key.group}",
            f"the group is coming out on its combined level -- {decision.detail}",
            key=f"combined-level:{self._book.trading_client}:{key.strategy}:{key.group}",
        )
        for leg in legs:
            await self._square_off.request(leg, reason)

    def _last_price(self, trade: Trade) -> Money | None:
        quote = self._quotes(trade.instrument)
        return quote.last_price if quote is not None else None


def _groups_of(trades: list[Trade]) -> list[GroupKey]:
    """The groups these trades belong to, without repeats.

    Ordered rather than a set, so two groups reaching a level on the same tick
    come out in a stable order and a log reads the same way twice.
    """
    seen: list[GroupKey] = []
    for trade in trades:
        key = GroupKey(trade.strategy, trade.group)
        if key not in seen:
            seen.append(key)
    return seen
