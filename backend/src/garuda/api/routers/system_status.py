"""System Status: the engine, read end to end, for the operator's one glance.

Ported from the reference's system status servlet: one snapshot built in
memory, an on-demand quote-and-history probe that costs a network
round-trip, and the two init timelines. The engine's part comes through the
status view the composition root hands the app (``app.state.status``);
the counts that live only in the tables -- definitions by status,
subscriptions, who has logged in, today's breaches -- are read here, so the
page still answers on an API served without an engine, and says which
half is missing.

Each panel degrades on its own: a part that cannot report costs that panel
an ``error`` and nothing else, which is the reference's rule too.
"""

from __future__ import annotations

import datetime as dt
import logging
from collections.abc import Callable
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.api.routers.rms import AUTOMATIC_SOURCES
from garuda.api.routers.ticker import download_wire, ticker_wire
from garuda.domain.errors import DomainError
from garuda.persistence import models
from garuda.persistence.repositories import (
    BrokersRepository,
    ExchangesRepository,
    KillSwitchesRepository,
    KillSwitchTypesRepository,
    StrategyDefinitionsRepository,
    SubscriptionsRepository,
    TradingClientLoginStatusRepository,
    TradingClientsRepository,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

NO_ENGINE = "the API is running without an engine"


def _iso(moment: dt.datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def _seconds(span: dt.timedelta | None) -> int | None:
    return None if span is None else int(span.total_seconds())


def _millis(span: dt.timedelta) -> int:
    return int(span.total_seconds() * 1000)


def _panel(name: str, build: Callable[[], dict[str, Any] | list[Any]]) -> Any:
    """One panel, or its error. A page is never lost to one part of it."""
    try:
        return build()
    except Exception as error:
        logger.exception("system status: the %s panel could not be built", name)
        return {"error": f"{type(error).__name__}: {error}"}


# -- wire ---------------------------------------------------------------------


def process_wire(status: Any) -> dict[str, Any]:
    total = status.system_memory_total_mb
    available = status.system_memory_available_mb
    return {
        "version": status.version,
        "python": status.python,
        "startedAt": _iso(status.started_at),
        "uptimeSeconds": _seconds(status.uptime),
        "cpuCount": status.cpu_count,
        "loadAverage": list(status.load_average) if status.load_average else None,
        "processRssMb": status.process_rss_mb,
        "systemMemoryTotalMb": total,
        "systemMemoryAvailableMb": available,
        "systemMemoryUsedMb": (
            total - available if total is not None and available is not None else None
        ),
        "openFileDescriptors": status.open_file_descriptors,
        "maxFileDescriptors": status.max_file_descriptors,
        "threads": status.threads,
        "asyncioTasks": status.asyncio_tasks,
    }


def feed_wire(status: Any) -> dict[str, Any]:
    return {
        **ticker_wire(status.service),
        "state": status.state,
        "marketOpen": status.any_market_open,
        "historyProvider": status.history_provider,
    }


def loops_wire(status: Any) -> dict[str, Any]:
    strategy = status.strategy_loop
    return {
        "runnerRunning": status.runner_running,
        "tradeLoopsStarted": status.trade_loops_started,
        "accountsCycling": sorted(status.accounts_cycling),
        "strategyLoop": (
            None
            if strategy is None
            else {
                "running": strategy.running,
                "intervalSeconds": _seconds(strategy.interval),
                "tradingDay": strategy.trading_day.isoformat(),
                "strategiesLoaded": strategy.strategies_loaded,
                "subscriptions": strategy.subscriptions,
                "refused": dict(sorted(strategy.refused.items())),
                "tranchesOpen": strategy.tranches_open,
                "tranchesToday": strategy.tranches_today,
            }
        ),
    }


def venue_wire(status: Any) -> dict[str, Any]:
    upcoming = status.next_phase
    return {
        "code": status.code,
        "name": status.name,
        "timezone": status.timezone,
        "tradingDay": status.trading_day.isoformat(),
        "isTradingDay": status.is_trading_day,
        "isOpen": status.is_open,
        "sessions": [{"opens": opens, "closes": closes} for opens, closes in status.sessions],
        "nextPhase": (
            None if upcoming is None else {"phase": upcoming.phase.value, "at": _iso(upcoming.at)}
        ),
    }


def kill_switch_wire(switch: Any) -> dict[str, Any]:
    scope = switch.scope
    return {
        "scope": str(scope),
        "tradingClient": scope.trading_client,
        "exchange": scope.exchange,
        "symbol": scope.symbol,
        "reason": switch.reason,
        "source": switch.source,
    }


def probe_wire(result: Any) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "latencyMs": _millis(result.latency),
        "error": result.error,
        "lastPrice": None if result.last_price is None else str(result.last_price.amount),
        "at": _iso(result.at),
        "candles": result.candles,
        "interval": result.interval,
    }


def event_wire(event: Any) -> dict[str, Any]:
    return {"timestamp": _iso(event.at), "message": event.message}


#: The reference's rule for an account's session, read off its status row:
#: logged in when the login succeeded and a token is held, failed when it
#: did not and said why, logged out otherwise.
def session_state(status: models.TradingClientLoginStatusRow | None) -> str:
    if status is None:
        return "NONE"
    if status.is_login_success and status.access_token_encrypted:
        return "LOGGED_IN"
    if not status.is_login_success and status.login_error:
        return "FAILED"
    return "LOGGED_OUT"


class RunPhaseBody(BaseModel):
    """Module-level, not nested: with postponed annotations FastAPI resolves
    the name against the module, and a nested class reads as a query field."""

    exchange: str
    phase: str
    tradingDay: str | None = None  # noqa: N815


def build(sessions: async_sessionmaker[AsyncSession], clock: Clock) -> APIRouter:
    router = APIRouter(prefix="/api/system-status", tags=["system-status"])

    async def session() -> Any:
        async with sessions() as db:
            yield db

    def _view(request: Request) -> Any:
        return getattr(request.app.state, "status", None)

    async def _zone(db: AsyncSession) -> dt.tzinfo:
        """The venue's clock, for what "today" means. UTC when none is set."""
        for row in await ExchangesRepository(db).all(order_by="exchange_code"):
            if row.timezone:
                try:
                    return ZoneInfo(row.timezone)
                except ZoneInfoNotFoundError:
                    continue
        return dt.UTC

    async def _today(view: Any, db: AsyncSession) -> dt.date:
        """The venue's trading day as the engine reckons it, else its date."""
        now = clock.now()
        if view is not None:
            venues = view.venues()
            if venues and isinstance(venues[0].trading_day, dt.date):
                return venues[0].trading_day
        return now.astimezone(await _zone(db)).date()

    async def _breaches_today(db: AsyncSession, today: dt.date) -> int:
        zone = await _zone(db)
        start = dt.datetime.combine(today, dt.time.min, tzinfo=zone)
        statement = (
            select(func.count())
            .select_from(models.RmsBreachLogRow)
            .where(models.RmsBreachLogRow.breach_time >= start)
            .where(models.RmsBreachLogRow.breach_time < start + dt.timedelta(days=1))
        )
        return int((await db.execute(statement)).scalar_one())

    # -- the panels the tables answer ------------------------------------------

    async def _strategies(db: AsyncSession) -> dict[str, Any]:
        definitions = await StrategyDefinitionsRepository(db).all()
        counts = {"total": 0, "active": 0, "windDown": 0, "inactive": 0}
        triggers = {"tick": 0, "scheduled": 0, "signal": 0, "periodic": 0}
        for row in definitions:
            counts["total"] += 1
            if row.status == "INACTIVE":
                counts["inactive"] += 1
            elif row.status == "WIND_DOWN":
                counts["windDown"] += 1
            else:
                counts["active"] += 1
            triggers["tick"] += bool(row.tick_trigger_enabled)
            triggers["scheduled"] += bool(row.scheduled_trigger_enabled)
            triggers["signal"] += bool(row.signal_trigger_enabled)
            triggers["periodic"] += bool(row.periodic_trigger_enabled)
        subscriptions = await SubscriptionsRepository(db).all()
        active = sum(1 for s in subscriptions if s.is_active)
        paper = sum(1 for s in subscriptions if s.is_paper_trading)
        return {
            "definitions": {
                **counts,
                "tickEnabled": triggers["tick"],
                "scheduledEnabled": triggers["scheduled"],
                "signalEnabled": triggers["signal"],
                "periodicEnabled": triggers["periodic"],
            },
            "subscriptions": {
                "total": len(subscriptions),
                "active": active,
                "inactive": len(subscriptions) - active,
                "paper": paper,
                "live": len(subscriptions) - paper,
            },
        }

    async def _accounts_and_brokers(
        view: Any, db: AsyncSession
    ) -> tuple[dict[str, Any], dict[str, Any]]:
        clients = await TradingClientsRepository(db).all(order_by="display_name")
        statuses = {
            s.trading_client_id: s for s in await TradingClientLoginStatusRepository(db).all()
        }
        engine_rows = {row.trading_client_id: row for row in view.accounts()} if view else {}

        rows: list[dict[str, Any]] = []
        for client in clients:
            status = statuses.get(client.id)
            built = engine_rows.get(client.id)
            rows.append(
                {
                    "tradingClientId": client.id,
                    "displayName": client.display_name,
                    "broker": client.broker,
                    "clientId": client.client_id,
                    "enabled": bool(client.enabled),
                    "session": session_state(status),
                    "loginError": (
                        status.login_error if status and not status.is_login_success else None
                    ),
                    "sessionCreatedOn": _iso(status.session_created_on) if status else None,
                    "isTrading": built.is_trading if built else False,
                    "unavailableBecause": (
                        built.unavailable_because if built else (None if view else NO_ENGINE)
                    ),
                    "isCycling": built.is_cycling if built else False,
                }
            )
        by_state = dict.fromkeys(("LOGGED_IN", "FAILED", "LOGGED_OUT", "NONE"), 0)
        for row in rows:
            by_state[row["session"]] += 1
        accounts = {
            "configured": len(rows),
            "loggedIn": by_state["LOGGED_IN"],
            "failed": by_state["FAILED"],
            "loggedOut": by_state["LOGGED_OUT"] + by_state["NONE"],
            "trading": sum(1 for row in rows if row["isTrading"]),
            "rows": rows,
        }

        broker_rows: list[dict[str, Any]] = []
        for broker in await BrokersRepository(db).all(order_by="broker_name"):
            mine = [row for row in rows if row["broker"].lower() == broker.broker_name.lower()]
            broker_rows.append(
                {
                    "name": broker.broker_name,
                    "enabled": bool(broker.enabled),
                    "stopped": bool(broker.stopped),
                    "accounts": len(mine),
                    "loggedIn": sum(1 for row in mine if row["session"] == "LOGGED_IN"),
                    "trading": sum(1 for row in mine if row["isTrading"]),
                }
            )
        brokers = {
            "total": len(broker_rows),
            "enabled": sum(1 for row in broker_rows if row["enabled"]),
            "stopped": sum(1 for row in broker_rows if row["stopped"]),
            "rows": broker_rows,
        }
        return accounts, brokers

    async def _risk(view: Any, db: AsyncSession, today: dt.date) -> dict[str, Any]:
        types = {row.source: bool(row.enabled) for row in await KillSwitchTypesRepository(db).all()}
        if view is not None:
            risk = view.risk()
            switches = [kill_switch_wire(s) for s in risk.kill_switches]
            limit_rows: int | None = risk.limit_rows
        else:
            todays = await KillSwitchesRepository(db).find(created_date=today)
            switches = [
                {
                    "scope": r.key_name,
                    "tradingClient": None,
                    "exchange": None,
                    "symbol": None,
                    "reason": r.reason,
                    "source": r.source,
                }
                for r in todays
                if r.removed_at is None and r.active
            ]
            limit_rows = None
        return {
            # Always on; there is no switch for the gate (`CLAUDE.md`, fail closed).
            "enabled": True,
            "activeKillSwitches": len(switches),
            "killSwitches": switches,
            "killSwitchTypes": {source: types.get(source, True) for source in AUTOMATIC_SOURCES},
            "breachesToday": await _breaches_today(db, today),
            "limitRows": limit_rows,
        }

    # -- routes ------------------------------------------------------------------

    @router.get("")
    async def snapshot(request: Request, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """The whole page, in one read. Cheap: in-memory except the counts."""
        view = _view(request)
        today = await _today(view, db)
        accounts, brokers = await _accounts_and_brokers(view, db)
        body: dict[str, Any] = {
            "generatedAt": _iso(clock.now()),
            "engineAttached": view is not None,
            "tradingDay": today.isoformat(),
            "runtime": _panel("runtime", lambda: process_wire(view.process())) if view else None,
            "feed": _panel("feed", lambda: feed_wire(view.feed())) if view else None,
            "loops": _panel("loops", lambda: loops_wire(view.loops())) if view else None,
            "venues": (
                _panel(
                    "venues",
                    lambda: {
                        "anyMarketOpen": any(v.is_open for v in view.venues()),
                        "rows": [venue_wire(v) for v in view.venues()],
                    },
                )
                if view
                else None
            ),
            "instrumentFiles": (
                _panel(
                    "instrument files",
                    lambda: [download_wire(s) for s in view.instrument_files()],
                )
                if view
                else None
            ),
            "accounts": accounts,
            "brokers": brokers,
            "strategies": await _strategies(db),
            "risk": await _risk(view, db, today),
        }
        return ok(body)

    @router.get("/health-check")
    async def health_check(request: Request) -> dict[str, Any]:
        """Is market data answering? Costs a network round-trip; on demand only."""
        view = _view(request)
        if view is None:
            raise HTTPException(
                status_code=503, detail=f"{NO_ENGINE}, so there is nothing to probe"
            )
        result = await view.health_check()
        return ok(
            {
                "instrument": result.instrument.value,
                "tick": probe_wire(result.tick),
                "history": probe_wire(result.history),
            }
        )

    @router.post("/run-phase")
    async def run_phase(body: RunPhaseBody, request: Request) -> dict[str, Any]:
        """Run one phase for one venue now: the reference's manual EOD, widened.

        Confirmed in the Console first, because INTRADAY_SQUARE_OFF and EOD
        do what their names say.
        """
        view = _view(request)
        if view is None:
            raise HTTPException(status_code=503, detail=f"{NO_ENGINE}, so no phase can run")
        day: dt.date | None = None
        if body.tradingDay:
            try:
                day = dt.date.fromisoformat(body.tradingDay)
            except ValueError:
                raise HTTPException(
                    status_code=400, detail=f"{body.tradingDay!r} is not a date (YYYY-MM-DD)"
                ) from None
        try:
            failure = await view.run_phase(body.exchange, body.phase, day)
        except (ValueError, DomainError, RuntimeError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from None
        ran_for = day.isoformat() if day else "today"
        if failure is not None:
            return ok(
                {
                    "exchange": body.exchange.upper(),
                    "phase": body.phase.upper(),
                    "ran": False,
                    "failure": failure,
                },
                message=(
                    f"{body.exchange.upper()} {body.phase.upper()} for {ran_for} failed: {failure}"
                ),
            )
        return ok(
            {
                "exchange": body.exchange.upper(),
                "phase": body.phase.upper(),
                "ran": True,
                "failure": None,
            },
            message=f"{body.exchange.upper()} {body.phase.upper()} for {ran_for} ran",
        )

    @router.get("/init-timeline")
    async def init_timeline(request: Request) -> dict[str, Any]:
        """What starting up and starting the day did, newest first."""
        view = _view(request)
        if view is None:
            return ok({"startup": [], "day": [], "engineAttached": False})
        return ok(
            {
                "startup": [event_wire(e) for e in view.startup_events()],
                "day": [event_wire(e) for e in view.day_events()],
                "engineAttached": True,
            }
        )

    return router
