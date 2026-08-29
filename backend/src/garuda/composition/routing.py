"""Delivering signals to the account they were built for.

A batch comes out of the signal factory addressed to one trading client. This
finds that client's book and hands the signals over, one at a time, and says
what happened to each.

The rule that matters here is **all or nothing on the legs of a combo**. The
factory already refuses to build a partial combo; this refuses to deliver one.
A hedge accepted while its main leg was rejected as a duplicate leaves an
account holding a hedge against a position it does not have, which is the
orphan the square-off sweep exists to clean up -- better not to create it.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from garuda.alerts.manager import AlertManager
from garuda.composition.engine import ClientParts, Engine
from garuda.domain.alert import EntityType
from garuda.domain.client import TradingClientId
from garuda.domain.trade_signal import TradeSignal
from garuda.engine.signals import SignalBatch
from garuda.trademgmt.client import SignalRejected, TradingClientManager

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Delivery:
    """What became of one batch."""

    accepted: tuple[TradeSignal, ...] = ()
    #: Signals the book refused, with the duplicate each collided with.
    rejected: tuple[tuple[TradeSignal, SignalRejected], ...] = ()
    #: Why nothing was delivered at all -- an unknown account, or a batch the
    #: factory had already refused.
    refusal: str | None = None

    @property
    def delivered(self) -> bool:
        return bool(self.accepted) and self.refusal is None


async def deliver(engine: Engine, batch: SignalBatch) -> Delivery:
    """Hand a batch to the account it names.

    Nothing here decides whether a signal is a good idea; that was the
    factory's business and is about to be the entry service's. This only puts
    it where the entry service will find it.
    """
    if batch.refusal is not None:
        return Delivery(refusal=batch.refusal)
    if not batch.signals:
        return Delivery()

    owner = batch.signals[0].trading_client
    client = engine.parts.clients.get(owner)
    if client is None:
        return Delivery(refusal=await _cannot_reach(engine, owner))

    return await _hand_over(client.book, batch, engine.parts.alerts)


async def _hand_over(
    book: TradingClientManager, batch: SignalBatch, alerts: AlertManager
) -> Delivery:
    accepted: list[TradeSignal] = []
    rejected: list[tuple[TradeSignal, SignalRejected]] = []

    for signal in batch.signals:
        rejection = await book.add_signal(signal)
        if rejection is None:
            accepted.append(signal)
        else:
            rejected.append((signal, rejection))

    if rejected and accepted and _is_combo(batch):
        # A partial combo is a position nobody designed. The legs already
        # taken are withdrawn rather than left standing.
        await _withdraw(book, accepted, alerts)
        return Delivery(
            rejected=tuple(rejected),
            refusal=(
                f"{len(rejected)} of {len(batch.signals)} legs were already held, so the "
                "whole entry was withdrawn rather than leaving a partial combo"
            ),
        )

    return Delivery(accepted=tuple(accepted), rejected=tuple(rejected))


async def _withdraw(
    book: TradingClientManager, signals: list[TradeSignal], alerts: AlertManager
) -> None:
    for signal in signals:
        await book.disable_signal(signal.id, "a leg of this combo was already held")
    await alerts.warning(
        EntityType.STRATEGY,
        signals[0].strategy,
        "signal-delivery",
        f"{book.label}: part of a combo was already held, so the whole entry was "
        f"withdrawn. {len(signals)} leg(s) taken back.",
        key=f"partial-combo:{book.trading_client.value}:{signals[0].strategy}",
    )


async def _cannot_reach(engine: Engine, owner: TradingClientId) -> str:
    """An account the engine did not build, named by whatever it is known as."""
    account = engine.parts.accounts.get(owner)
    name = account.label if account else owner.value
    why = engine.parts.unavailable.get(owner, "it is not configured on this engine")
    reason = f"{name} cannot take signals: {why}"

    await engine.parts.alerts.warning(
        EntityType.SYSTEM,
        name,
        "signal-delivery",
        f"a strategy produced signals for {name}, which is not trading — {why}. "
        "They were discarded.",
        key=f"signal-undeliverable:{owner.value}",
    )
    logger.warning("%s", reason)
    return reason


def _is_combo(batch: SignalBatch) -> bool:
    return batch.leg_count > 1


def signals_for(client: ClientParts) -> tuple[TradeSignal, ...]:
    """What an account is currently waiting on. For the console and the log."""
    return tuple(client.book.signals())
