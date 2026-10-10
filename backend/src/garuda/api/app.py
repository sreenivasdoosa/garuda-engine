"""The HTTP surface the Console talks to.

Deliberately small so far: enough to sign in and load the Console shell. Every
page beyond that still calls endpoints that do not exist, and each one is
built with the page that needs it rather than as an API tier ahead of any of
them -- see `docs/API_AND_CONSOLE.md`.

Everything is mounted under a flat `/api`. The Console was copied from an
engine that shipped `/apis` (v1) and `/api/v2` side by side and had to name
which one it meant; there is one API here, so a version in the path says
nothing. Responses carry the `{success, data}` envelope the Console's client
interceptor unwraps.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from garuda.api import envelope
from garuda.api.credentials import AdminCredentials
from garuda.api.envelope import ok
from garuda.api.routers import (
    data_providers,
    event_days,
    exchanges,
    holidays,
    market_data,
    socket,
    special_trading_days,
    symbols,
    ticker,
    trading_clients,
    universes,
)
from garuda.api.tokens import issue, read
from garuda.config.settings import Settings, load_settings
from garuda.core.clock import LiveClock
from garuda.persistence.engine import create_engine, create_session_factory
from garuda.persistence.secrets import SecretBox

logger = logging.getLogger(__name__)

#: Where the Console runs in development. In production it is served from the
#: same origin and this list is irrelevant.
DEV_ORIGINS = ("http://localhost:5173", "http://127.0.0.1:5173")


class LoginRequest(BaseModel):
    username: str
    password: str


class ChangePasswordRequest(BaseModel):
    currentPassword: str  # noqa: N815 -- the Console's field name
    newPassword: str  # noqa: N815


def create_app(
    settings: Settings | None = None,
    engine: Any = None,
    reload_symbols: Any = None,
    reload_sessions: Any = None,
) -> FastAPI:
    """The application, and the one identity that signs in to it.

    ``engine`` is the *running* engine, when the API is being served in the
    same process as it -- which is how an operator runs garuda. It is reachable
    to routes as ``request.app.state.engine`` and is what lets the Console see
    live prices at all: a tick lives in the hub for a moment and is never
    written anywhere another process could read it in time.

    None means the API is being served on its own. Everything backed by a
    table still works; nothing backed by the feed does, and the routes that
    need it say so rather than hanging.

    ``reload_symbols`` is an awaitable the composition root supplies, called
    after the Symbols page writes. It is injected rather than imported because
    reloading means reading rows into domain objects and swapping the engine's
    book -- work that lives above this layer, which may not reach up into it.
    Without it, enabling a derived series writes a row and changes nothing
    until a restart.
    """
    config = settings or load_settings()
    secret = config.jwt_secret.get_secret_value() or config.secret_key.get_secret_value()
    if not secret:
        raise RuntimeError(
            "no JWT secret configured; sessions cannot be signed. Set GARUDA_JWT_SECRET."
        )

    sessions = create_session_factory(create_engine(config.database))
    admin = AdminCredentials(
        sessions, LiveClock(), first_run_password=config.admin_password.get_secret_value()
    )

    app = FastAPI(title="Garuda Engine", docs_url="/api/docs", openapi_url="/api/openapi.json")
    # Set even when it is None, so a route reads one attribute rather than
    # asking whether the attribute exists.
    app.state.engine = engine
    app.state.reload_symbols = reload_symbols
    # Same idea as ``reload_symbols``: a login writes a session row, and the
    # engine's resolver re-reads it rather than learning of it at restart.
    app.state.reload_sessions = reload_sessions
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(DEV_ORIGINS),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    def signed_in(authorization: str | None = Header(default=None)) -> dict[str, Any]:
        """The claims of whoever is asking, or a refusal.

        Wired as a default rather than through `Annotated`. This module has
        postponed annotations, so `Annotated[..., Depends(signed_in)]` is a
        string that FastAPI resolves against module globals -- and this is a
        closure, which is not in them. The parameter then reads as an
        unsatisfied query parameter and every request fails asking for
        `claims`.
        """
        token = (authorization or "").removeprefix("Bearer ").strip()
        claims = read(token, secret) if token else None
        if claims is None:
            raise HTTPException(status_code=401, detail="not signed in")
        return claims

    envelope.install(app)

    @app.on_event("startup")
    async def first_run() -> None:
        await admin.ensure()

    @app.get("/api/config")
    async def public_config() -> dict[str, Any]:
        """What the Console needs before anyone has signed in."""
        return ok(
            {
                "supportedBrokers": ["ZERODHA"],
                "features": {},
                "tradingMode": "BOTH",
            }
        )

    @app.post("/api/auth/login")
    async def login(request: LoginRequest) -> dict[str, Any]:
        if request.username != config.admin_username or not await admin.matches(request.password):
            # One message for both, so a wrong username and a wrong password
            # are indistinguishable from outside.
            raise HTTPException(status_code=401, detail="that username and password do not match")

        logger.info("admin signed in")
        return ok(
            {
                "accessToken": issue(config.admin_username, secret),
                "tokenType": "Bearer",
                "username": config.admin_username,
                "fullName": "Administrator",
                "email": "",
                "role": "ADMIN",
            }
        )

    @app.post("/api/auth/change-password")
    async def change_password(
        request: ChangePasswordRequest,
        claims: dict[str, Any] = Depends(signed_in),
    ) -> dict[str, Any]:
        del claims  # one identity; being signed in is the whole check
        refusal = await admin.change(request.currentPassword, request.newPassword)
        if refusal is not None:
            raise HTTPException(status_code=400, detail=refusal)
        return ok(None, message="password changed")

    @app.get("/api/auth/profile")
    async def profile(claims: dict[str, Any] = Depends(signed_in)) -> dict[str, Any]:
        return ok(
            {
                "username": claims["username"],
                "fullName": claims.get("full_name", ""),
                "email": claims.get("email", ""),
                "role": claims.get("role_code", "ADMIN"),
            }
        )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return ok({"status": "ok"})

    # One router per Console page, added as each page is made to work.
    app.include_router(exchanges.build(sessions))
    app.include_router(holidays.build(sessions))
    app.include_router(special_trading_days.build(sessions))
    app.include_router(event_days.build(sessions))
    app.include_router(symbols.build(sessions))
    app.include_router(universes.build(sessions, LiveClock()))
    secrets = SecretBox(config.secret_key.get_secret_value())
    app.include_router(trading_clients.build(sessions, secrets, LiveClock()))
    app.include_router(data_providers.build(sessions, secrets, LiveClock()))
    # One socket for everything the Console streams. Registered whether or not
    # an engine is attached: without one it accepts, says there are no prices
    # and closes, which is a far clearer answer than a route that is not there.
    app.include_router(market_data.build(sessions, LiveClock()))
    app.include_router(ticker.build())
    app.include_router(socket.build(secret))

    return app
