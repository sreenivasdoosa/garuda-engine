"""What the Terminal shows: each account, as the engine believes it stands.

The Terminal is the first place an operator can see what the engine did
rather than read the log, and the rule here is that it shows **the engine's
own book**. Counts, P&L and positions come from the trades the engine holds
and the last tick it saw; nothing here asks the broker, because the broker's
view is a different thing -- the reference engine shows both and marks where
they disagree, and the broker's half is fetched on demand through
:meth:`TerminalView.broker_positions`, never on the broadcast.

Unrealised P&L needs a price. A position whose instrument has not ticked is
reported as **unpriced** rather than as zero: a zero is a number a total
will happily absorb, and the operator would read a flat account where there
is an open position nobody can value yet.

Every account the engine knows appears, trading or not. One that cannot
trade -- no session, disabled, its broker stopped -- shows with its reason,
which is a better row than a missing one.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal

from garuda.brokers.sessions import Account
from garuda.composition.engine import ClientParts, Engine
from garuda.domain.client import TradingClientId
from garuda.domain.enums import ProductType
from garuda.domain.instrument import InstrumentId
from garuda.domain.money import Currency, Money
from garuda.domain.trade import Trade, TradeId
from garuda.domain.trade_state import TradeExitReason, TradeState
from garuda.protocols.broker import BrokerPosition, Funds
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: The currency a total is reported in when there is nothing to total. Every
#: venue the engine trades today settles in rupees; a multi-currency account
#: is a design question for the venue model, not for a summary.
_REPORTING = Currency.INR


@dataclass(frozen=True, slots=True)
class Counts:
    open: int = 0
    active: int = 0
    completed: int = 0
    cancelled: int = 0
    #: Trades the engine gave up on: an entry it could not confirm, or an
    #: exit it stopped trying. The reference calls these track-lost.
    failed: int = 0


@dataclass(frozen=True, slots=True)
class Pnl:
    realised: Money
    unrealised: Money
    #: Active positions whose instrument has not ticked, and so are not in
    #: ``unrealised``. Non-zero means the total is not the whole story.
    unpriced: int = 0

    @property
    def total(self) -> Money:
        return self.realised + self.unrealised


@dataclass(frozen=True, slots=True)
class PositionRow:
    """One instrument's net standing on one account, from the engine's trades."""

    instrument: InstrumentId
    product: ProductType
    is_paper: bool
    buy_quantity: int
    sell_quantity: int
    net_quantity: int
    buy_average: Money | None
    sell_average: Money | None
    last_price: Money | None
    realised: Money
    unrealised: Money | None
    trade_ids: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AccountSummary:
    """One row of the Terminal."""

    trading_client_id: TradingClientId
    display_name: str
    broker: str
    client_id: str
    #: Whether the engine has this account's parts built. False comes with
    #: ``unavailable_because``.
    is_trading: bool
    unavailable_because: str | None
    counts: Counts
    paper_counts: Counts
    pnl: Pnl
    paper_pnl: Pnl
    positions: int
    paper_positions: int
    as_of: datetime


@dataclass(frozen=True, slots=True)
class SquareOffReport:
    """What a square-off request did, trade by trade."""

    requested: tuple[str, ...] = ()
    #: Trade id -> why it was not requested.
    skipped: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class AccountTrades:
    open: Sequence[Trade]
    active: Sequence[Trade]
    completed: Sequence[Trade]
    cancelled: Sequence[Trade]
    failed: Sequence[Trade]


class UnknownAccountError(LookupError):
    """The id names no trading client the engine knows."""


class AccountNotTradingError(RuntimeError):
    """The account exists but has no parts built; the message says why."""


class TerminalView:
    """Reads the engine's book for the Terminal, and carries its actions."""

    def __init__(self, engine: Engine, clock: Clock) -> None:
        self._engine = engine
        self._clock = clock

    # -- reading ------------------------------------------------------------

    def summaries(self) -> list[AccountSummary]:
        parts = self._engine.parts
        now = self._clock.now()
        rows = [self._summary(account, now) for account in parts.accounts.values()]
        return sorted(rows, key=lambda row: row.display_name.lower())

    def summary(self, trading_client_id: TradingClientId) -> AccountSummary:
        return self._summary(self._account(trading_client_id), self._clock.now())

    def trades(self, trading_client_id: TradingClientId) -> AccountTrades:
        client = self._client(trading_client_id)
        by_state: dict[str, list[Trade]] = {
            "open": [],
            "active": [],
            "completed": [],
            "cancelled": [],
            "failed": [],
        }
        for trade in client.book.trades():
            by_state[_bucket(trade)].append(trade)
        return AccountTrades(
            **{name: sorted(group, key=_started) for name, group in by_state.items()}
        )

    def positions(self, trading_client_id: TradingClientId) -> list[PositionRow]:
        """Net positions from the engine's trades, one row per instrument and product.

        Both legs of a trade are counted -- the entry as one side and the
        exit, when there is one, as the other -- so a position closed today
        shows flat with its realised result, which is what a positions tab
        is for.
        """
        client = self._client(trading_client_id)
        hub = self._engine.parts.hub
        grouped: dict[tuple[InstrumentId, ProductType, bool], list[Trade]] = {}
        for trade in client.book.trades():
            if trade.filled_quantity == 0:
                continue
            key = (trade.instrument, trade.product, trade.is_paper)
            grouped.setdefault(key, []).append(trade)

        rows: list[PositionRow] = []
        for (instrument, product, is_paper), trades in sorted(
            grouped.items(), key=lambda item: (item[0][0].value, item[0][1].value, item[0][2])
        ):
            buys: list[tuple[int, Money]] = []
            sells: list[tuple[int, Money]] = []
            realised = Money(Decimal(0), _REPORTING)
            unrealised: Money | None = Money(Decimal(0), _REPORTING)
            net = 0
            for trade in trades:
                assert trade.entry is not None
                opening = buys if trade.direction.value == "LONG" else sells
                opening.append((trade.filled_quantity, trade.entry))
                if trade.exit is not None:
                    closing = sells if trade.direction.value == "LONG" else buys
                    closing.append((trade.filled_quantity, trade.exit))
                    pnl = trade.realised_pnl
                    if pnl is not None:
                        realised = realised + pnl
                    continue
                if trade.state is TradeState.ACTIVE:
                    net += trade.open_quantity * trade.direction.sign
                    tick = hub.latest(trade.instrument)
                    marked = trade.pnl_at(tick.last_price) if tick is not None else None
                    if marked is None or unrealised is None:
                        unrealised = None
                    else:
                        unrealised = unrealised + marked
            tick = hub.latest(instrument)
            rows.append(
                PositionRow(
                    instrument=instrument,
                    product=product,
                    is_paper=is_paper,
                    buy_quantity=sum(q for q, _ in buys),
                    sell_quantity=sum(q for q, _ in sells),
                    net_quantity=net,
                    buy_average=_average(buys),
                    sell_average=_average(sells),
                    last_price=tick.last_price if tick is not None else None,
                    realised=realised,
                    unrealised=unrealised,
                    trade_ids=tuple(trade.id.value for trade in trades),
                )
            )
        return rows

    async def broker_positions(
        self, trading_client_id: TradingClientId
    ) -> Sequence[BrokerPosition]:
        """The broker's own view, fetched now. Never on the broadcast."""
        return await self._client(trading_client_id).broker.fetch_positions()

    async def margins(self, trading_client_id: TradingClientId) -> Funds:
        return await self._client(trading_client_id).broker.fetch_funds()

    # -- acting -------------------------------------------------------------

    async def square_off(
        self,
        trading_client_id: TradingClientId,
        *,
        product: str = "ALL",
        strategies: Sequence[str] | None = None,
        trade_id: str | None = None,
    ) -> SquareOffReport:
        """Ask the account's square-off service to exit, by operator.

        Scoped by product -- ``ALL``, ``INTRADAY`` (MIS) or ``POSITIONAL``
        (everything else) -- and optionally by strategy, or to one trade.
        Each request goes through the same service the day model uses at the
        close, so an operator's square-off is placed, retried and alerted
        exactly as a scheduled one is.
        """
        client = self._client(trading_client_id)
        wanted_strategies = {s for s in (strategies or ()) if s}
        requested: list[str] = []
        skipped: dict[str, str] = {}
        for trade in client.book.trades():
            if trade_id is not None and trade.id.value != trade_id:
                continue
            if trade.is_terminal:
                if trade_id is not None:
                    skipped[trade.id.value] = "already finished"
                continue
            if not _in_product(trade, product):
                continue
            if wanted_strategies and trade.strategy not in wanted_strategies:
                continue
            queued = await client.square_off.request(
                trade, TradeExitReason.MANUAL_SQUARE_OFF, by_operator=True
            )
            if queued:
                requested.append(trade.id.value)
            else:
                skipped[trade.id.value] = "could not be queued; see the alerts"
        if trade_id is not None and trade_id not in requested and trade_id not in skipped:
            skipped[trade_id] = "no such trade on this account"
        logger.info(
            "%s: operator square-off (%s): %d requested, %d skipped",
            client.account.label,
            product,
            len(requested),
            len(skipped),
        )
        return SquareOffReport(requested=tuple(requested), skipped=skipped)

    # -- the pieces ---------------------------------------------------------

    def _account(self, trading_client_id: TradingClientId) -> Account:
        account = self._engine.parts.accounts.get(trading_client_id)
        if account is None:
            raise UnknownAccountError(
                f"{trading_client_id} is not a trading client the engine knows"
            )
        return account

    def _client(self, trading_client_id: TradingClientId) -> ClientParts:
        account = self._account(trading_client_id)
        client = self._engine.parts.clients.get(trading_client_id)
        if client is None:
            why = self._engine.parts.unavailable.get(trading_client_id, "it is not trading")
            raise AccountNotTradingError(f"{account.label}: {why}")
        return client

    def _summary(self, account: Account, now: datetime) -> AccountSummary:
        client = self._engine.parts.clients.get(account.id)
        if client is None:
            empty = Pnl(Money(Decimal(0), _REPORTING), Money(Decimal(0), _REPORTING))
            return AccountSummary(
                trading_client_id=account.id,
                display_name=account.display_name or account.id.value,
                broker=account.broker.lower(),
                client_id=account.client_id,
                is_trading=False,
                unavailable_because=self._engine.parts.unavailable.get(account.id, "not trading"),
                counts=Counts(),
                paper_counts=Counts(),
                pnl=empty,
                paper_pnl=empty,
                positions=0,
                paper_positions=0,
                as_of=now,
            )
        live = [t for t in client.book.trades() if not t.is_paper]
        paper = [t for t in client.book.trades() if t.is_paper]
        return AccountSummary(
            trading_client_id=account.id,
            display_name=account.display_name or account.id.value,
            broker=account.broker.lower(),
            client_id=account.client_id,
            is_trading=True,
            unavailable_because=None,
            counts=_counts(live),
            paper_counts=_counts(paper),
            pnl=self._pnl(live),
            paper_pnl=self._pnl(paper),
            positions=len(
                {(t.instrument, t.product) for t in live if t.state is TradeState.ACTIVE}
            ),
            paper_positions=len(
                {(t.instrument, t.product) for t in paper if t.state is TradeState.ACTIVE}
            ),
            as_of=now,
        )

    def _pnl(self, trades: Sequence[Trade]) -> Pnl:
        hub = self._engine.parts.hub
        realised = Money(Decimal(0), _REPORTING)
        unrealised = Money(Decimal(0), _REPORTING)
        unpriced = 0
        for trade in trades:
            if trade.state is TradeState.COMPLETED:
                closed = trade.realised_pnl
                if closed is not None:
                    realised = realised + closed
            elif trade.state is TradeState.ACTIVE:
                tick = hub.latest(trade.instrument)
                marked = trade.pnl_at(tick.last_price) if tick is not None else None
                if marked is None:
                    unpriced += 1
                else:
                    unrealised = unrealised + marked
        return Pnl(realised=realised, unrealised=unrealised, unpriced=unpriced)


def _bucket(trade: Trade) -> str:
    if trade.failure_reason:
        return "failed"
    if trade.state is TradeState.OPEN:
        return "open"
    if trade.state is TradeState.ACTIVE:
        return "active"
    if trade.state is TradeState.COMPLETED:
        return "completed"
    return "cancelled"


def _counts(trades: Sequence[Trade]) -> Counts:
    buckets = {"open": 0, "active": 0, "completed": 0, "cancelled": 0, "failed": 0}
    for trade in trades:
        buckets[_bucket(trade)] += 1
    return Counts(**buckets)


def _in_product(trade: Trade, product: str) -> bool:
    chosen = product.strip().upper()
    if chosen == "ALL":
        return True
    is_intraday = trade.product is ProductType.MIS
    if chosen == "INTRADAY":
        return is_intraday
    if chosen == "POSITIONAL":
        return not is_intraday
    raise ValueError(f"{product!r} is not a square-off scope; one of ALL, INTRADAY, POSITIONAL")


def _average(fills: Sequence[tuple[int, Money]]) -> Money | None:
    quantity = sum(q for q, _ in fills)
    if quantity == 0:
        return None
    currency = fills[0][1].currency
    total = sum((price.amount * q for q, price in fills), Decimal(0))
    return Money(total / Decimal(quantity), currency)


def _started(trade: Trade) -> tuple[int, str]:
    return (int(trade.started_at.timestamp()) if trade.started_at else 0, trade.id.value)


__all__ = [
    "AccountNotTradingError",
    "AccountSummary",
    "AccountTrades",
    "Counts",
    "Pnl",
    "PositionRow",
    "SquareOffReport",
    "TerminalView",
    "TradeId",
    "UnknownAccountError",
]
