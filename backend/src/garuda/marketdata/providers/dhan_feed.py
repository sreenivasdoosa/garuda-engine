"""Dhan's v2 live feed: a binary WebSocket, as a MarketDataFeed.

Ported from the reference market-data service's `DhanTicker`. What is
provider-specific and was not guessable:

* **The slash before the query.** The feed URL has no path, and
  ``wss://host?query`` produces a request line the handshake rejects.
  ``wss://host/?query`` works. Keep the slash.
* Credentials go in the query string, with ``authType=2``. There is no
  authorisation frame after the socket opens.
* **An index subscribes in QUOTE mode, everything else in FULL.** Dhan ignores
  a depth request for an index -- an index subscribed in FULL never ticks at
  all, which reads as a dead symbol rather than as a wrong mode. This is why
  the two batches are kept apart all the way to the wire.
* A hundred instruments per message, five thousand per connection.
* Subscriptions are tracked by ``(segment, security id)`` because that is what
  a packet header carries; the symbol is nowhere in the binary.

Decoding lives in :mod:`dhan_packets`; this module is the connection, the
subscription batching, and turning a packet into a :class:`Tick`.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator, Callable, Sequence
from datetime import datetime
from decimal import Decimal

from garuda.brokers.websocket import Connector, WebSocketConnection
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick
from garuda.domain.money import Currency, Money
from garuda.marketdata.providers.dhan_catalogue import DhanCatalogue
from garuda.marketdata.providers.dhan_packets import (
    INDEX_SEGMENT,
    RC_SUBSCRIBE_FULL,
    RC_SUBSCRIBE_QUOTE,
    RC_UNSUBSCRIBE_FULL,
    RC_UNSUBSCRIBE_QUOTE,
    DhanPacket,
    decode,
)
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

DHAN_FEED_URL = "wss://api-feed.dhan.co"

#: Ask to be disconnected, rather than dropping the socket. Dhan holds the
#: account's one slot for a while otherwise, and the next connect is refused
#: with 805 -- which looks like someone else logged in.
RC_DISCONNECT = 12

#: Dhan's cap for one subscribe message.
MAX_PER_MESSAGE = 100

#: And for one connection. Enforced rather than discovered: going over does
#: not fail, it silently stops delivering some of what was asked for.
MAX_SUBSCRIPTIONS = 5000

PROVIDER = "dhan"


class DhanFeed:
    """One connection to Dhan's binary market feed."""

    def __init__(
        self,
        access_token: str,
        client_id: str,
        catalogue: Callable[[], DhanCatalogue],
        registry: Callable[[], InstrumentRegistry],
        clock: Clock,
        connector: Connector,
        *,
        url: str = DHAN_FEED_URL,
    ) -> None:
        if not access_token or not client_id:
            raise DomainError("the Dhan feed needs an access token and a client id")
        self._token = access_token
        self._client_id = client_id
        self._catalogue = catalogue
        self._registry = registry
        self._clock = clock
        self._connector = connector
        self._url = url.rstrip("/")
        self._connection: WebSocketConnection | None = None
        #: What we asked for, keyed the way a packet header addresses it.
        self._subscribed: dict[tuple[int, int], InstrumentId] = {}

    @property
    def name(self) -> str:
        return PROVIDER

    @property
    def is_connected(self) -> bool:
        return self._connection is not None

    @property
    def endpoint(self) -> str:
        """The URL, with credentials. Never log this.

        The slash before the query is load-bearing -- see the module docstring.
        """
        return f"{self._url}/?version=2&token={self._token}&clientId={self._client_id}&authType=2"

    async def connect(self) -> None:
        if self._connection is not None:
            return
        self._connection = await self._connector(self.endpoint)
        logger.info("dhan feed connected")

    async def close(self) -> None:
        connection, self._connection = self._connection, None
        self._subscribed.clear()
        if connection is None:
            return
        try:
            await connection.send(json.dumps({"RequestCode": RC_DISCONNECT}))
        except Exception as error:
            # Best effort. The socket is going regardless, and a provider that
            # will not take the goodbye is not a reason to leave it open.
            logger.debug("dhan: could not send the disconnect frame (%s)", error)
        await connection.close()

    # -- subscriptions ------------------------------------------------------

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None:
        await self._change(instruments, subscribe=True)

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None:
        await self._change(instruments, subscribe=False)

    async def _change(self, instruments: Sequence[InstrumentId], *, subscribe: bool) -> None:
        """One subscribe or unsubscribe, split by mode and batched.

        Indices and tradables go in separate messages with separate request
        codes, and each mode's batch is flushed on its own at a hundred.
        """
        if not instruments:
            return
        catalogue = self._catalogue()

        wanted = [
            (instrument, key)
            for instrument in instruments
            if (key := _key(catalogue, instrument)) is not None
        ]
        if subscribe:
            # Checked before anything is sent. Refusing halfway would leave the
            # connection holding a subscription set nobody asked for.
            projected = len(self._subscribed | dict.fromkeys(key for _, key in wanted))
            if projected > MAX_SUBSCRIPTIONS:
                raise DomainError(
                    f"{projected} instruments exceeds the {MAX_SUBSCRIPTIONS} one Dhan "
                    "connection carries; the extra subscriptions would be accepted and "
                    "never delivered"
                )

        full: list[dict[str, object]] = []
        quote: list[dict[str, object]] = []
        full_code = RC_SUBSCRIBE_FULL if subscribe else RC_UNSUBSCRIBE_FULL
        quote_code = RC_SUBSCRIBE_QUOTE if subscribe else RC_UNSUBSCRIBE_QUOTE

        for instrument, key in wanted:
            row = catalogue.details_for(instrument)
            if row is None:
                continue
            number, _ = key
            if subscribe:
                self._subscribed[key] = instrument
            else:
                self._subscribed.pop(key, None)

            entry: dict[str, object] = {
                "ExchangeSegment": row.segment,
                "SecurityId": row.security_id,
            }
            batch = quote if number == INDEX_SEGMENT else full
            batch.append(entry)
            if len(batch) >= MAX_PER_MESSAGE:
                await self._flush(batch, quote_code if number == INDEX_SEGMENT else full_code)
                batch.clear()

        await self._flush(full, full_code)
        await self._flush(quote, quote_code)

    async def _flush(self, batch: list[dict[str, object]], request_code: int) -> None:
        if not batch:
            return
        await self._send(
            {
                "RequestCode": request_code,
                "InstrumentCount": len(batch),
                "InstrumentList": list(batch),
            }
        )

    async def _send(self, message: dict[str, object]) -> None:
        if self._connection is None:
            raise DomainError("the Dhan feed is not connected")
        await self._connection.send(json.dumps(message))

    # -- reading ------------------------------------------------------------

    async def events(self) -> AsyncIterator[FeedEvent]:
        """Everything the connection produces, until it ends."""
        if self._connection is None:
            raise DomainError("the Dhan feed is not connected")
        connection = self._connection

        yield FeedConnected(self._clock.now())
        reason = "the connection ended"
        try:
            async for message in connection:
                for event in self._decode(message):
                    yield event
        except Exception as error:
            reason = f"{type(error).__name__}: {error}"
        finally:
            self._connection = None

        yield FeedDisconnected(reason, self._clock.now())

    def _decode(self, message: str | bytes) -> list[FeedEvent]:
        now = self._clock.now()
        if isinstance(message, str):
            # Dhan's feed is binary. A text frame is an error report.
            return [FeedProblem(f"dhan sent text: {message[:200]}", now)]

        try:
            packets, disconnects = decode(message, now)
        except Exception as error:
            return [FeedProblem(f"unreadable frame: {type(error).__name__}: {error}", now)]

        events: list[FeedEvent] = []
        for disconnect in disconnects:
            detail = f"dhan sent a disconnect packet, code {disconnect.code}"
            if disconnect.is_too_many_connections:
                detail += " -- another session has taken this account's feed slot"
            events.append(FeedProblem(detail, now))

        registry = self._registry()
        ticks: list[Tick] = []
        stale: set[str] = set()
        for packet in packets:
            instrument = self._subscribed.get((packet.segment, packet.security_id))
            if instrument is None:
                # Dhan sends only what was asked for, so this is an unsubscribe
                # racing packets already in flight: the ordinary state for a
                # second or two after one, and not worth an operator's
                # attention.
                logger.debug(
                    "dhan: packet for %d:%d, which is not subscribed",
                    packet.segment,
                    packet.security_id,
                )
                continue
            held = registry.get(instrument)
            if held is None:
                stale.add(str(instrument))
                continue
            tick = tick_from(instrument, packet, held.currency, now)
            if tick is not None:
                ticks.append(tick)

        if stale:
            # This one is a real fault: it is subscribed here and ticking, and
            # today's master does not list it, so nothing can route the tick.
            events.append(
                FeedProblem(f"subscribed but not in today's master: {sorted(stale)}", now)
            )
        if ticks:
            events.append(TicksReceived(tuple(ticks)))
        return events


def _key(catalogue: DhanCatalogue, instrument: InstrumentId) -> tuple[int, int] | None:
    """How a packet header addresses this instrument, or None if Dhan has no
    way to address it -- an instrument its master does not list, or one in a
    segment the feed does not carry."""
    row = catalogue.details_for(instrument)
    number = catalogue.segment_number_for(instrument)
    if row is None or number is None:
        logger.warning("dhan does not list %s in a feed segment; not subscribed", instrument)
        return None
    try:
        return (number, int(row.security_id))
    except ValueError:
        logger.error("dhan: %s has a non-numeric security id; not subscribed", instrument)
        return None


def _price(value: float | None, currency: Currency) -> Money | None:
    """A wire float as money.

    Zero and negative are read as absent, not as a price: Dhan sends 0.0 for a
    field a packet type does not carry, and a zero open would make the day's
    range start at nothing.
    """
    if value is None or value <= 0:
        return None
    return Money(Decimal(str(value)), currency)


def tick_from(
    instrument: InstrumentId, packet: DhanPacket, currency: Currency, now: datetime
) -> Tick | None:
    """One decoded packet, as a tick. None when it carries no usable price."""
    last = _price(packet.last_traded_price, currency)
    if last is None:
        return None
    return Tick(
        instrument=instrument,
        last_price=last,
        timestamp=packet.timestamp or now,
        last_quantity=packet.last_traded_quantity,
        average_price=_price(packet.average_price, currency),
        volume=packet.volume,
        total_buy_quantity=packet.total_buy_quantity,
        total_sell_quantity=packet.total_sell_quantity,
        open=_price(packet.open, currency),
        high=_price(packet.high, currency),
        low=_price(packet.low, currency),
        previous_close=_price(packet.close, currency),
        open_interest=packet.open_interest,
    )
