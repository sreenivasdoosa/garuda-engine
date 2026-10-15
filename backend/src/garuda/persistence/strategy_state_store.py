"""Strategy state, one row per subscription per trading day.

`subscription_state` is the reference's `USER_STRATEGY_STATE`. Read at the
start of a day (or a restart mid-day) so a tranche that already fired is not
fired again; written at once when a critical field changes and otherwise in
the periodic flush (`STRATEGY_ENGINE.md` §6).
"""

from __future__ import annotations

import datetime as dt
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.engine.strategy_state import StrategyState
from garuda.persistence.models import SubscriptionStateRow

logger = logging.getLogger(__name__)


class StrategyStateStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def load_day(self, trading_day: dt.date) -> list[StrategyState]:
        """Every subscription's state for one day."""
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(SubscriptionStateRow).where(
                        SubscriptionStateRow.trading_date == trading_day
                    )
                )
            ).scalars()
            states: list[StrategyState] = []
            for row in rows:
                try:
                    states.append(_state_of(row))
                except (ValueError, TypeError) as error:
                    # A row that cannot be read must not be silently treated
                    # as "nothing fired": that is what fires a tranche twice.
                    raise ValueError(
                        f"strategy state for {row.strategy_name} on {row.trading_client_id} "
                        f"({trading_day}) is unreadable: {error}"
                    ) from error
            return states

    async def save(self, state: StrategyState, *, now: dt.datetime) -> None:
        async with self._sessions() as session:
            row = (
                await session.execute(
                    select(SubscriptionStateRow).where(
                        SubscriptionStateRow.trading_client_id == state.trading_client.value,
                        SubscriptionStateRow.strategy_name == state.strategy,
                        SubscriptionStateRow.trading_date == state.trading_day,
                    )
                )
            ).scalar_one_or_none()
            if row is None:
                row = SubscriptionStateRow(
                    trading_client_id=state.trading_client.value,
                    strategy_name=state.strategy,
                    trading_date=state.trading_day,
                    created_at=now,
                    version=0,
                )
                session.add(row)
            row.state_data = state.to_json()
            row.last_evaluation_at = state.last_evaluation_at
            row.last_signal_at = state.last_signal_at
            row.evaluation_count = state.evaluation_count
            row.signal_count = state.signal_count
            row.version = (row.version or 0) + 1
            row.updated_at = now
            await session.commit()


def _state_of(row: SubscriptionStateRow) -> StrategyState:
    return StrategyState.from_json(
        TradingClientId(row.trading_client_id),
        row.strategy_name,
        row.trading_date,
        row.state_data or {},
        evaluation_count=row.evaluation_count or 0,
        signal_count=row.signal_count or 0,
        last_evaluation_at=row.last_evaluation_at,
        last_signal_at=row.last_signal_at,
    )
