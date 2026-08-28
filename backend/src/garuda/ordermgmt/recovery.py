"""Rebuilding engine state after a restart.

The journal is written before anything is sent and committed with the state
change it describes, so it holds every order the engine ever intended. Recovery
replays it, rebuilds the book, and resumes the id counter past whatever was
already issued.

What recovery deliberately does **not** do is decide anything. It reconstructs
what the engine believed and hands it over. Whether that matches the broker is
reconciliation's question, and until it is answered trading stays halted.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date

from garuda.domain.instrument import InstrumentId
from garuda.journal.fold import FoldedState, PositionBasis, fold
from garuda.ordermgmt.ids import ClientOrderIdSequence
from garuda.ordermgmt.manager import OrderManager
from garuda.protocols.store import JournalStore


@dataclass(frozen=True)
class RecoveredState:
    """What the engine believed when it stopped."""

    state: FoldedState
    ids: ClientOrderIdSequence

    @property
    def is_halted(self) -> bool:
        return self.state.halted


async def recover(
    store: JournalStore,
    trading_day: date,
    bases: Mapping[InstrumentId, PositionBasis],
    *,
    prefix: str = "gar",
) -> RecoveredState:
    """Replay a day's journal into the state that produced it."""
    events = [event async for event in store.replay(trading_day)]
    state = fold(events, bases)
    ids = ClientOrderIdSequence.resuming_from(trading_day, state.orders.keys(), prefix=prefix)
    return RecoveredState(state=state, ids=ids)


def restore_order_manager(manager: OrderManager, recovered: RecoveredState) -> None:
    """Load a recovered book into a fresh order manager."""
    manager.restore(recovered.state.orders)
