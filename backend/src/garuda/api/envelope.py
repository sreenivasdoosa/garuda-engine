"""The shape every response takes.

The Console unwraps `{success, data, ...}` in one interceptor and hands the
`data` to the page, so every endpoint answers in that shape or the page gets
the envelope instead of its payload. One helper, used everywhere, because the
alternative is remembering.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from garuda.core.clock import LiveClock
from garuda.protocols.clock import Clock

#: Whose idea of "now" the `timestamp` field carries. A response timestamp is
#: presentation metadata rather than engine state, but it still goes through the
#: Clock: `datetime.now()` is banned everywhere outside `core/clock.py`, and the
#: ban is worth more than the one exemption would save.
_clock: Clock = LiveClock()


def use_clock(clock: Clock) -> None:
    """Point the envelope's timestamps at a different clock. For tests."""
    global _clock
    _clock = clock


def ok(data: Any, *, message: str | None = None, count: int | None = None) -> dict[str, Any]:
    """A successful response, in the shape the Console expects."""
    body: dict[str, Any] = {
        "success": True,
        "data": data,
        "timestamp": _clock.now().isoformat(),
    }
    if message is not None:
        body["message"] = message
    if count is not None:
        body["count"] = count
    return body


def failed(message: str) -> dict[str, Any]:
    """A refusal. The Console raises the message as the error."""
    return {
        "success": False,
        "data": None,
        "message": message,
        "timestamp": _clock.now().isoformat(),
    }


def install(app: FastAPI) -> None:
    """Make refusals wear the envelope too.

    Registered here rather than in `create_app` so it travels with the shape
    itself. It did live there, and the cost was that any app mounting a router
    without going through that factory answered a refusal with FastAPI's bare
    `{"detail": ...}` -- which the Console's interceptor reads as a successful
    response with no data.
    """

    @app.exception_handler(HTTPException)
    async def refuse(request: Request, error: HTTPException) -> JSONResponse:
        del request
        return JSONResponse(status_code=error.status_code, content=failed(str(error.detail)))

    @app.exception_handler(RequestValidationError)
    async def malformed(request: Request, error: RequestValidationError) -> JSONResponse:
        """A body FastAPI could not parse. Its own 422 is a list of locations;
        the Console shows a message, so it gets the first one flattened."""
        del request
        first = error.errors()[0] if error.errors() else {}
        where = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
        detail = first.get("msg", "could not read the request body")
        message = f"{where}: {detail}" if where else str(detail)
        return JSONResponse(status_code=400, content=failed(message))
