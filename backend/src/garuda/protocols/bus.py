"""The event bus contract.

In-process pub/sub. Every stream is bounded and declares what happens when a
subscriber falls behind, because the alternative -- an unbounded queue -- turns
a slow consumer into a memory leak and then into an outage.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol, runtime_checkable

from garuda.protocols.topics import Topic


@runtime_checkable
class EventBus(Protocol):
    async def publish(self, topic: Topic, event: object) -> None:
        """Deliver an event to every subscriber of a topic."""
        ...

    def subscribe(self, topic: Topic) -> AsyncIterator[object]:
        """Open a bounded stream of a topic's events."""
        ...
