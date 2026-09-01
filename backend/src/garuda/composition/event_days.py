"""Reading event days and their strategy overrides out of the database.

The rows an operator edits on the Console's Event Days page become the value
object the signal factory consults per leg. Loaded once when the engine is
built, like venues and limits: an event day is a fact about a date, and the
date does not change under a running engine.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.capital.event_days import EventDay, EventDays, StrategyEventDay
from garuda.domain.errors import DomainError
from garuda.persistence.models import EventDaysRow, StrategyEventDaysRow
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


def _parse_day(value: str) -> date | None:
    try:
        return date.fromisoformat(value.strip())
    except (ValueError, AttributeError):
        return None


async def load_event_days(sessions: async_sessionmaker[AsyncSession]) -> EventDays:
    async with UnitOfWork(sessions) as uow:
        days = await uow.repositories.event_days.all()
        overrides = await uow.repositories.strategy_event_days.all()
    return event_days_from(days, overrides)


def event_days_from(
    day_rows: Sequence[EventDaysRow],
    override_rows: Sequence[StrategyEventDaysRow] = (),
) -> EventDays:
    """Turn rows into the lookup. The whole mapping, and nothing else.

    A row the value object refuses -- an unparseable date, a percentage
    outside 0..100 -- is dropped with its name in the log rather than taken as
    a reason to stop trading. Dropping means that day trades at full size,
    which is the behaviour the operator had before they added the row, and is
    reported.
    """
    days: list[EventDay] = []
    for row in day_rows:
        parsed = _parse_day(row.event_date)
        if parsed is None:
            logger.error(
                "event day %r on %s is not a date; ignored, so that day trades full size",
                row.event_date,
                row.exchange_code,
            )
            continue
        if row.capital_percentage is None:
            # The column is nullable and the reference engine left it so. A
            # day with no figure states nothing, and 100% is what "nothing"
            # means -- but say so, because a half-filled row is usually a
            # mistake rather than an intention.
            logger.warning(
                "event day %s on %s states no capital percentage; it trades full size",
                row.event_date,
                row.exchange_code,
            )
            continue
        try:
            days.append(
                EventDay(
                    date=parsed,
                    exchange=row.exchange_code,
                    capital_percentage=row.capital_percentage,
                    name=row.event_name,
                )
            )
        except DomainError as error:
            logger.error("event day ignored: %s", error)

    overrides: list[StrategyEventDay] = []
    for override in override_rows:
        parsed = _parse_day(override.event_date)
        if parsed is None:
            logger.error(
                "%s override on %r is not a date; ignored",
                override.strategy_name,
                override.event_date,
            )
            continue
        try:
            overrides.append(
                StrategyEventDay(
                    strategy=override.strategy_name,
                    date=parsed,
                    exchange=override.exchange_code,
                    capital_percentage=override.capital_percentage,
                )
            )
        except DomainError as error:
            logger.error("strategy event-day override ignored: %s", error)

    if days or overrides:
        logger.info("%d event day(s) and %d strategy override(s) loaded", len(days), len(overrides))
    return EventDays.of(days=tuple(days), overrides=tuple(overrides))
