"""The audit log's writer: every operator mutation, recorded once it succeeded.

A pure ASGI middleware rather than Starlette's convenience base, which runs
the application in a task of its own. The capture is a context variable;
it has to be set in the very context the routes run in.

What a request changed comes from the repositories, which record each
write on the request's capture (:mod:`garuda.persistence.audit`). Once the
response has gone out with a success status, the capture becomes rows,
stamped with who asked -- the signed-in admin, read from the token -- and
when. A refused request changed nothing and writes nothing. The write
itself never fails the request: an audit table that is down costs the row,
never the order, which is the breach log's rule too.

The buttons that change the engine without touching a row -- start the
feed, square off an account, fetch a file -- are recorded from the path,
so the log says the operator pressed them.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from garuda.api.tokens import read
from garuda.persistence import models
from garuda.persistence.audit import (
    AuditAction,
    Change,
    close_capture,
    open_capture,
    snapshot,
)
from garuda.protocols.clock import Clock

logger = logging.getLogger(__name__)

#: The buttons: a POST whose last path segment is one of these, and which
#: wrote no row, is still an operator action worth a line.
BUTTONS: dict[str, AuditAction] = {
    "start": AuditAction.START,
    "stop": AuditAction.STOP,
    "restart": AuditAction.RESTART,
    "square-off": AuditAction.SQUARE_OFF,
    "download": AuditAction.DOWNLOAD,
    "run-phase": AuditAction.RUN,
}

#: The route prefix to the entity a button acts on.
BUTTON_ENTITIES: dict[str, str] = {
    "market-data": "MARKET_DATA",
    "terminal": "TERMINAL",
    "trading-clients": "TRADING_CLIENT",
    "data-providers": "DATA_PROVIDER",
    "brokers": "BROKER",
    "system-status": "ENGINE",
}

MUTATING = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def button_press(method: str, path: str, body: bytes) -> Change | None:
    """A button's press as a change, or None when the path is not a button."""
    if method != "POST":
        return None
    parts = [part for part in path.split("/") if part]
    if len(parts) < 3 or parts[0] != "api":
        return None
    action = BUTTONS.get(parts[-1])
    if action is None:
        return None
    entity = BUTTON_ENTITIES.get(parts[1], parts[1].replace("-", "_").upper())
    target = parts[-2] if len(parts) > 3 else parts[1]
    payload: dict[str, Any] | None = None
    if body:
        try:
            decoded = json.loads(body)
            payload = snapshot(decoded) if isinstance(decoded, dict) else {"body": decoded}
        except ValueError:
            payload = {"body": body.decode("utf-8", "replace")}
    return Change(
        table=entity.lower(),
        action=action,
        key_columns=["target"],
        after={"target": target, **(payload or {})},
    )


class AuditMiddleware:
    """Opens a capture per request and writes it once the response succeeded."""

    def __init__(
        self,
        app: ASGIApp,
        *,
        sessions: async_sessionmaker[AsyncSession],
        secret: str,
        clock: Clock,
        admin_username: str,
    ) -> None:
        self._app = app
        self._sessions = sessions
        self._secret = secret
        self._clock = clock
        self._admin = admin_username

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self._app(scope, receive, send)
            return

        capture, token = open_capture()
        status: list[int] = []
        body = bytearray()
        method = scope.get("method", "GET")

        async def receiving() -> Message:
            message = await receive()
            if method in MUTATING and message.get("type") == "http.request":
                body.extend(message.get("body", b""))
            return message

        async def sending(message: Message) -> None:
            if message.get("type") == "http.response.start":
                status.append(int(message["status"]))
            await send(message)

        try:
            await self._app(scope, receiving, sending)
        finally:
            close_capture(token)

        if not status or not 200 <= status[0] < 400:
            return
        path = scope.get("path", "")
        changes = capture.resolved()
        if not changes and not path.startswith("/api/auth/"):
            pressed = button_press(method, path, bytes(body))
            if pressed is not None:
                changes = [pressed]
        if changes:
            await self._write(changes, self._who(scope))

    def _who(self, scope: Scope) -> str:
        for name, value in scope.get("headers", ()):
            if name == b"authorization":
                token = value.decode("latin-1").removeprefix("Bearer ").strip()
                claims = read(token, self._secret) if token else None
                if claims and claims.get("username"):
                    return str(claims["username"])
        return self._admin

    async def _write(self, changes: list[Change], who: str) -> None:
        now = self._clock.now()
        rows = [
            models.AuditLogRow(
                entity_type=change.entity_type,
                entity_id=change.entity_id,
                entity_name=change.entity_name,
                action=change.effective_action.value,
                old_data=change.old_json(),
                new_data=change.new_json(),
                changed_by=who,
                changed_timestamp=now,
            )
            for change in changes
        ]
        try:
            async with self._sessions() as db:
                db.add_all(rows)
                await db.commit()
        except Exception:
            logger.exception(
                "could not write %d audit row(s); the change itself went through", len(rows)
            )


def install(
    app: Any,
    *,
    sessions: async_sessionmaker[AsyncSession],
    secret: str,
    clock: Clock,
    admin_username: str,
) -> None:
    app.add_middleware(
        AuditMiddleware,
        sessions=sessions,
        secret=secret,
        clock=clock,
        admin_username=admin_username,
    )


__all__ = ["AuditMiddleware", "button_press", "install"]
