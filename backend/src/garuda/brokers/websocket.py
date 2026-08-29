"""The part of a WebSocket client the broker adapters need.

Small on purpose. Injecting a connector rather than importing a client library
into each adapter is what lets a feed or an account stream be driven end to end
without a server, and it leaves the proxy and the timeouts to the caller.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Protocol, runtime_checkable


@runtime_checkable
class WebSocketConnection(Protocol):
    async def send(self, message: str) -> None: ...

    async def close(self) -> None: ...

    def __aiter__(self) -> AsyncIterator[str | bytes]: ...


#: Opens a connection to a URL.
type Connector = Callable[[str], Awaitable[WebSocketConnection]]

#: Kite frames carry every subscribed instrument at once. Three thousand
#: instruments in full mode is a little over half a megabyte, close enough to
#: the library's default cap that a busy open would trip it -- and a frame over
#: the cap does not truncate, it closes the connection.
MAX_FRAME_BYTES = 4 * 1024 * 1024


def websocket_connector(*, proxy: str | None = None, open_timeout: float = 10.0) -> Connector:
    """The real connector, over ``websockets``.

    A proxy is accepted but not the default. The address a broker whitelists
    covers the trading APIs; routing market data through it is the operator's
    call, and one their provider has to agree with.
    """

    async def open_connection(url: str) -> WebSocketConnection:
        from websockets.asyncio.client import connect

        return await connect(url, proxy=proxy, open_timeout=open_timeout, max_size=MAX_FRAME_BYTES)

    return open_connection
