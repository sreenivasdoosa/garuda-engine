"""Every strategy evaluation, one row each: the reference's
`STRATEGY_EVALUATION_LOG`.

What the operator reads when asking why a tranche did or did not go on:
the event that woke it, how many signals it made, how long it took, and the
outcome in words -- the stand-down reason, the lots, the notes the pipeline
kept on the way.
"""

from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.persistence.models import StrategyEvaluationLogRow


class EvaluationLogStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def record(
        self,
        *,
        trading_client: TradingClientId,
        strategy: str,
        event: str,
        at: dt.datetime,
        signals: int,
        took_ms: int,
        summary: dict[str, Any],
        event_data: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        async with self._sessions() as session:
            session.add(
                StrategyEvaluationLogRow(
                    trading_client_id=trading_client.value,
                    strategy_name=strategy,
                    event_type=event[:16],
                    event_data=event_data,
                    signals_generated=signals,
                    execution_time_ms=took_ms,
                    result_summary=summary,
                    error_message=error,
                    evaluated_at=at,
                )
            )
            await session.commit()
