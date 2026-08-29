"""The market data feed contract.

A feed is one connection to one provider. It knows how to connect, what it is
subscribed to, and how to turn whatever arrives into :class:`Tick` objects. It
does not decide when to reconnect, what the engine is interested in, or who
hears about a tick -- those belong above it, so that swapping provider does not
swap the engine's behaviour with it.

Subscriptions are in :class:`InstrumentId`, never in broker tokens. Translating
one to the other is the adapter's job and stops at its boundary.
"""

from __future__ import annotations

from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Protocol, runtime_checkable

from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Tick


@dataclass(frozen=True, slots=True)
class FeedConnected:
    at: datetime


@dataclass(frozen=True, slots=True)
class FeedDisconnected:
    """The connection is gone.

    ``reason`` is for the operator: a feed that reports "disconnected" with no
    cause turns every outage into an investigation from scratch.
    """

    reason: str
    at: datetime


@dataclass(frozen=True, slots=True)
class TicksReceived:
    ticks: tuple[Tick, ...]


@dataclass(frozen=True, slots=True)
class FeedProblem:
    """Something arrived that could not be turned into a tick.

    Not a disconnection: the connection is fine and the next packet may be
    perfectly good. Reported rather than swallowed because a feed quietly
    dropping one instrument's packets looks exactly like an illiquid symbol.
    """

    detail: str
    at: datetime


type FeedEvent = FeedConnected | FeedDisconnected | TicksReceived | FeedProblem


@runtime_checkable
class MarketDataFeed(Protocol):
    """One connection to one market data provider."""

    @property
    def name(self) -> str:
        """What to call it in a log line or an alert."""
        ...

    @property
    def is_connected(self) -> bool: ...

    async def connect(self) -> None: ...

    async def close(self) -> None:
        """Tear the connection down completely.

        Completely, because the reference engine learned that dropping the
        reference to a half-dead feed leaves it alive underneath: still
        connected, still consuming the account's one session, still decoding
        frames for a reader that no longer exists.
        """
        ...

    async def subscribe(self, instruments: Sequence[InstrumentId]) -> None: ...

    async def unsubscribe(self, instruments: Sequence[InstrumentId]) -> None: ...

    def events(self) -> AsyncIterator[FeedEvent]:
        """Everything the connection produces, until it is closed."""
        ...
