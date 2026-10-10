"""Data providers: who supplies ticks, quotes and candles, and their logins.

A trading client places orders; a data provider supplies prices. Where the
vendor issues one app key for both — Zerodha, Fyers, Dhan — a provider points
at a trading client instead of holding a second copy of its credentials, and
then there is one session: signing in from either page signs in both.

Two active settings, independent because they are independent choices: one
provider may stream ticks while another answers quotes and history.

**No automated login.** Every login here starts with the operator pressing a
button. For Zerodha, Fyers and Dhan that returns a URL for the browser and the
vendor calls back; for XTS and TrueData the call completes in place.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.api.envelope import ok
from garuda.marketdata.providers.auth import (
    REDIRECT_PROVIDERS,
    ProviderLoginError,
    auth_for,
)
from garuda.marketdata.providers.credentials import (
    KNOWN,
    OWN,
    PROVIDERS,
    SHAREABLE,
    TRADING_CLIENT,
    ProviderCredentials,
    check_pairing,
)
from garuda.persistence import models
from garuda.persistence.repositories import (
    DataProviderSessionsRepository,
    DataProvidersRepository,
    SystemConfigRepository,
    TradingClientLoginStatusRepository,
    TradingClientsRepository,
)
from garuda.persistence.secrets import SecretBox
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: Where the two choices live. Independent: ticks and history may come from
#: different providers.
ACTIVE_TICKER = "marketdata.active.ticker"
ACTIVE_HISTORY = "marketdata.active.history"

#: The reference market-data service's spacing, ported so behaviour matches.
#: Editable per provider from the page; these are only what a new row starts at.
DEFAULT_LIMITS: dict[str, tuple[int, int, int | None]] = {
    # provider: (quote_min_interval_ms, history_min_interval_ms, batch_size)
    "zerodha": (1000, 350, 200),
    "fyers": (1000, 350, 50),
    "dhan": (1000, 350, None),
    "xts": (500, 350, None),
    "truedata": (500, 350, None),
}


def _wire(row: models.DataProvidersRow, *, logged_in: bool, unusable: str | None) -> dict[str, Any]:
    return {
        "provider": row.provider,
        "enabled": row.enabled,
        "credentialSource": row.credential_source,
        "tradingClientId": row.trading_client_id,
        "apiKey": row.api_key,
        # Never the secret itself. The page shows whether one is stored so an
        # operator can tell "not set" from "set and hidden".
        "hasApiSecret": bool(row.api_secret_encrypted),
        "clientId": row.client_id,
        "redirectUrl": row.redirect_url,
        "websocketPort": row.websocket_port,
        "historyPort": row.history_port,
        "quoteMinIntervalMs": row.quote_min_interval_ms,
        "historyMinIntervalMs": row.history_min_interval_ms,
        "batchSize": row.batch_size,
        "loginStyle": "REDIRECT" if row.provider in REDIRECT_PROVIDERS else "DIRECT",
        "canBorrowTradingClient": row.provider in SHAREABLE,
        "isLoggedIn": logged_in,
        "unusableBecause": unusable,
        "updatedAt": row.updated_at.isoformat() if row.updated_at else None,
    }


class ProviderEdit(BaseModel):
    enabled: bool | None = None
    credentialSource: str | None = None  # noqa: N815 -- the Console's field names
    tradingClientId: str | None = None  # noqa: N815
    apiKey: str | None = None  # noqa: N815
    apiSecret: str | None = None  # noqa: N815
    clientId: str | None = None  # noqa: N815
    redirectUrl: str | None = None  # noqa: N815
    websocketPort: int | None = None  # noqa: N815
    historyPort: int | None = None  # noqa: N815
    quoteMinIntervalMs: int | None = None  # noqa: N815
    historyMinIntervalMs: int | None = None  # noqa: N815
    batchSize: int | None = None  # noqa: N815


class ActiveProviders(BaseModel):
    ticker: str | None = None
    history: str | None = None


def build(
    sessions: async_sessionmaker[AsyncSession],
    secrets: SecretBox,
    clock: Clock,
    *,
    console_url: str = "/console/data-providers",
    xts_base_url: str = "",
) -> APIRouter:
    router = APIRouter(tags=["data-providers"])

    async def session() -> Any:
        async with sessions() as open_session:
            yield open_session

    async def _setting(db: AsyncSession, key: str) -> str | None:
        return await _config(db).value_of(key)

    def _config(db: AsyncSession) -> SystemConfigRepository:
        return SystemConfigRepository(db)

    async def _logged_in(db: AsyncSession, row: models.DataProvidersRow) -> bool:
        """One question, two places to look — which is the point.

        A borrowed provider has no session of its own; it reports the trading
        client's, so the Console cannot show it logged out while the Trading
        Clients page shows it in.
        """
        if row.credential_source == TRADING_CLIENT and row.trading_client_id:
            status = await TradingClientLoginStatusRepository(db).get(row.trading_client_id)
            return bool(status and status.access_token_encrypted)
        stored = await DataProviderSessionsRepository(db).get(row.provider)
        return stored is not None

    async def _credentials(db: AsyncSession, row: models.DataProvidersRow) -> ProviderCredentials:
        if row.credential_source == TRADING_CLIENT:
            if not row.trading_client_id:
                raise HTTPException(
                    status_code=400,
                    detail=f"{row.provider} is set to use a trading client but names none",
                )
            account = await TradingClientsRepository(db).get(row.trading_client_id)
            if account is None:
                raise HTTPException(
                    status_code=404,
                    detail=f"{row.provider} names trading client "
                    f"{row.trading_client_id!r}, which does not exist",
                )
            if not account.api_key:
                raise HTTPException(
                    status_code=400,
                    detail=f"trading client {row.trading_client_id} has no API key to borrow",
                )
            secret = secrets.open(account.api_secret_encrypted) or ""
            return ProviderCredentials(
                provider=row.provider,
                api_key=account.api_key,
                api_secret=secret,
                client_id=account.client_id,
                redirect_url=account.redirect_url,
                borrowed_from=None,
            )

        if not row.api_key:
            raise HTTPException(status_code=400, detail=f"{row.provider} has no API key")
        secret = secrets.open(row.api_secret_encrypted) or ""
        if not secret:
            raise HTTPException(status_code=400, detail=f"{row.provider} has no API secret")
        return ProviderCredentials(
            provider=row.provider,
            api_key=row.api_key,
            api_secret=secret,
            client_id=row.client_id,
            redirect_url=row.redirect_url,
            websocket_port=row.websocket_port,
            history_port=row.history_port,
        )

    # -- configuration ------------------------------------------------------

    @router.get("/api/data-providers")
    async def list_providers(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Every provider this engine knows, configured or not.

        Rows that do not exist yet are returned as unconfigured rather than
        omitted, so the page lists what is possible instead of only what has
        been set up.

        Served in :data:`PROVIDERS` order rather than alphabetically, and the
        Console renders what it is given: the order is a fact about which
        providers matter, which the server knows and the page does not.
        """
        rows = {row.provider: row for row in await DataProvidersRepository(db).all()}
        out = []
        for name in PROVIDERS:
            row = rows.get(name)
            if row is None:
                quote, history, batch = DEFAULT_LIMITS[name]
                out.append(
                    {
                        "provider": name,
                        "enabled": False,
                        "credentialSource": TRADING_CLIENT if name in SHAREABLE else OWN,
                        "tradingClientId": None,
                        "apiKey": None,
                        "hasApiSecret": False,
                        "clientId": None,
                        "redirectUrl": None,
                        "websocketPort": None,
                        "historyPort": None,
                        "quoteMinIntervalMs": quote,
                        "historyMinIntervalMs": history,
                        "batchSize": batch,
                        "loginStyle": "REDIRECT" if name in REDIRECT_PROVIDERS else "DIRECT",
                        "canBorrowTradingClient": name in SHAREABLE,
                        "isLoggedIn": False,
                        "unusableBecause": "not configured",
                        "updatedAt": None,
                        "isConfigured": False,
                    }
                )
                continue
            wire = _wire(
                row,
                logged_in=await _logged_in(db, row),
                unusable=None if row.enabled else "not enabled",
            )
            wire["isConfigured"] = True
            out.append(wire)
        return ok(out)

    @router.get("/api/data-providers/active")
    async def active(db: AsyncSession = Depends(session)) -> dict[str, Any]:
        return ok(
            {
                "ticker": await _setting(db, ACTIVE_TICKER),
                "history": await _setting(db, ACTIVE_HISTORY),
            }
        )

    @router.put("/api/data-providers/active")
    async def set_active(
        body: ActiveProviders, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Choose who streams and who answers. Independent choices.

        A provider that is not enabled is refused: selecting one would stop
        market data with no indication of why, which is the failure this whole
        page exists to make visible.
        """
        sent = body.model_dump(exclude_unset=True)
        providers = DataProvidersRepository(db)
        for field, key in (("ticker", ACTIVE_TICKER), ("history", ACTIVE_HISTORY)):
            if field not in sent:
                continue
            chosen = sent[field]
            if chosen:
                row = await providers.get(chosen)
                if row is None or not row.enabled:
                    raise HTTPException(
                        status_code=400,
                        detail=f"{chosen} is not an enabled provider, so it cannot be the "
                        f"active {field}",
                    )
            await _config(db).put(key, chosen or "", clock.now())
        await db.commit()
        return ok(
            {
                "ticker": await _setting(db, ACTIVE_TICKER),
                "history": await _setting(db, ACTIVE_HISTORY),
            },
            message="active providers saved",
        )

    @router.get("/api/data-providers/{provider}/borrowable")
    async def borrowable(provider: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        """Trading clients this provider could take its credentials from.

        Narrowed to the same broker and to accounts that actually have an app
        key: offering one without a key would let an operator choose something
        that cannot log in, and the failure would arrive later as "no market
        data" rather than here as "that account has no key".
        """
        name = provider.strip().lower()
        if name not in SHAREABLE:
            return ok([])
        rows = await TradingClientsRepository(db).find(order_by="display_name")
        return ok(
            [
                {
                    "id": row.id,
                    "displayName": row.display_name,
                    "clientId": row.client_id,
                    "broker": row.broker,
                }
                for row in rows
                if row.broker.lower() == name and row.api_key
            ]
        )

    @router.put("/api/data-providers/{provider}")
    async def configure(
        provider: str, body: ProviderEdit, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Create or update a provider's configuration.

        An impossible pairing is refused here rather than discovered when the
        feed will not start -- TrueData borrowing a trading client it has no
        trading side for, or XTS borrowing one whose key its market-data API
        will not accept.
        """
        name = provider.strip().lower()
        if name not in KNOWN:
            raise HTTPException(
                status_code=404, detail=f"{provider} is not a provider this engine knows"
            )

        providers = DataProvidersRepository(db)
        row = await providers.get(name)
        sent = body.model_dump(exclude_unset=True)

        source = sent.get("credentialSource") or (
            row.credential_source if row else (TRADING_CLIENT if name in SHAREABLE else OWN)
        )
        source = source.strip().upper()
        trading_client = sent.get("tradingClientId", row.trading_client_id if row else None)
        if source == OWN:
            trading_client = None

        # A provider that is not enabled is a draft: an operator fills the form
        # in the order the form asks, and refusing every save until it is
        # complete would make it unfillable. Enabling is the point at which it
        # has to make sense, and it is enabling that would otherwise put a
        # provider in front of the engine that cannot work.
        will_be_enabled = bool(sent.get("enabled", row.enabled if row else False))
        if will_be_enabled:
            try:
                check_pairing(name, source, trading_client)
            except Exception as error:
                raise HTTPException(status_code=400, detail=str(error)) from None
        elif source not in (TRADING_CLIENT, OWN):
            raise HTTPException(
                status_code=400,
                detail=f"credential source must be {TRADING_CLIENT} or {OWN}, not {source!r}",
            )

        if trading_client and await TradingClientsRepository(db).get(trading_client) is None:
            raise HTTPException(status_code=404, detail=f"no trading client {trading_client!r}")

        for field in ("quoteMinIntervalMs", "historyMinIntervalMs"):
            if sent.get(field) is not None and sent[field] < 0:
                raise HTTPException(status_code=400, detail=f"{field} cannot be negative")

        quote, history, batch = DEFAULT_LIMITS[name]
        values: dict[str, Any] = {
            "credential_source": source,
            "trading_client_id": trading_client,
            "updated_at": clock.now(),
        }
        simple = {
            "enabled": "enabled",
            "apiKey": "api_key",
            "clientId": "client_id",
            "redirectUrl": "redirect_url",
            "websocketPort": "websocket_port",
            "historyPort": "history_port",
            "quoteMinIntervalMs": "quote_min_interval_ms",
            "historyMinIntervalMs": "history_min_interval_ms",
            "batchSize": "batch_size",
        }
        for wire, column in simple.items():
            if wire in sent:
                values[column] = sent[wire]
        if "apiSecret" in sent:
            # An empty string means "clear it"; absent means "leave it".
            values["api_secret_encrypted"] = secrets.seal(sent["apiSecret"])
        if source == OWN and "apiKey" not in sent and row is None:
            values.setdefault("api_key", None)

        if row is None:
            row = models.DataProvidersRow(
                provider=name,
                enabled=values.pop("enabled", False),
                quote_min_interval_ms=values.pop("quote_min_interval_ms", quote),
                history_min_interval_ms=values.pop("history_min_interval_ms", history),
                batch_size=values.pop("batch_size", batch),
                created_at=clock.now(),
                **values,
            )
            providers.add(row)
        else:
            await providers.update(name, **values)
        await db.commit()
        saved = await providers.require(name)
        return ok(
            _wire(saved, logged_in=await _logged_in(db, saved), unusable=None),
            message=f"{name} saved",
        )

    @router.delete("/api/data-providers/{provider}")
    async def forget(provider: str, db: AsyncSession = Depends(session)) -> dict[str, Any]:
        name = provider.strip().lower()
        for key in (ACTIVE_TICKER, ACTIVE_HISTORY):
            if await _setting(db, key) == name:
                raise HTTPException(
                    status_code=409,
                    detail=f"{name} is the active {key.rsplit('.', 1)[-1]} provider; "
                    "choose another before removing it",
                )
        if not await DataProvidersRepository(db).delete(name):
            raise HTTPException(status_code=404, detail=f"{name} is not configured")
        await db.commit()
        return ok(None, message=f"{name} removed")

    # -- logging in ---------------------------------------------------------

    @router.post("/api/data-providers/{provider}/login")
    async def login(
        provider: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        """Start a login. Always operator-initiated.

        Returns a URL for the browser where the vendor uses a redirect, and a
        completed session where it does not.
        """
        name = provider.strip().lower()
        row = await DataProvidersRepository(db).get(name)
        if row is None:
            raise HTTPException(status_code=404, detail=f"{name} is not configured")
        if not row.enabled:
            raise HTTPException(status_code=400, detail=f"{name} is not enabled")

        credentials = await _credentials(db, row)
        async with httpx.AsyncClient(timeout=30.0) as client:
            auth = auth_for(credentials, clock, client, xts_base_url=xts_base_url)
            try:
                start = await auth.begin()
            except ProviderLoginError as error:
                raise HTTPException(status_code=400, detail=str(error)) from None

        if start.needs_browser:
            owner = row.trading_client_id if row.credential_source == TRADING_CLIENT else "provider"
            return ok(
                {
                    "loginStyle": "REDIRECT",
                    "url": start.url,
                    "callbackPath": f"/api/auth/callback/{name}/{owner}",
                }
            )

        assert start.session is not None
        await _store(db, name, start.session.access_token, start.session.client_id)
        await db.commit()
        await _renew_feed(request, name, "logged in")
        return ok({"loginStyle": "DIRECT", "isLoggedIn": True}, message=f"{name} logged in")

    @router.post("/api/data-providers/{provider}/logout")
    async def logout(
        provider: str, request: Request, db: AsyncSession = Depends(session)
    ) -> dict[str, Any]:
        name = provider.strip().lower()
        await DataProviderSessionsRepository(db).delete(name)
        await db.commit()
        # The token is gone, so the socket carrying it is finished. Dropping it
        # here rather than leaving it to time out means the Console shows the
        # provider as logged out and priceless in one step, instead of logged
        # out while prices keep arriving for another minute.
        await _renew_feed(request, name, "logged out")
        return ok(None, message=f"{name} logged out")

    async def _store(db: AsyncSession, provider: str, token: str, client_id: str | None) -> None:
        sealed = secrets.seal(token)
        assert sealed is not None
        await DataProviderSessionsRepository(db).upsert(
            {
                "provider": provider,
                "client_id": client_id,
                "access_token_encrypted": sealed,
                "obtained_at": clock.now(),
            },
            conflict_on=("provider",),
        )

    async def _renew_feed(request: Request, provider: str, why: str) -> None:
        """Tell the running engine its credentials changed.

        A feed built with an expired token keeps its socket open and carries
        nothing, and the supervisor -- seeing a connected feed -- correctly
        leaves it alone. So a login has to say so explicitly. The reference
        service does the same, stopping its ticker on a manual login or a
        provider switch rather than waiting for a throttle to expire.

        Never raises. The session is already stored and that is the part that
        matters; a feed that did not come back is retried by the monitor.
        """
        engine = getattr(request.app.state, "engine", None)
        market_data = getattr(getattr(engine, "parts", None), "market_data", None)
        if market_data is None:
            # No engine in this process, or nothing nominated for ticks.
            return
        try:
            await market_data.reconnect(f"{provider} {why}")
        except Exception:
            logger.exception("%s: could not replace the feed after %s", provider, why)

    # -- the callback -------------------------------------------------------

    @router.get("/api/auth/callback/{provider}/{owner}")
    async def callback(
        provider: str,
        owner: str,
        request: Request,
        db: AsyncSession = Depends(session),
        request_token: str | None = None,
        auth_code: str | None = None,
        tokenId: str | None = None,  # noqa: N803 -- Dhan's parameter name
        code: str | None = None,
    ) -> RedirectResponse:
        """Where the vendor sends the operator's browser back.

        The identity is in the path because Kite Connect has no `state`
        parameter to carry it, and the same shape is used for every provider so
        an operator registers one kind of URL. `owner` is the trading client
        whose app this is, or the literal `provider` when the provider holds
        its own credentials.

        This answers with a redirect rather than JSON: a browser is reading it.
        """
        name = provider.strip().lower()
        supplied = request_token or auth_code or tokenId or code or ""
        row = await DataProvidersRepository(db).get(name)
        if row is None:
            return RedirectResponse(f"{console_url}?login={name}&error=not+configured")

        try:
            credentials = await _credentials(db, row)
            async with httpx.AsyncClient(timeout=30.0) as client:
                auth = auth_for(credentials, clock, client, xts_base_url=xts_base_url)
                session_out = await auth.complete(supplied)
        except (ProviderLoginError, HTTPException) as error:
            detail = getattr(error, "detail", None) or str(error)
            return RedirectResponse(f"{console_url}?login={name}&error={detail}")

        del owner  # the path segment identifies the app; the row is the record
        await _store(db, name, session_out.access_token, session_out.client_id)
        await db.commit()
        # Before the redirect, so the Console reloads onto a feed that is
        # already coming up with the new token rather than one still carrying
        # nothing on the old.
        await _renew_feed(request, name, "completed its login")
        return RedirectResponse(f"{console_url}?login={name}&ok=1")

    return router
