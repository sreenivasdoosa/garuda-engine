"""The rate gate: spacing calls so the engine is not why a provider throttles."""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta

import pytest

from garuda.core.clock import ReplayClock
from garuda.domain.errors import DomainError
from garuda.marketdata.throttle import ProviderBusyError, RateGate

START = datetime(2026, 9, 1, 4, 0, tzinfo=UTC)


def a_gate(ms: int, *, max_waiters: int = 32) -> tuple[RateGate, ReplayClock]:
    clock = ReplayClock(START)
    return RateGate(timedelta(milliseconds=ms), clock, max_waiters=max_waiters), clock


async def test_the_first_call_never_waits() -> None:
    gate, clock = a_gate(1000)

    await gate.acquire()

    assert clock.now() == START


async def test_the_second_call_waits_out_the_interval() -> None:
    gate, clock = a_gate(1000)
    await gate.acquire()

    await gate.acquire()

    assert clock.now() == START + timedelta(seconds=1)


async def test_a_call_after_the_interval_does_not_wait() -> None:
    gate, clock = a_gate(1000)
    await gate.acquire()
    await clock.advance_by(timedelta(seconds=5))

    await gate.acquire()

    assert clock.now() == START + timedelta(seconds=5)


async def test_no_interval_is_no_gate() -> None:
    gate, clock = a_gate(0)

    await gate.acquire()
    await gate.acquire()

    assert clock.now() == START


async def test_it_refuses_rather_than_queueing_beyond_the_cap() -> None:
    """A quote that waits behind a throttle arrives after the tick that made it
    interesting. A caller told 'busy' can use a cached price instead."""
    gate, _ = a_gate(10_000, max_waiters=1)
    await gate.acquire()
    first = asyncio.create_task(gate.acquire())
    await asyncio.sleep(0)

    with pytest.raises(ProviderBusyError, match="already waiting"):
        await gate.acquire()

    first.cancel()


async def test_a_negative_interval_is_refused_when_the_gate_is_built() -> None:
    with pytest.raises(DomainError, match="cannot be negative"):
        RateGate(timedelta(milliseconds=-1), ReplayClock(START))


async def test_is_open_says_whether_a_call_would_wait() -> None:
    gate, clock = a_gate(1000)
    before = gate.is_open

    await gate.acquire()
    just_after = gate.is_open

    await clock.advance_by(timedelta(seconds=1))
    a_second_later = gate.is_open

    assert (before, just_after, a_second_later) == (True, False, True)
