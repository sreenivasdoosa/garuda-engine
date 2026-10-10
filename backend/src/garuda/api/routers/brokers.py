"""Brokers: the venues' gatekeepers garuda has an adapter for.

`BROKERS` in the reference engine. There the table is open-ended -- an
operator adds a row for any of a dozen vendors and names a provider that
drives it. Here the set is fixed: a broker is an adapter garuda ships, the
rows are seeded, and the page edits what is editable about one rather than
inventing new ones. Creating a row for an adapter that does not exist would
be a broker nothing can trade through, so creation is refused by name.

Two switches matter to the engine. **Enabled** says whether accounts at this
broker are built at all; **stopped** is the operator's hand on the brake for
every account there at once -- the kill switch deliberately has no broker
scope because this is it. Both are honoured when the engine builds its
accounts; see `composition.engine`.

The vendor's endpoints are served for the record and are not editable: a
URL is a fact about someone else's API and belongs in code, where a typo
cannot take trading down in a way indistinguishable from an outage
(`CLAUDE.md`, rule 8). The reference's `MARKET_DATA_APP_*` columns are not
served at all; market-data credentials live on the Data Providers page,
encrypted, and a second plaintext copy here would be the worse of the two.
"""

from __future__ import annotations

import logging
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.persistence import models
from garuda.persistence.repositories import (
    BrokerExchangeConfigRepository,
    BrokersRepository,
    SymbolBrokerInfoRepository,
    TradingClientsRepository,
)

logger = logging.getLogger(__name__)

#: What each broker is, for the page's type picker. Fixed names: the row's
#: name is the adapter's.
TYPES: list[dict[str, Any]] = [
    {
        "value": "zerodha",
        "label": "Zerodha",
        "provider": "zerodha",
        "fixedName": True,
        "description": "Kite Connect. Trading and market data are built.",
    },
    {
        "value": "fyers",
        "label": "Fyers",
        "provider": "fyers",
        "fixedName": True,
        "description": "API v3. Login is built; trading is not yet.",
    },
    {
        "value": "dhan",
        "label": "Dhan",
        "provider": "dhan",
        "fixedName": True,
        "description": "Login and market data are built; trading is not yet.",
    },
    {
        "value": "kotak",
        "label": "Kotak Neo",
        "provider": "kotak",
        "fixedName": True,
        "description": "Neither login nor trading is built yet.",
    },
]

#: Served, never written. See the module docstring.
READ_ONLY = {
    "serverUrl": "server_url",
    "dataServerUrl": "data_server_url",
    "oauthUrl": "oauth_url",
    "hostLookupVersion": "host_lookup_version",
    "hostLookupPath": "host_lookup_path",
    "ioSocketVersion": "iosocket_version",
}


def _number(value: Decimal | None) -> float | None:
    return float(value) if value is not None else None


def wire(row: models.BrokersRow) -> dict[str, Any]:
    return {
        "name": row.broker_name,
        "displayName": row.broker_name.title(),
        "enabled": bool(row.enabled),
        "stopped": bool(row.stopped),
        # Never here: no unattended login of any kind.
        "autoLogin": False,
        "description": row.description,
        # The seeded rows leave this blank where the adapter is the broker
        # itself; the page's type picker needs a value to match on.
        "provider": row.provider or row.broker_name,
        "useDealerAPIs": bool(row.use_dealer_apis),
        "useCommonApp": False,
        "totpEnabled": False,
        "webSocketEnabled": bool(row.web_socket_enabled),
        "apiVersion": row.api_version or 1,
        "serverStartTime": row.server_start_time,
        "serverStopTime": row.server_stop_time,
        "orderUpdateIntervalSecs": row.order_update_interval_secs,
        "positionUpdateIntervalSecs": row.position_update_interval_secs,
        "naicCode": row.naic_code,
        "algoId": row.algo_id,
        "mtfInterestRatePerAnnum": _number(row.mtf_interest_rate_per_annum),
        "serverUrl": row.server_url,
        "dataServerUrl": row.data_server_url,
        "oauthUrl": row.oauth_url,
        "hostLookupVersion": row.host_lookup_version,
        "hostLookupPath": row.host_lookup_path,
        "ioSocketVersion": row.iosocket_version,
        "readOnlyFields": sorted(READ_ONLY),
    }


class BrokerEdit(BaseModel):
    """Every field optional: the form round-trips what it shows."""

    enabled: bool | None = None
    stopped: bool | None = None
    description: str | None = None
    provider: str | None = None
    useDealerAPIs: bool | None = None  # noqa: N815 -- the Console's field names
    webSocketEnabled: bool | None = None  # noqa: N815
    apiVersion: int | None = None  # noqa: N815
    serverStartTime: str | None = None  # noqa: N815
    serverStopTime: str | None = None  # noqa: N815
    orderUpdateIntervalSecs: int | None = None  # noqa: N815
    positionUpdateIntervalSecs: int | None = None  # noqa: N815
    naicCode: str | None = None  # noqa: N815
    algoId: str | None = None  # noqa: N815
    mtfInterestRatePerAnnum: float | None = None  # noqa: N815
    # Accepted so a form that sends everything back is not refused for
    # repeating what it was given; a *change* to one is refused by name.
    serverUrl: str | None = None  # noqa: N815
    dataServerUrl: str | None = None  # noqa: N815
    oauthUrl: str | None = None  # noqa: N815
    hostLookupVersion: str | None = None  # noqa: N815
    hostLookupPath: str | None = None  # noqa: N815
    ioSocketVersion: str | None = None  # noqa: N815
    # The reference's fields the Console still sends; ignored, never stored.
    autoLogin: bool | None = None  # noqa: N815
    useCommonApp: bool | None = None  # noqa: N815
    totpEnabled: bool | None = None  # noqa: N815
    name: str | None = None
    displayName: str | None = None  # noqa: N815


def _clock_time(value: str | None, field: str) -> str | None:
    """``HH:MM``, or None. The column is five characters wide."""
    if value is None or value == "":
        return None
    parts = value.split(":")
    if len(parts) != 2 or not all(p.isdigit() for p in parts):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not HH:MM")
    hour, minute = int(parts[0]), int(parts[1])
    if not (0 <= hour < 24 and 0 <= minute < 60):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not a time of day")
    return f"{hour:02d}:{minute:02d}"


def _decimal(value: Any, field: str) -> Decimal:
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise HTTPException(status_code=400, detail=f"{field}: {value!r} is not a number") from None
    if parsed < 0:
        raise HTTPException(status_code=400, detail=f"{field} cannot be negative")
    return parsed


def _positive(value: int, field: str) -> int:
    if value <= 0:
        raise HTTPException(status_code=400, detail=f"{field} must be a positive number of seconds")
    return value


def build(sessions: async_sessionmaker[AsyncSession]) -> APIRouter:
    router = APIRouter(prefix="/api/brokers", tags=["brokers"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _row(db: AsyncSession, name: str) -> models.BrokersRow:
        row = await BrokersRepository(db).get(name.strip().lower())
        if row is None:
            raise HTTPException(status_code=404, detail=f"{name!r} is not a broker garuda knows")
        return row

    async def _usage(db: AsyncSession, name: str) -> dict[str, Any]:
        """What refers to this broker. Blockers stop a delete; history does not.

        The reference counts ten tables. Garuda has three that would dangle
        and one worth knowing about: trades are recorded against a trading
        client, so a broker's history is its clients' history.
        """
        clients = [
            row
            for row in await TradingClientsRepository(db).all()
            if row.broker.lower() == name.lower()
        ]
        exchange_configs = await BrokerExchangeConfigRepository(db).count(broker_name=name)
        symbol_limits = await SymbolBrokerInfoRepository(db).count(broker_name=name)
        trades = 0
        if clients:
            trades = (
                await db.execute(
                    select(func.count())
                    .select_from(models.TradesRow)
                    .where(models.TradesRow.trading_client_id.in_([c.id for c in clients]))
                )
            ).scalar_one()
        return {
            "broker": name,
            "blockers": {
                "tradingClients": len(clients),
                "brokerExchangeConfigs": exchange_configs,
                "symbolBrokerLimits": symbol_limits,
            },
            "historical": {"trades": trades},
            "sampleClients": [c.display_name for c in clients[:5]],
        }

    @router.get("")
    async def list_brokers(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await BrokersRepository(db).all(order_by="broker_name")
        return ok([wire(row) for row in rows], count=len(rows))

    @router.get("/types")
    async def types() -> dict[str, Any]:
        """The brokers garuda has adapters for. Fixed; the page picks from these."""
        return ok(TYPES)

    @router.get("/{name}")
    async def get_broker(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        return ok(wire(await _row(db, name)))

    @router.get("/{name}/usage")
    async def usage(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await _row(db, name)
        return ok(await _usage(db, row.broker_name))

    @router.post("")
    async def create_broker() -> dict[str, Any]:
        raise HTTPException(
            status_code=400,
            detail="a broker is an adapter garuda ships, and the rows for "
            + ", ".join(sorted(t["value"] for t in TYPES))
            + " are seeded; there is nothing to add. Configure one instead.",
        )

    @router.put("/{name}")
    async def update_broker(
        name: str, body: BrokerEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _row(db, name)
        given = body.model_dump(exclude_unset=True)

        for field, column in READ_ONLY.items():
            if field in given and (given[field] or None) != (getattr(row, column) or None):
                raise HTTPException(
                    status_code=400,
                    detail=f"{field} is not editable: a vendor's endpoint is a fact about "
                    "its API and lives in code, not in a row",
                )
        if "provider" in given:
            provider = (given["provider"] or "").strip().lower() or None
            known = {t["provider"] for t in TYPES}
            if provider is not None and provider not in known:
                raise HTTPException(
                    status_code=400,
                    detail=f"{provider!r} is not a provider garuda knows; one of "
                    + ", ".join(sorted(known)),
                )
            row.provider = provider
        if "enabled" in given:
            row.enabled = bool(given["enabled"])
        if "stopped" in given:
            row.stopped = bool(given["stopped"])
        if "description" in given:
            row.description = (given["description"] or "").strip() or None
        if "useDealerAPIs" in given:
            row.use_dealer_apis = bool(given["useDealerAPIs"])
        if "webSocketEnabled" in given:
            row.web_socket_enabled = bool(given["webSocketEnabled"])
        if "apiVersion" in given:
            if given["apiVersion"] is not None and given["apiVersion"] < 1:
                raise HTTPException(status_code=400, detail="apiVersion must be 1 or more")
            row.api_version = given["apiVersion"]
        if "serverStartTime" in given:
            row.server_start_time = _clock_time(given["serverStartTime"], "serverStartTime")
        if "serverStopTime" in given:
            row.server_stop_time = _clock_time(given["serverStopTime"], "serverStopTime")
        if "orderUpdateIntervalSecs" in given and given["orderUpdateIntervalSecs"] is not None:
            row.order_update_interval_secs = _positive(
                given["orderUpdateIntervalSecs"], "orderUpdateIntervalSecs"
            )
        if (
            "positionUpdateIntervalSecs" in given
            and given["positionUpdateIntervalSecs"] is not None
        ):
            row.position_update_interval_secs = _positive(
                given["positionUpdateIntervalSecs"], "positionUpdateIntervalSecs"
            )
        if "naicCode" in given:
            row.naic_code = (given["naicCode"] or "").strip() or None
        if "algoId" in given:
            row.algo_id = (given["algoId"] or "").strip() or None
        if "mtfInterestRatePerAnnum" in given and given["mtfInterestRatePerAnnum"] is not None:
            row.mtf_interest_rate_per_annum = _decimal(
                given["mtfInterestRatePerAnnum"], "mtfInterestRatePerAnnum"
            )

        await db.commit()
        logger.info("broker %s updated: %s", row.broker_name, ", ".join(sorted(given)))
        return ok(wire(row), message=f"{row.broker_name} saved")

    @router.put("/{name}/stop")
    async def stop(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """The brake, for every account at this broker."""
        row = await _row(db, name)
        row.stopped = True
        await db.commit()
        logger.warning("broker %s stopped from the Console", row.broker_name)
        return ok(wire(row), message=f"{row.broker_name} stopped")

    @router.put("/{name}/unstop")
    async def unstop(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        row = await _row(db, name)
        row.stopped = False
        await db.commit()
        logger.info("broker %s unstopped from the Console", row.broker_name)
        return ok(wire(row), message=f"{row.broker_name} unstopped")

    @router.delete("/{name}")
    async def delete_broker(name: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Refused while anything refers to it, with the full usage so the
        operator knows what to clear first -- the reference's shape."""
        row = await _row(db, name)
        found = await _usage(db, row.broker_name)
        if any(count > 0 for count in found["blockers"].values()):
            raise HTTPException(
                status_code=409,
                detail=f"{row.broker_name} is still in use: "
                + ", ".join(f"{k} {v}" for k, v in found["blockers"].items() if v),
            )
        await BrokersRepository(db).delete(row.broker_name)
        await db.commit()
        logger.warning("broker %s deleted from the Console", row.broker_name)
        return ok(None, message=f"{row.broker_name} removed")

    return router
