"""Breakout watches, kept in `strategy_breakout_watches` as the reference keeps
them, so a restart mid-morning re-arms what was waiting rather than
forgetting it.

The reference's own columns carry the levels and the trade; the watch's key
and the legs it will enter travel in `metadata_json`, which is what lets one
row be found again and re-armed exactly.
"""

from __future__ import annotations

import datetime as dt
import json
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, OptionType
from garuda.domain.instrument import InstrumentId
from garuda.engine.breakout import Watch, WatchedLeg
from garuda.engine.vocabulary import BreakoutDirection, BreakoutTriggerMode, BreakoutWatchType
from garuda.persistence.models import StrategyBreakoutWatchesRow


class BreakoutWatchStore:
    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = sessions

    async def live_on(self, day: dt.date, timezone: dt.tzinfo) -> list[Watch]:
        """The day's watches that have neither fired nor lapsed."""
        async with self._sessions() as session:
            rows = (
                await session.execute(
                    select(StrategyBreakoutWatchesRow).where(
                        StrategyBreakoutWatchesRow.is_triggered.is_(False),
                        StrategyBreakoutWatchesRow.is_expired.is_(False),
                    )
                )
            ).scalars()
            out: list[Watch] = []
            for row in rows:
                meta = _meta(row)
                if meta.get("day") != day.isoformat():
                    continue
                out.append(_watch_of(row, meta, day, timezone))
            return out

    async def save(self, watch: Watch, *, trigger_value: Decimal, now: dt.datetime) -> None:
        async with self._sessions() as session:
            row = await _find(session, watch.key, watch.trading_client)
            if row is None:
                row = StrategyBreakoutWatchesRow(
                    trading_client_id=watch.trading_client.value,
                    created_at=now,
                    risk_used_estimate=Decimal(0),
                )
                session.add(row)
            exchange, _, symbol = watch.watched.value.partition(":")
            row.watch_type = watch.kind.value
            row.watch_symbol = symbol
            row.exchange = exchange
            row.reference_price = watch.reference_price
            row.trigger_price_above = watch.above
            row.trigger_price_below = watch.below
            row.direction = watch.direction.value
            row.trigger_mode = watch.mode.value
            row.trigger_value = trigger_value
            row.strategy_name = watch.strategy
            row.tranch_number = watch.tranche
            row.group_id = watch.group[:50]
            row.valid_till = (
                watch.valid_till.timetz().replace(tzinfo=None) if watch.valid_till else None
            )
            row.is_triggered = watch.triggered_at is not None
            row.triggered_at = watch.triggered_at
            row.triggered_price = watch.triggered_price
            row.is_expired = watch.expired_at is not None
            row.expired_at = watch.expired_at
            row.is_paper_trading = watch.is_paper
            main = next((leg for leg in watch.legs if not leg.hedge), None)
            if main is not None:
                row.trading_symbol = main.instrument.value
                row.option_type = main.option_type.value[:2] if main.option_type else None
                row.strike = int(main.strike) if main.strike is not None else None
                row.trade_direction = main.direction.value
                row.entry_premium = watch.reference_price
            row.metadata_json = json.dumps(
                {
                    "key": watch.key,
                    "day": watch.key.split("|")[2],
                    "watched": watch.watched.value,
                    "legs": [
                        {
                            "instrument": leg.instrument.value,
                            "direction": leg.direction.value,
                            "hedge": leg.hedge,
                            "optionType": leg.option_type.value if leg.option_type else None,
                            "strike": str(leg.strike) if leg.strike is not None else None,
                        }
                        for leg in watch.legs
                    ],
                }
            )
            await session.commit()


async def _find(
    session: AsyncSession, key: str, client: TradingClientId
) -> StrategyBreakoutWatchesRow | None:
    rows = (
        await session.execute(
            select(StrategyBreakoutWatchesRow).where(
                StrategyBreakoutWatchesRow.trading_client_id == client.value
            )
        )
    ).scalars()
    for row in rows:
        if _meta(row).get("key") == key:
            return row
    return None


def _meta(row: StrategyBreakoutWatchesRow) -> dict[str, Any]:
    try:
        parsed = json.loads(row.metadata_json or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _watch_of(
    row: StrategyBreakoutWatchesRow, meta: dict[str, Any], day: dt.date, timezone: dt.tzinfo
) -> Watch:
    legs = tuple(
        WatchedLeg(
            instrument=InstrumentId(str(leg["instrument"])),
            direction=Direction(str(leg["direction"])),
            hedge=bool(leg.get("hedge")),
            option_type=OptionType(str(leg["optionType"])) if leg.get("optionType") else None,
            strike=Decimal(str(leg["strike"])) if leg.get("strike") else None,
        )
        for leg in meta.get("legs", [])
    )
    return Watch(
        key=str(meta["key"]),
        trading_client=TradingClientId(row.trading_client_id),
        strategy=row.strategy_name,
        tranche=row.tranch_number,
        kind=BreakoutWatchType.parse(row.watch_type),
        watched=InstrumentId(str(meta.get("watched") or f"{row.exchange}:{row.watch_symbol}")),
        direction=BreakoutDirection.parse(row.direction),
        mode=BreakoutTriggerMode.parse(row.trigger_mode),
        reference_price=row.reference_price,
        above=row.trigger_price_above,
        below=row.trigger_price_below,
        valid_till=dt.datetime.combine(day, row.valid_till, timezone) if row.valid_till else None,
        group=row.group_id or "",
        is_paper=row.is_paper_trading,
        legs=legs,
    )
