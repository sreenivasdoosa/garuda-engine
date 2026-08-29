"""The Kite streaming quote connection.

One WebSocket, authenticated with the same access token the trading APIs use.
It translates instruments to tokens on the way out and tokens to instruments
on the way in, and does nothing else -- what to subscribe to and when to
reconnect belong above it.

The instrument registry is read through a callable rather than held, because
it is replaced whole every morning. A feed holding yesterday's registry would
resolve yesterday's strikes.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable, Sequence

from garuda.brokers.websocket import Connector, WebSocketConnection
from garuda.brokers.zerodha.ticks import parse_frame
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.marketdata.registry import InstrumentRegistry
from garuda.protocols.clock import Clock
from garuda.protocols.feed import (
    FeedConnected,
    FeedDisconnected,
    FeedEvent,
    FeedProblem,
    TicksReceived,
)

logger = logging.getLogger(__name__)

KITE_FEED_URL = "wss://ws.kite.trade"

#: Kite's cap for one connection. Enforced rather than discovered: going over
#: does not fail loudly, it just stops delivering some of what was asked for,
#: and a strategy watching a strike that never ticks looks like an illiquid
#: strike rather than like a bug.
MAX_SUBSCRIPTIONS = 3000

#: Full mode carries market depth and open interest. Quote mode is cheaper and
#: has neither, which rules out every depth-aware check.
MODE_FULL = "full"
MODE_QUOTE = "quote"
MODE_LTP = "ltp"


class ZerodhaFeed:
    """Kite's WebSocket, as a MarketDataFeed."""

    def __init__(
        self,
        api_key: str,
        access_token: str,
        registry: Callable[[], InstrumentRegistry],
        clock: Clock,
        connector: Connector,
        *,
        url: str = KITE_FEED_URL,
        mode: str = MODE_FULL,
    ) -> None:
        if not api_key or not access_token:
            raise DomainError("the Kite feed needs an API key and an access token")
        self._api_key = api_key
        self._access_token = access_token
        self._registry = registry
        self._clock = clock
        self._connector = connector
        self._url = url
        self._mode = mode
        self._connection: WebSocketConnection | None = None
        self._subscribed: dict[InstrumentId, int] = {}

    @property
    def name(self) -> str:
        return "zerodha"

    @property
    def is_connected(self) -> bool:
        return self._connection is not None

    @property
    def endpoint(self) -> str:
        """The URL, with credentials. Never log this."""
        return f"{self._url}?api_key={self._api_key}&access_token={self._access_token}"

    async def connect(self) -> None:
        if self._connection is not None:
            return
        self._connection = await self._connector(self.endpoint)
        logger.info("kite feed connected")

    async def close(self) -> None:
        connection, self._connection = self._connection, None
        self._subscribed.clear()
        if connection is not None:
            await connection.close()

    # -- subscriptions ------------------------------------------------------

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None:
        """Subscribe, then set the mode. Both, in that order, as Kite requires.

        Instruments the master does not know are skipped with a warning rather
        than refused: one unlisted strike must not cost the other subscriptions
        in the same call.
        """
        tokens = self._tokens_for(instruments)
        if not tokens:
            return
        total = len(set(self._subscribed.values()) | set(tokens))
        if total > MAX_SUBSCRIPTIONS:
            raise DomainError(
                f"{total} instruments exceeds the {MAX_SUBSCRIPTIONS} one Kite connection "
                "carries; the extra subscriptions would be accepted and never delivered"
            )
        await self._send({"a": "subscribe", "v": tokens})
        await self._send({"a": "mode", "v": [self._mode, tokens]})

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None:
        tokens = [
            token
            for instrument in instruments
            if (token := self._subscribed.pop(instrument, None)) is not None
        ]
        if tokens:
            await self._send({"a": "unsubscribe", "v": tokens})

    def _tokens_for(self, instruments: Sequence[InstrumentId]) -> list[int]:
        """The tokens Kite wants, as numbers.

        The engine holds a token as opaque text because brokers disagree about
        its shape -- Kite numbers them, an XTS-style broker may not. Turning it
        back into a number is this adapter's business, done here where every
        other translation happens.
        """
        registry = self._registry()
        tokens: list[int] = []
        for instrument in instruments:
            token = registry.token_for(instrument)
            if token is None:
                logger.warning(
                    "%s has no broker token in today's master; not subscribed", instrument
                )
                continue
            try:
                numeric = int(token)
            except ValueError:
                logger.error(
                    "%s has a non-numeric Kite token %r; not subscribed", instrument, token
                )
                continue
            self._subscribed[instrument] = numeric
            tokens.append(numeric)
        return tokens

    async def _send(self, message: dict[str, object]) -> None:
        if self._connection is None:
            raise DomainError("the Kite feed is not connected")
        await self._connection.send(json.dumps(message))

    # -- reading ------------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Everything the connection produces, until it ends.

        The disconnection is yielded rather than raised. A dropped feed is an
        expected event in a session that runs for six hours, and the supervisor
        above needs to be told about it, not unwound through.
        """
        if self._connection is None:
            raise DomainError("the Kite feed is not connected")
        connection = self._connection

        yield FeedConnected(self._clock.now())
        reason = "the connection ended"
        try:
            async for message in connection:
                event = self._decode(message)
                if event is not None:
                    yield event
        except Exception as error:
            reason = f"{type(error).__name__}: {error}"
        finally:
            self._connection = None

        yield FeedDisconnected(reason, self._clock.now())

    def _decode(self, message: str | bytes) -> FeedEvent | None:
        if isinstance(message, str):
            return self._decode_text(message)

        registry = self._registry()
        # The wire carries numbers; the registry is keyed by the opaque form.
        batch = parse_frame(message, lambda token: registry.by_token(str(token)), self._clock.now())
        if batch.malformed:
            return FeedProblem("; ".join(batch.malformed), self._clock.now())
        if batch.unresolved:
            # The subscription and the master disagree, which is a real fault
            # and not a quiet one: those instruments are ticking and nothing
            # is listening.
            return FeedProblem(
                f"tokens not in today's master: {sorted(set(batch.unresolved))}",
                self._clock.now(),
            )
        if not batch.ticks:
            return None
        return TicksReceived(batch.ticks)

    def _decode_text(self, message: str) -> FeedEvent | None:
        """Kite's out-of-band messages: errors, and order updates.

        Order updates arrive here as well as through the order APIs, and are
        the faster of the two. They are not consumed yet -- the order book is
        fed from the broker's order stream -- so they are ignored rather than
        turned into a problem the operator has to read.
        """
        try:
            payload = json.loads(message)
        except json.JSONDecodeError:
            return FeedProblem(f"unreadable text frame: {message[:200]}", self._clock.now())

        kind = payload.get("type") if isinstance(payload, dict) else None
        if kind == "error":
            return FeedProblem(f"kite reported: {payload.get('data')}", self._clock.now())
        logger.debug("kite text frame ignored: type=%s", kind)
        return None
