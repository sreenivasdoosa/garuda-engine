"""Trading clients: the broker accounts orders are routed to.

`USER_BROKERS_MAP` in the reference engine, with the user half removed. One
operator owns every account here, so what remains is the account itself: a
display name, a broker, the broker's own id for it, and what logging in to it
needs.

The columns the reference keeps for unattended login -- password, PIN, TOTP
key, PAN -- are not here and never will be; `SCOPE_DECISIONS.md` §4. **Every
login starts with the operator pressing a button.** For Zerodha, Fyers and
Dhan that means a browser redirect and a callback; the engine exchanges the
code it comes back with for a session, server-side, which is why the API
secret is stored at all.

A trading client may log in through another one: a dealer terminal issues one
token for several client ids. Such an account has no login of its own and
says so, rather than offering a button that would store a token nothing
reads.

The login status is a separate row with the opposite lifetime -- credentials
change almost never, login state changes every morning -- and is served
merged into the client, because the page asks one question: can this account
trade right now?
"""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.api.routers.ticker import renew_after_login
from garuda.brokers.zerodha.auth import ZerodhaAuth, ZerodhaCredentials
from garuda.domain.client import BrokerCode
from garuda.domain.errors import DomainError
from garuda.domain.session import BrokerSession
from garuda.marketdata.providers.auth import ProviderLoginError, auth_for
from garuda.marketdata.providers.credentials import ProviderCredentials
from garuda.persistence import models
from garuda.persistence.repositories import (
    TradingClientLoginStatusRepository,
    TradingClientsRepository,
)
from garuda.persistence.secrets import SecretBox
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: Brokers an operator can log a trading client in to from the Console today.
#: Each goes through a browser redirect. Kotak has no adapter yet, and paper
#: has no vendor to log in to.
LOGIN_SUPPORTED: frozenset[str] = frozenset({"ZERODHA", "FYERS", "DHAN"})


def callback_path(broker: str, trading_client_id: str) -> str:
    """Where the vendor sends the browser back for this account.

    The same shape the Data Providers page registers, and deliberately so: a
    provider that borrows this account's credentials logs in through this
    very URL, and the vendor's console holds one redirect per app.
    """
    return f"/api/auth/callback/{broker.lower()}/{trading_client_id}"


def _iso(moment: datetime | None) -> str | None:
    return None if moment is None else moment.isoformat()


def wire(
    row: models.TradingClientRow, status: models.TradingClientLoginStatusRow | None
) -> dict[str, Any]:
    logged_in = bool(status and status.access_token_encrypted)
    return {
        "id": row.id,
        "displayName": row.display_name,
        "broker": row.broker,
        "clientId": row.client_id,
        "enabled": row.enabled,
        "apiKey": row.api_key,
        # Never the secret itself; whether one is stored is what the page
        # needs to tell "not set" from "set and hidden".
        "hasApiSecret": bool(row.api_secret_encrypted),
        "callbackPath": callback_path(row.broker, row.id),
        "staticIp": row.static_ip,
        "isPro": row.is_pro,
        "useDealerApis": row.use_dealer_apis,
        "websocketEnabled": row.websocket_enabled,
        "usesCredentialsOf": row.uses_credentials_of,
        "isMarketDataSource": row.is_market_data_source,
        "loginStyle": "REDIRECT" if row.broker in LOGIN_SUPPORTED else "UNSUPPORTED",
        # An account riding on another's session has nothing to log in to.
        "canLogin": row.broker in LOGIN_SUPPORTED and not row.uses_credentials_of,
        "isLoggedIn": logged_in,
        "loginError": status.login_error if status and not status.is_login_success else None,
        "passwordExpiryDays": status.password_expiry_days if status else None,
        "sessionCreatedOn": _iso(status.session_created_on) if status else None,
        "lastLoginAttemptAt": _iso(status.updated_on) if status else None,
        "createdAt": _iso(row.created_at),
        "updatedAt": _iso(row.updated_at),
    }


class ClientEdit(BaseModel):
    displayName: str | None = Field(default=None, max_length=100)  # noqa: N815
    broker: str | None = None
    clientId: str | None = Field(default=None, max_length=100)  # noqa: N815
    enabled: bool | None = None
    apiKey: str | None = None  # noqa: N815
    #: Send to set or change; omit to leave alone; empty string to clear.
    apiSecret: str | None = None  # noqa: N815
    staticIp: str | None = None  # noqa: N815
    isPro: bool | None = None  # noqa: N815
    #: True or False overrides the broker's own setting; null inherits it.
    useDealerApis: bool | None = None  # noqa: N815
    websocketEnabled: bool | None = None  # noqa: N815
    usesCredentialsOf: str | None = None  # noqa: N815
    isMarketDataSource: bool | None = None  # noqa: N815


class NewClient(ClientEdit):
    displayName: str = Field(min_length=1, max_length=100)  # noqa: N815
    broker: str = Field(min_length=1)
    clientId: str = Field(min_length=1, max_length=100)  # noqa: N815


def slug(display_name: str) -> str:
    """The id a new account gets: its display name, as a word.

    An id that reads in a log -- ``appa``, ``amma-kotak`` -- rather than a
    uuid, because the id is what every trade, position and subscription will
    carry. It is fixed at creation and never follows a rename; a name is for
    people and may change, an id is for rows and must not.
    """
    cleaned = re.sub(r"[^a-z0-9]+", "-", display_name.strip().lower()).strip("-")
    return cleaned[:48] or "client"


def _broker(value: str) -> str:
    code = value.strip().upper()
    if code not in {member.value for member in BrokerCode}:
        raise HTTPException(
            status_code=400,
            detail=f"{value!r} is not a broker garuda knows; one of "
            + ", ".join(member.value for member in BrokerCode),
        )
    return code


async def complete_login(
    db: AsyncSession,
    row: models.TradingClientRow,
    code: str,
    *,
    clock: Clock,
    secrets: SecretBox,
) -> BrokerSession:
    """Turn the code the vendor's redirect carried into a stored session.

    Zerodha goes through the broker's own auth, which checks that whoever
    logged in is the account this client names and keeps the public token
    the ticker needs. Fyers and Dhan go through the provider auth, which is
    the same exchange. Either way the result is written against the trading
    client, success or failure -- the reference records a failed login's
    reason in the same row, and that is what makes a morning's failure
    diagnosable from the page instead of the log.

    Raises on failure, after recording it, so the caller can say so.
    """
    now = clock.now()
    try:
        session = await _exchange(row, code, clock=clock, secrets=secrets)
    except (DomainError, ProviderLoginError, HTTPException) as error:
        detail = getattr(error, "detail", None) or str(error)
        await TradingClientLoginStatusRepository(db).upsert(
            {
                "trading_client_id": row.id,
                "client_id": row.client_id,
                "is_login_success": False,
                "login_error": str(detail)[:2000],
                "updated_on": now,
            },
            conflict_on=("trading_client_id",),
        )
        await db.commit()
        raise

    await TradingClientLoginStatusRepository(db).upsert(
        {
            "trading_client_id": row.id,
            "client_id": row.client_id,
            "is_login_success": True,
            "login_error": None,
            "access_token_encrypted": secrets.seal(session.access_token),
            "public_token_encrypted": secrets.seal(session.public_token),
            "request_token": session.request_token,
            "session_created_on": session.created_at,
            "updated_on": now,
        },
        conflict_on=("trading_client_id",),
    )
    await db.commit()
    logger.info("%s (%s:%s) logged in", row.display_name, row.broker, row.client_id)
    return session


async def _exchange(
    row: models.TradingClientRow, code: str, *, clock: Clock, secrets: SecretBox
) -> BrokerSession:
    secret = secrets.open(row.api_secret_encrypted) or ""
    async with httpx.AsyncClient(timeout=30.0) as client:
        if row.broker == "ZERODHA":
            auth = ZerodhaAuth(
                ZerodhaCredentials(
                    client_id=row.client_id, api_key=row.api_key or "", api_secret=secret
                ),
                clock,
                client,
            )
            return await auth.exchange(code)

        provider = auth_for(
            ProviderCredentials(
                provider=row.broker.lower(),
                api_key=row.api_key or "",
                api_secret=secret,
                client_id=row.client_id,
                redirect_url=row.redirect_url,
            ),
            clock,
            client,
        )
        completed = await provider.complete(code)
        return BrokerSession(
            client_id=completed.client_id or row.client_id,
            access_token=completed.access_token,
            created_at=completed.obtained_at,
        )


def build(
    sessions: async_sessionmaker[AsyncSession],
    secrets: SecretBox,
    clock: Clock,
) -> APIRouter:
    router = APIRouter(prefix="/api/trading-clients", tags=["trading-clients"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _row(db: AsyncSession, trading_client_id: str) -> models.TradingClientRow:
        row = await TradingClientsRepository(db).get(trading_client_id)
        if row is None:
            raise HTTPException(
                status_code=404, detail=f"{trading_client_id!r} is not a trading client"
            )
        return row

    async def _status_by_id(db: AsyncSession) -> dict[str, models.TradingClientLoginStatusRow]:
        return {
            status.trading_client_id: status
            for status in await TradingClientLoginStatusRepository(db).all()
        }

    async def _served(db: AsyncSession, row: models.TradingClientRow) -> dict[str, Any]:
        return wire(row, await TradingClientLoginStatusRepository(db).get(row.id))

    async def _apply(
        db: AsyncSession, row: models.TradingClientRow, edit: ClientEdit, *, creating: bool
    ) -> None:
        """Validate and write the edit onto the row. Refuses with a reason."""
        repository = TradingClientsRepository(db)
        given = edit.model_dump(exclude_unset=True)

        if "displayName" in given:
            name = (given["displayName"] or "").strip()
            if not name:
                raise HTTPException(status_code=400, detail="a display name is required")
            other = await repository.by_display_name(name)
            if other is not None and other.id != row.id:
                raise HTTPException(
                    status_code=409, detail=f"{name!r} is already another trading client's name"
                )
            row.display_name = name
        if "broker" in given:
            row.broker = _broker(given["broker"])
        if "clientId" in given:
            client_id = (given["clientId"] or "").strip()
            if not client_id:
                raise HTTPException(status_code=400, detail="a client id is required")
            row.client_id = client_id
        if "broker" in given or "clientId" in given or creating:
            other = await repository.by_account(row.broker, row.client_id)
            if other is not None and other.id != row.id:
                raise HTTPException(
                    status_code=409,
                    detail=f"{row.broker}:{row.client_id} is already registered as "
                    f"{other.display_name!r}",
                )
        if "enabled" in given:
            row.enabled = bool(given["enabled"])
        if "apiKey" in given:
            row.api_key = (given["apiKey"] or "").strip() or None
        if "apiSecret" in given:
            row.api_secret_encrypted = secrets.seal(given["apiSecret"])
        if "staticIp" in given:
            row.static_ip = (given["staticIp"] or "").strip() or None
        if "isPro" in given:
            row.is_pro = bool(given["isPro"])
        if "useDealerApis" in given:
            row.use_dealer_apis = given["useDealerApis"]
        if "websocketEnabled" in given:
            row.websocket_enabled = bool(given["websocketEnabled"])
        if "usesCredentialsOf" in given:
            holder_id = (given["usesCredentialsOf"] or "").strip() or None
            if holder_id is not None:
                if holder_id == row.id:
                    raise HTTPException(
                        status_code=400, detail="an account cannot use its own credentials"
                    )
                holder = await repository.get(holder_id)
                if holder is None:
                    raise HTTPException(
                        status_code=404, detail=f"{holder_id!r} is not a trading client"
                    )
                if holder.broker != row.broker:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{holder.display_name} is on {holder.broker}, not {row.broker}; "
                        "a session only covers accounts at the same broker",
                    )
                if holder.uses_credentials_of:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{holder.display_name} itself logs in through another account; "
                        "name the account that actually logs in",
                    )
            row.uses_credentials_of = holder_id
        if "isMarketDataSource" in given:
            wanted = bool(given["isMarketDataSource"])
            if wanted and not row.is_market_data_source:
                # At most one, and the database enforces it; clearing the
                # previous one here is what lets the operator simply choose.
                await repository.update_where(
                    filters={"is_market_data_source": True}, is_market_data_source=False
                )
            row.is_market_data_source = wanted

    # -- the accounts --------------------------------------------------------

    @router.get("")
    async def list_clients(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        rows = await TradingClientsRepository(db).all(order_by="display_name")
        statuses = await _status_by_id(db)
        return ok([wire(row, statuses.get(row.id)) for row in rows], count=len(rows))

    @router.get("/{trading_client_id}")
    async def get_client(
        trading_client_id: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        return ok(await _served(db, await _row(db, trading_client_id)))

    @router.post("", status_code=201)
    async def create_client(body: NewClient, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        repository = TradingClientsRepository(db)
        base = slug(body.displayName)
        chosen = base
        suffix = 2
        while await repository.get(chosen) is not None:
            chosen = f"{base}-{suffix}"
            suffix += 1
        now = clock.now()
        row = models.TradingClientRow(
            id=chosen,
            display_name=body.displayName.strip(),
            broker=_broker(body.broker),
            client_id=body.clientId.strip(),
            created_at=now,
            updated_at=now,
        )
        await _apply(db, row, body, creating=True)
        repository.add(row)
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise HTTPException(status_code=409, detail=_integrity(error)) from None
        logger.info(
            "trading client created: %s (%s:%s)", row.display_name, row.broker, row.client_id
        )
        return ok(wire(row, None), message=f"{row.display_name} added")

    @router.put("/{trading_client_id}")
    async def update_client(
        trading_client_id: str, body: ClientEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _row(db, trading_client_id)
        await _apply(db, row, body, creating=False)
        row.updated_at = clock.now()
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise HTTPException(status_code=409, detail=_integrity(error)) from None
        return ok(await _served(db, row), message=f"{row.display_name} saved")

    @router.delete("/{trading_client_id}")
    async def delete_client(
        trading_client_id: str, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        row = await _row(db, trading_client_id)
        dependants = await TradingClientsRepository(db).find(uses_credentials_of=row.id)
        if dependants:
            raise HTTPException(
                status_code=409,
                detail=f"{row.display_name} cannot be deleted: "
                + ", ".join(d.display_name for d in dependants)
                + " log in through it",
            )
        await TradingClientsRepository(db).delete(row.id)
        try:
            await db.commit()
        except IntegrityError as error:
            await db.rollback()
            raise HTTPException(status_code=409, detail=_integrity(error)) from None
        logger.info("trading client deleted: %s", row.display_name)
        return ok(None, message=f"{row.display_name} removed")

    # -- logging in ----------------------------------------------------------

    @router.post("/{trading_client_id}/login")
    async def login(trading_client_id: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Start a login. Returns the URL the browser goes to.

        Always a redirect for the brokers supported here; the vendor sends
        the browser back to the callback, which completes the login.
        """
        row = await _row(db, trading_client_id)
        if row.uses_credentials_of:
            holder = await TradingClientsRepository(db).get(row.uses_credentials_of)
            raise HTTPException(
                status_code=400,
                detail=f"{row.display_name} logs in through "
                f"{holder.display_name if holder else row.uses_credentials_of}; log that one in",
            )
        if row.broker not in LOGIN_SUPPORTED:
            raise HTTPException(
                status_code=400,
                detail=f"logging in to {row.broker} is not built yet",
            )
        if not row.api_key or not row.api_secret_encrypted:
            raise HTTPException(
                status_code=400,
                detail=f"{row.display_name} has no API key and secret; set them first",
            )
        secret = secrets.open(row.api_secret_encrypted) or ""
        async with httpx.AsyncClient(timeout=30.0) as client:
            if row.broker == "ZERODHA":
                try:
                    credentials = ZerodhaCredentials(
                        client_id=row.client_id, api_key=row.api_key, api_secret=secret
                    )
                except DomainError as error:
                    raise HTTPException(status_code=400, detail=str(error)) from None
                url = ZerodhaAuth(credentials, clock, client).login_url()
            else:
                try:
                    start = await auth_for(
                        ProviderCredentials(
                            provider=row.broker.lower(),
                            api_key=row.api_key,
                            api_secret=secret,
                            client_id=row.client_id,
                            redirect_url=row.redirect_url,
                        ),
                        clock,
                        client,
                    ).begin()
                except ProviderLoginError as error:
                    raise HTTPException(status_code=400, detail=str(error)) from None
                url = start.url or ""
        return ok(
            {
                "loginStyle": "REDIRECT",
                "url": url,
                "callbackPath": callback_path(row.broker, row.id),
            }
        )

    @router.post("/{trading_client_id}/logout")
    async def logout(
        trading_client_id: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Forget the session. Trading on this account stops until the next login."""
        row = await _row(db, trading_client_id)
        await TradingClientLoginStatusRepository(db).update(
            row.id,
            is_login_success=False,
            access_token_encrypted=None,
            public_token_encrypted=None,
            request_token=None,
            session_created_on=None,
            updated_on=clock.now(),
        )
        await db.commit()
        # A provider may be borrowing this session; the feed carrying it is
        # finished and should say so now rather than when the socket times out.
        renew_after_login(request.app, row.broker.lower(), f"({row.display_name}) logged out")
        return ok(await _served(db, row), message=f"{row.display_name} logged out")

    return router


def _integrity(error: IntegrityError) -> str:
    text = str(error.orig) if error.orig is not None else str(error)
    if "uq_trading_clients_market_data_source" in text:
        return "another account is already the market data source"
    if "uq_trading_clients_account" in text:
        return "that broker account is already registered"
    if "display_name" in text:
        return "that display name is already taken"
    return "the change conflicts with another trading client"
