"""The shape every response takes.

The Console unwraps `{success, data, ...}` in one interceptor and hands the
`data` to the page, so every endpoint answers in that shape or the page gets
the envelope instead of its payload. One helper, used everywhere, because the
alternative is remembering.
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any


def ok(data: Any, *, message: str | None = None, count: int | None = None) -> dict[str, Any]:
    """A successful response, in the shape the Console expects."""
    body: dict[str, Any] = {
        "success": True,
        "data": data,
        "timestamp": datetime.now(UTC).isoformat(),
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
        "timestamp": datetime.now(UTC).isoformat(),
    }
