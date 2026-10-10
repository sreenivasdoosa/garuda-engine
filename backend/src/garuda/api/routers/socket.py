"""The one socket the Console talks over.

**One connection, many channels.** A browser opens `/socket` once and says
which channels it wants; everything the Console streams -- ticks now, the
Terminal's summaries, positions and alerts as they arrive -- comes back down
it. The alternative, a socket per feature, means a browser holding four
connections that each re-authenticate, reconnect and back off independently,
and an engine fanning out to four times as many sockets as there are people
watching.

**A slow browser must never stall the engine.** Every subscription here is
drop-oldest by policy: a laptop that has been asleep gets the current price
when it wakes, not a queue of ten thousand stale ones. The reference engine
froze its entire summary broadcaster on one half-dead client, which is the
failure this shape exists to avoid.

**The Terminal channel is summaries and alerts.** Every account's standing
is recomputed from the engine's book every few seconds and only the rows
that changed are sent; an alert is sent the moment it is raised.

**Reading and writing are separate tasks.** A client that never sends another
frame must still receive; a client that floods must not block the sender. They
meet only at the socket closing, which cancels both.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Iterable
from datetime import timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect, status

from garuda.api.routers.terminal import alert_wire, summary_wire
from garuda.api.tokens import read
from garuda.domain.alert import Alert
from garuda.domain.market import Tick
from garuda.protocols.topics import Topic

logger = logging.getLogger(__name__)

#: What a browser may ask for. Named rather than open so a typo is refused
#: loudly instead of subscribing to silence.
TICKS = "ticks"
TERMINAL = "terminal"
CHANNELS = frozenset({TICKS, TERMINAL})

#: How long to wait for the engine before answering that there are no prices.
#: Nothing is retried: the Console reconnects on its own schedule.
_SEND_TIMEOUT_SECONDS = 5.0

#: How often the Terminal's summaries are recomputed and compared. The
#: reference's broadcaster ran at this cadence.
SUMMARY_INTERVAL = timedelta(seconds=2.5)


def _summaries(view: Any) -> list[dict[str, Any]]:
    try:
        return [summary_wire(row) for row in view.summaries()]
    except Exception:
        logger.exception("the terminal summaries could not be computed")
        return []


def _without_time(row: dict[str, Any] | None) -> dict[str, Any] | None:
    """A row minus its timestamp, for telling a change from a tick of the clock."""
    if row is None:
        return None
    return {key: value for key, value in row.items() if key != "asOf"}


def tick_payload(tick: Tick) -> dict[str, Any]:
    """One tick, in the shape the Console already reads.

    Money is sent as a string, not a float. A price that survives the engine as
    an exact decimal and then arrives in a browser as 123.44999999999999 has
    been corrupted at the last possible moment, and every number the Console
    shows is one it got from here.
    """
    return {
        "type": "tick",
        "tick": {
            "instrument": tick.instrument.value,
            "lastPrice": _number(tick.last_price.amount),
            "timestamp": tick.timestamp.isoformat(),
            "open": _money(tick.open),
            "high": _money(tick.high),
            "low": _money(tick.low),
            "previousClose": _money(tick.previous_close),
            "volume": tick.volume,
            "openInterest": tick.open_interest,
            "isSynthetic": tick.is_synthetic,
        },
    }


def _money(value: Any) -> str | None:
    return None if value is None else _number(value.amount)


def _number(value: Decimal) -> str:
    return str(value)


def _requested(frame: str) -> set[str] | None:
    """The channels a client frame asks for, or None if it asks nothing.

    Unknown names are dropped with a log rather than refused: a Console built
    against a later engine will ask for channels this one has not got, and
    closing the socket over it would take the channels that do work with it.
    """
    try:
        message = json.loads(frame)
    except ValueError:
        logger.debug("socket: ignoring a frame that is not JSON")
        return None
    if not isinstance(message, dict) or message.get("method") != "subscribe":
        return None
    asked = message.get("subList")
    if not isinstance(asked, list):
        return None
    wanted = {str(name) for name in asked}
    unknown = wanted - CHANNELS
    if unknown:
        logger.info("socket: no such channel(s): %s", ", ".join(sorted(unknown)))
    return wanted & CHANNELS


def build(secret: str) -> APIRouter:
    """The socket route, closing over the secret its tokens are signed with."""
    router = APIRouter()

    @router.websocket("/socket")
    async def socket(
        websocket: WebSocket,
        token: str | None = Query(default=None),
        clientId: str | None = Query(default=None),  # noqa: N803 -- the Console's name
    ) -> None:
        """Stream to one browser for as long as it is listening."""
        supplied = token or websocket.cookies.get("ws_access_token") or ""
        if read(supplied, secret) is None:
            # Refused before accepting, so a browser with a stale token sees a
            # handshake failure rather than a socket that opens and says
            # nothing.
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return

        await websocket.accept()
        engine = websocket.app.state.engine
        if engine is None:
            # Served without an engine -- `serve --reload`. Say so and leave;
            # a socket that accepts and stays silent looks like an outage.
            await websocket.send_json(
                {
                    "type": "disconnected",
                    "status": "no-engine",
                    "message": "the API is running without an engine, so there are no prices",
                }
            )
            await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
            return

        await websocket.send_json({"type": "connected", "status": "ok"})
        logger.info("socket: %s connected", clientId or "a console")
        channels: set[str] = set()

        async def listen() -> None:
            """Take subscription frames until the browser goes away."""
            while True:
                asked = _requested(await websocket.receive_text())
                if asked is None:
                    continue
                channels.clear()
                channels.update(asked)
                logger.debug("socket: %s wants %s", clientId, sorted(channels))

        async def stream() -> None:
            """Push ticks while anything is subscribed to them."""
            async with engine.parts.bus.subscribe(Topic.TICKS, name=f"socket:{clientId}") as ticks:
                async for tick in ticks:
                    if TICKS not in channels or not isinstance(tick, Tick):
                        continue
                    await websocket.send_json(tick_payload(tick))

        view = getattr(websocket.app.state, "terminal", None)

        async def summaries() -> None:
            """Push the Terminal's summaries: all of them first, then what changed.

            On the reference's cadence. Computed from the engine's book, which
            is in this process, so a pass costs a walk over the trades and
            nothing else; sending only the rows that changed keeps a quiet
            afternoon quiet.
            """
            sent: dict[str, Any] = {}
            while True:
                if TERMINAL in channels:
                    rows = {row["tradingClientId"]: row for row in _summaries(view)}
                    if not sent:
                        await websocket.send_json(
                            {"type": "full", "terminalSummaries": list(rows.values())}
                        )
                    else:
                        changed = [
                            row
                            for key, row in rows.items()
                            if _without_time(sent.get(key)) != _without_time(row)
                        ]
                        if changed:
                            await websocket.send_json(
                                {"type": "delta", "terminalSummaries": changed}
                            )
                    sent = rows
                else:
                    # Unsubscribed: the next subscribe starts with a full set.
                    sent = {}
                await engine.parts.clock.sleep(SUMMARY_INTERVAL)

        async def alerts() -> None:
            """Push every alert as it is raised, while the Terminal listens."""
            async with engine.parts.bus.subscribe(
                Topic.ALERTS, name=f"socket-alerts:{clientId}"
            ) as raised:
                async for alert in raised:
                    if TERMINAL not in channels or not isinstance(alert, Alert):
                        continue
                    await websocket.send_json({"type": "alert", "alert": alert_wire(alert)})

        # The Terminal's two tasks only when there is a view to read. A task
        # that returned at once would end the whole socket: the joiner cancels
        # the rest when the first finishes.
        halves = [listen(), stream()]
        if view is not None:
            halves += [summaries(), alerts()]
        await _until_either_ends(*halves, who=clientId)
        logger.info("socket: %s disconnected", clientId or "a console")

    return router


async def _until_either_ends(*coroutines: Any, who: str | None) -> None:
    """Run both halves; when one finishes, cancel the other.

    A disconnect surfaces on whichever side noticed first, and the other is
    left waiting on a socket that will never answer.
    """
    tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            _report(task, who)
    finally:
        await _drain(tasks)


def _report(task: asyncio.Task[Any], who: str | None) -> None:
    if task.cancelled():
        return
    error = task.exception()
    if error is None or isinstance(error, WebSocketDisconnect):
        return
    logger.warning("socket: %s ended with %s", who or "a console", error)


async def _drain(tasks: Iterable[asyncio.Task[Any]]) -> None:
    for task in tasks:
        with contextlib.suppress(asyncio.CancelledError, WebSocketDisconnect, Exception):
            await task
