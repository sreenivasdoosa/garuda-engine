"""Helpers shared by the test suites."""

from __future__ import annotations

from garuda.core.bus import Subscription


async def next_published(subscription: Subscription) -> object:
    """The next event, or a failure -- never a wait that never ends.

    Awaiting a subscription that will never receive anything blocks for ever,
    which in a test suite means a wedged run rather than a red one. Checking
    first turns a missing event into an ordinary assertion failure.
    """
    assert subscription.depth > 0, "nothing was published"
    return await anext(aiter(subscription))
