"""Topics and their backpressure policies.

Part of the bus *contract* rather than of any implementation, which is why it
lives here: the EventBus protocol names topics, and protocols sit below the
core in the layer order.

Every stream declares, in one place, what happens when a subscriber cannot keep
up. This is not a tuning detail: dropping an order event loses money, and
blocking on a tick stalls the loop that would have processed the next one.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class Overflow(StrEnum):
    #: Discard the oldest queued event to make room. For streams where only
    #: the latest value matters and a stale one is worthless.
    DROP_OLDEST = "DROP_OLDEST"
    #: Make the producer wait. For streams where every event is needed and
    #: losing one is worse than going slowly.
    BLOCK = "BLOCK"


class Topic(StrEnum):
    TICKS = "ticks"
    BARS = "bars"
    ORDERS = "orders"
    FILLS = "fills"
    POSITIONS = "positions"
    TRADES = "trades"
    ALERTS = "alerts"
    SYSTEM = "system"
    #: Fan-out to connected browsers. A slow browser must never stall the
    #: engine -- the reference engine froze its whole summary broadcaster on
    #: one half-dead WebSocket client, which is why this is drop-oldest.
    UI = "ui"


@dataclass(frozen=True, slots=True)
class TopicPolicy:
    max_queue: int
    overflow: Overflow
    #: Drops beyond this many in one subscription are worth an alert.
    drop_alert_threshold: int = 100


#: The engine's policy per stream. A topic missing from here is a defect: the
#: bus refuses to publish rather than pick a default on a stream nobody thought
#: about.
TOPIC_POLICIES: Final[dict[Topic, TopicPolicy]] = {
    # Market data: only the latest price matters, and a stale tick is worse
    # than no tick.
    Topic.TICKS: TopicPolicy(max_queue=10_000, overflow=Overflow.DROP_OLDEST),
    Topic.BARS: TopicPolicy(max_queue=1_000, overflow=Overflow.DROP_OLDEST),
    # Money paths: never drop. A missed fill is a position the engine does not
    # know it has.
    Topic.ORDERS: TopicPolicy(max_queue=10_000, overflow=Overflow.BLOCK),
    Topic.FILLS: TopicPolicy(max_queue=10_000, overflow=Overflow.BLOCK),
    Topic.POSITIONS: TopicPolicy(max_queue=10_000, overflow=Overflow.BLOCK),
    Topic.TRADES: TopicPolicy(max_queue=10_000, overflow=Overflow.BLOCK),
    # Operator-facing: an alert that is never delivered is an incident nobody
    # saw.
    Topic.ALERTS: TopicPolicy(max_queue=5_000, overflow=Overflow.BLOCK),
    Topic.SYSTEM: TopicPolicy(max_queue=1_000, overflow=Overflow.BLOCK),
    # Presentation only.
    Topic.UI: TopicPolicy(max_queue=1_000, overflow=Overflow.DROP_OLDEST),
}
