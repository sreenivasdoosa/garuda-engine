"""In-process event bus.

One asyncio loop owns all engine state, so the bus is in-process pub/sub with
no serialisation and no broker. Each subscriber gets its own bounded queue and
its topic's overflow policy (:mod:`garuda.core.topics`).

Drops are counted, never silent. A tick stream that quietly discarded a
thousand events would look healthy right up until a strategy acted on a stale
price.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from dataclasses import dataclass
from types import TracebackType

from garuda.protocols.topics import TOPIC_POLICIES, Overflow, Topic, TopicPolicy
from garuda.domain.errors import DomainError


class UnknownTopicError(DomainError):
    """A topic with no declared policy.

    Refused rather than defaulted: choosing whether to drop or block is a
    decision about money, not a detail to infer.
    """


@dataclass
class SubscriptionStats:
    delivered: int = 0
    dropped: int = 0


class Subscription:
    """A bounded stream of one topic's events, for one subscriber."""

    def __init__(self, topic: Topic, policy: TopicPolicy, name: str) -> None:
        self.topic = topic
        self.policy = policy
        self.name = name
        self.stats = SubscriptionStats()
        self._queue: asyncio.Queue[object] = asyncio.Queue(maxsize=policy.max_queue)
        self._closed = False

    @property
    def depth(self) -> int:
        return self._queue.qsize()

    @property
    def is_closed(self) -> bool:
        return self._closed

    async def deliver(self, event: object) -> None:
        if self._closed:
            return
        if self.policy.overflow is Overflow.BLOCK:
            await self._queue.put(event)
        else:
            while self._queue.full():
                try:
                    self._queue.get_nowait()
                except asyncio.QueueEmpty:  # pragma: no cover - drained concurrently
                    break
                self.stats.dropped += 1
            self._queue.put_nowait(event)
        self.stats.delivered += 1

    def __aiter__(self) -> AsyncIterator[object]:
        return self

    async def __anext__(self) -> object:
        while True:
            if self._closed and self._queue.empty():
                raise StopAsyncIteration
            event = await self._queue.get()
            if event is _CLOSED:
                raise StopAsyncIteration
            return event

    def close(self) -> None:
        """Stop the stream. A consumer blocked on it wakes and finishes."""
        if self._closed:
            return
        self._closed = True
        try:
            self._queue.put_nowait(_CLOSED)
        except asyncio.QueueFull:  # pragma: no cover - drop one to make room
            self._queue.get_nowait()
            self._queue.put_nowait(_CLOSED)

    async def __aenter__(self) -> Subscription:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        self.close()


class _Closed:
    """Sentinel that ends a subscription's iteration."""


_CLOSED = _Closed()


class InProcessEventBus:
    """Bounded, policy-driven pub/sub within one process."""

    def __init__(self, policies: dict[Topic, TopicPolicy] | None = None) -> None:
        self._policies = policies if policies is not None else dict(TOPIC_POLICIES)
        self._subscriptions: dict[Topic, list[Subscription]] = {}

    def policy_for(self, topic: Topic) -> TopicPolicy:
        try:
            return self._policies[topic]
        except KeyError:
            raise UnknownTopicError(
                f"{topic} has no declared backpressure policy; "
                "add one to TOPIC_POLICIES rather than defaulting"
            ) from None

    def subscribe(self, topic: Topic, name: str = "anonymous") -> Subscription:
        subscription = Subscription(topic, self.policy_for(topic), name)
        self._subscriptions.setdefault(topic, []).append(subscription)
        return subscription

    async def publish(self, topic: Topic, event: object) -> None:
        self.policy_for(topic)
        live = [s for s in self._subscriptions.get(topic, []) if not s.is_closed]
        self._subscriptions[topic] = live
        for subscription in live:
            await subscription.deliver(event)

    def subscriber_count(self, topic: Topic) -> int:
        return len([s for s in self._subscriptions.get(topic, []) if not s.is_closed])

    def total_dropped(self, topic: Topic | None = None) -> int:
        topics = [topic] if topic is not None else list(self._subscriptions)
        return sum(s.stats.dropped for t in topics for s in self._subscriptions.get(t, []))

    def close(self) -> None:
        for subscriptions in self._subscriptions.values():
            for subscription in subscriptions:
                subscription.close()
