"""The HTTP surface the Console talks to.

Deliberately small so far: enough to sign in and load the Console shell. Every
page beyond that still calls endpoints that do not exist, and each one is
built with the page that needs it rather than as an API tier ahead of any of
them -- see `docs/API_AND_CONSOLE.md`.

Mounted at `/api/v2` because that is what the copied Console calls. Responses
carry the `{success, data}` envelope its client interceptor unwraps.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from garuda.api.credentials import AdminCredentials
from garuda.api.envelope import failed, ok
from garuda.api.tokens import issue, read
from garuda.config.settings import Settings, load_settings
from garuda.core.clock import LiveClock
from garuda.persistence.engine import create_engine, create_session_factory

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


def create_app(settings: Settings | None = None) -> FastAPI:
    """The application, and the one identity that signs in to it."""
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

    @app.exception_handler(HTTPException)
    async def refuse(request: Request, error: HTTPException) -> JSONResponse:
        """Refusals in the envelope too, so the Console reads the message."""
        del request
        return JSONResponse(status_code=error.status_code, content=failed(str(error.detail)))

    @app.on_event("startup")
    async def first_run() -> None:
        await admin.ensure()

    @app.get("/api/v2/public/config")
    async def public_config() -> dict[str, Any]:
        """What the Console needs before anyone has signed in."""
        return ok(
            {
                "supportedBrokers": ["ZERODHA"],
                "features": {},
                "tradingMode": "BOTH",
            }
        )

    @app.post("/api/v2/auth/local/login")
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

    @app.post("/api/v2/auth/local/change-password")
    async def change_password(
        request: ChangePasswordRequest,
        claims: dict[str, Any] = Depends(signed_in),
    ) -> dict[str, Any]:
        del claims  # one identity; being signed in is the whole check
        refusal = await admin.change(request.currentPassword, request.newPassword)
        if refusal is not None:
            raise HTTPException(status_code=400, detail=refusal)
        return ok(None, message="password changed")

    @app.get("/api/v2/auth/local/profile")
    async def profile(claims: dict[str, Any] = Depends(signed_in)) -> dict[str, Any]:
        return ok(
            {
                "username": claims["username"],
                "fullName": claims.get("full_name", ""),
                "email": claims.get("email", ""),
                "role": claims.get("role_code", "ADMIN"),
            }
        )

    @app.get("/api/v2/health")
    async def health() -> dict[str, Any]:
        return ok({"status": "ok"})

    return app
