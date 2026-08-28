"""The event bus and its backpressure policies.

The claims that matter are about what happens when a subscriber falls behind,
because that is the case that costs money or stalls the engine.
"""

from __future__ import annotations

import asyncio

import pytest

from garuda.core.bus import InProcessEventBus, UnknownTopicError
from garuda.protocols.topics import TOPIC_POLICIES, Overflow, Topic, TopicPolicy


@pytest.fixture
def bus() -> InProcessEventBus:
    return InProcessEventBus()


class TestDelivery:
    async def test_a_subscriber_receives_what_is_published(self, bus):
        subscription = bus.subscribe(Topic.TICKS)
        await bus.publish(Topic.TICKS, "tick-1")
        assert await anext(subscription) == "tick-1"

    async def test_every_subscriber_receives_every_event(self, bus):
        first = bus.subscribe(Topic.FILLS, "trade-book")
        second = bus.subscribe(Topic.FILLS, "journal")
        await bus.publish(Topic.FILLS, "fill-1")
        assert await anext(first) == "fill-1"
        assert await anext(second) == "fill-1"

    async def test_publishing_with_no_subscribers_is_not_an_error(self, bus):
        await bus.publish(Topic.TICKS, "tick-1")
        assert bus.subscriber_count(Topic.TICKS) == 0

    async def test_events_arrive_in_the_order_they_were_published(self, bus):
        subscription = bus.subscribe(Topic.FILLS)
        for i in range(5):
            await bus.publish(Topic.FILLS, i)
        received = [await anext(subscription) for _ in range(5)]
        assert received == [0, 1, 2, 3, 4]


class TestDropOldest:
    """Ticks: only the latest price matters, and a stale one is worthless."""

    @pytest.fixture
    def small_bus(self) -> InProcessEventBus:
        return InProcessEventBus(
            {Topic.TICKS: TopicPolicy(max_queue=3, overflow=Overflow.DROP_OLDEST)}
        )

    async def test_a_slow_subscriber_loses_the_oldest_events_not_the_newest(self, small_bus):
        subscription = small_bus.subscribe(Topic.TICKS)
        for i in range(6):
            await small_bus.publish(Topic.TICKS, i)

        received = [await anext(subscription) for _ in range(3)]
        assert received == [3, 4, 5], "the freshest ticks survive"

    async def test_drops_are_counted_never_silent(self, small_bus):
        subscription = small_bus.subscribe(Topic.TICKS)
        for i in range(6):
            await small_bus.publish(Topic.TICKS, i)
        assert subscription.stats.dropped == 3
        assert small_bus.total_dropped(Topic.TICKS) == 3

    async def test_publishing_never_blocks_however_far_behind_the_subscriber_is(self, small_bus):
        small_bus.subscribe(Topic.TICKS)

        async def publish_all() -> None:
            for i in range(100):
                await small_bus.publish(Topic.TICKS, i)

        # Would raise TimeoutError if any publish blocked on the full queue.
        await asyncio.wait_for(publish_all(), timeout=1)


class TestBlock:
    """Order events: a dropped fill is a position the engine does not know it has."""

    @pytest.fixture
    def small_bus(self) -> InProcessEventBus:
        return InProcessEventBus({Topic.FILLS: TopicPolicy(max_queue=2, overflow=Overflow.BLOCK)})

    async def test_nothing_is_ever_dropped(self, small_bus):
        subscription = small_bus.subscribe(Topic.FILLS)
        for i in range(2):
            await small_bus.publish(Topic.FILLS, i)
        assert subscription.stats.dropped == 0

    async def test_the_producer_waits_rather_than_losing_an_event(self, small_bus):
        subscription = small_bus.subscribe(Topic.FILLS)
        await small_bus.publish(Topic.FILLS, 0)
        await small_bus.publish(Topic.FILLS, 1)

        blocked = asyncio.create_task(small_bus.publish(Topic.FILLS, 2))
        await asyncio.sleep(0)
        assert not blocked.done(), "the queue is full, so the producer must wait"

        assert await anext(subscription) == 0  # make room
        await blocked
        assert blocked.done()

    async def test_everything_published_is_eventually_received(self, small_bus):
        subscription = small_bus.subscribe(Topic.FILLS)

        async def publish_all() -> None:
            for i in range(10):
                await small_bus.publish(Topic.FILLS, i)

        producer = asyncio.create_task(publish_all())
        received = [await anext(subscription) for _ in range(10)]
        await producer
        assert received == list(range(10)), "order is preserved even under backpressure"
        assert subscription.stats.dropped == 0


class TestPolicyCoverage:
    @pytest.mark.parametrize("topic", list(Topic))
    def test_every_topic_declares_a_policy(self, topic):
        assert topic in TOPIC_POLICIES

    @pytest.mark.parametrize(
        "topic", [Topic.ORDERS, Topic.FILLS, Topic.POSITIONS, Topic.TRADES, Topic.ALERTS]
    )
    def test_money_and_operator_streams_never_drop(self, topic):
        assert TOPIC_POLICIES[topic].overflow is Overflow.BLOCK

    @pytest.mark.parametrize("topic", [Topic.TICKS, Topic.BARS, Topic.UI])
    def test_market_data_and_presentation_drop_rather_than_stall_the_engine(self, topic):
        assert TOPIC_POLICIES[topic].overflow is Overflow.DROP_OLDEST

    async def test_an_undeclared_topic_is_refused_rather_than_defaulted(self):
        """Whether to drop or block is a decision about money, not a default."""
        bare = InProcessEventBus({})
        with pytest.raises(UnknownTopicError, match="no declared backpressure policy"):
            await bare.publish(Topic.TICKS, "tick")


class TestLifecycle:
    async def test_closing_a_subscription_ends_its_iteration(self, bus):
        subscription = bus.subscribe(Topic.TICKS)
        await bus.publish(Topic.TICKS, "tick-1")
        subscription.close()

        received = [event async for event in subscription]
        assert received == ["tick-1"], "queued events are still drained"

    async def test_a_closed_subscription_stops_receiving(self, bus):
        subscription = bus.subscribe(Topic.TICKS)
        subscription.close()
        await bus.publish(Topic.TICKS, "tick-1")
        assert bus.subscriber_count(Topic.TICKS) == 0

    async def test_a_subscription_works_as_a_context_manager(self, bus):
        async with bus.subscribe(Topic.TICKS) as subscription:
            await bus.publish(Topic.TICKS, "tick-1")
            assert await anext(subscription) == "tick-1"
        assert subscription.is_closed

    async def test_closing_the_bus_closes_everything(self, bus):
        first = bus.subscribe(Topic.TICKS)
        second = bus.subscribe(Topic.FILLS)
        bus.close()
        assert first.is_closed
        assert second.is_closed
