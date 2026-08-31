"""Candle history, fetched rather than built.

Yesterday never changes, so it is fetched once. Today does, so it is
refreshed. Everything else here is about what happens when the broker will
not answer.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

import pytest

from garuda.core.clock import ReplayClock
from garuda.domain import Currency, Money
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import Bar, BarInterval
from garuda.marketdata.history import FAILURE_BACKOFF, CandleCache, Want
from garuda.protocols.broker import AuthExpiredError

STOCK = InstrumentId("NSE:RELIANCE")
MINUTE = BarInterval.ONE_MINUTE
OPEN = datetime(2026, 8, 31, 9, 15, tzinfo=UTC)


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def bar(start: datetime, close: str = "100") -> Bar:
    return Bar(
        instrument=STOCK,
        interval=MINUTE,
        start=start,
        open=rupees("100"),
        high=rupees("101"),
        low=rupees("99"),
        close=rupees(close),
    )


@dataclass
class FakeBroker:
    """A history API that answers whatever a test says, and counts calls."""

    settled: list[Bar] = field(default_factory=list)
    today: list[Bar] = field(default_factory=list)
    calls: list[tuple[datetime, datetime]] = field(default_factory=list)
    fails_with: Exception | None = None

    async def fetch(
        self,
        instrument: InstrumentId,
        interval: BarInterval,
        start: datetime,
        end: datetime,
    ) -> list[Bar]:
        self.calls.append((start, end))
        if self.fails_with is not None:
            raise self.fails_with
        # A settled request ends at midnight; anything later is today's.
        if end.time() == end.time().min:
            return list(self.settled)
        return list(self.today)


def cache_at(broker: FakeBroker, now: datetime) -> CandleCache:
    return CandleCache(source=broker, clock=ReplayClock(now))


# -- reading is memory only -------------------------------------------------


def test_a_series_nobody_has_fetched_answers_empty() -> None:
    """A rule is a pure function and must not perform I/O, so the first pass
    over a new instrument says "cannot tell", which is true."""
    cache = cache_at(FakeBroker(), OPEN)

    assert cache.get(STOCK, MINUTE, 10) == ()


def test_asking_registers_the_demand() -> None:
    cache = cache_at(FakeBroker(), OPEN)

    cache.get(STOCK, MINUTE, 10)

    assert Want(STOCK, MINUTE) in cache.wanted


def test_a_series_can_be_asked_for_up_front() -> None:
    """A strategy's instruments are known before its first evaluation, which
    saves every strategy one blind pass."""
    cache = cache_at(FakeBroker(), OPEN)

    cache.wants(STOCK, MINUTE)

    assert Want(STOCK, MINUTE) in cache.wanted


# -- the two tiers ----------------------------------------------------------


async def test_a_refresh_brings_what_was_asked_for() -> None:
    broker = FakeBroker(today=[bar(OPEN), bar(OPEN + timedelta(minutes=1))])
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)

    assert len(cache.get(STOCK, MINUTE, 10)) == 2


async def test_settled_history_is_fetched_once_and_kept() -> None:
    """A closed day's candles are the same on every request for ever."""
    broker = FakeBroker(settled=[bar(OPEN - timedelta(days=1))])
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)
    settled_calls = len([call for call in broker.calls if call[1].time() == call[1].time().min])
    await cache.refresh_due(session_start=OPEN)

    after = len([call for call in broker.calls if call[1].time() == call[1].time().min])
    assert settled_calls == 1
    assert after == 1


async def test_today_is_refetched_when_it_falls_behind() -> None:
    broker = FakeBroker(today=[bar(OPEN)])
    clock = ReplayClock(OPEN + timedelta(minutes=1))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)
    before = len(broker.calls)

    await clock.advance_by(timedelta(minutes=10))
    await cache.refresh_due(session_start=OPEN)

    assert len(broker.calls) > before


async def test_today_is_not_refetched_while_it_is_current() -> None:
    broker = FakeBroker(today=[bar(OPEN)])
    cache = cache_at(broker, OPEN + timedelta(minutes=1))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)
    before = len(broker.calls)
    await cache.refresh_due(session_start=OPEN)

    assert len(broker.calls) == before


async def test_settled_and_today_come_back_together() -> None:
    broker = FakeBroker(
        settled=[bar(OPEN - timedelta(days=1))], today=[bar(OPEN), bar(OPEN + timedelta(minutes=1))]
    )
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)

    assert len(cache.get(STOCK, MINUTE, 10)) == 3


async def test_only_closed_bars_are_served() -> None:
    """The bar still forming is a guess that will change."""
    broker = FakeBroker(today=[bar(OPEN), bar(OPEN + timedelta(minutes=1))])
    cache = cache_at(broker, OPEN + timedelta(minutes=1, seconds=30))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)

    assert len(cache.get(STOCK, MINUTE, 10)) == 1


async def test_only_the_last_n_are_returned() -> None:
    broker = FakeBroker(today=[bar(OPEN + timedelta(minutes=n)) for n in range(10)])
    cache = cache_at(broker, OPEN + timedelta(hours=1))
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)

    assert len(cache.get(STOCK, MINUTE, 3)) == 3


# -- when the broker will not answer ----------------------------------------


async def test_a_failure_leaves_what_was_there(caplog: pytest.LogCaptureFixture) -> None:
    broker = FakeBroker(today=[bar(OPEN)])
    clock = ReplayClock(OPEN + timedelta(minutes=1))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)

    broker.fails_with = RuntimeError("the broker is having a moment")
    await clock.advance_by(timedelta(minutes=10))
    await cache.refresh_due(session_start=OPEN)

    assert len(cache.get(STOCK, MINUTE, 10)) == 1


async def test_a_failure_does_not_stop_the_other_series() -> None:
    """One broker hiccup must not stop every strategy that reads candles."""
    other = InstrumentId("NSE:TCS")
    broker = FakeBroker(today=[bar(OPEN)])
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)
    cache.wants(other, MINUTE)

    fetched = await cache.refresh_due(session_start=OPEN)

    assert fetched > 0


async def test_a_failed_series_is_not_retried_immediately() -> None:
    """Retrying at once hammers a broker that is already struggling."""
    broker = FakeBroker(fails_with=RuntimeError("down"))
    clock = ReplayClock(OPEN + timedelta(minutes=5))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)
    after_first = len(broker.calls)
    await clock.advance_by(timedelta(seconds=30))
    await cache.refresh_due(session_start=OPEN)

    assert len(broker.calls) == after_first


async def test_a_failed_series_is_retried_the_same_day() -> None:
    """Marking it done on failure would lose it until tomorrow."""
    broker = FakeBroker(fails_with=RuntimeError("down"))
    clock = ReplayClock(OPEN + timedelta(minutes=5))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)
    after_first = len(broker.calls)

    await clock.advance_by(FAILURE_BACKOFF + timedelta(seconds=1))
    broker.fails_with = None
    broker.today = [bar(OPEN)]
    await cache.refresh_due(session_start=OPEN)

    assert len(broker.calls) > after_first
    assert len(cache.get(STOCK, MINUTE, 10)) == 1


async def test_an_expired_session_stops_the_series_rather_than_looping() -> None:
    """A dead token cannot recover on its own, and retrying it every few
    minutes hides the one thing an operator needs to be told."""
    broker = FakeBroker(fails_with=AuthExpiredError("the session is gone"))
    clock = ReplayClock(OPEN + timedelta(minutes=5))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)
    after_first = len(broker.calls)
    await clock.advance_by(timedelta(hours=1))
    await cache.refresh_due(session_start=OPEN)

    assert len(broker.calls) == after_first
    assert Want(STOCK, MINUTE) in cache.stopped_for_login


# -- the day ----------------------------------------------------------------


async def test_a_new_day_forgets_today_s_candles() -> None:
    broker = FakeBroker(today=[bar(OPEN)])
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)

    cache.forget_today()

    assert cache.get(STOCK, MINUTE, 10) == ()


async def test_a_new_day_gives_a_stopped_series_another_go() -> None:
    """A new session is the usual reason a new day starts."""
    broker = FakeBroker(fails_with=AuthExpiredError("gone"))
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)

    cache.forget_today()

    assert cache.stopped_for_login == frozenset()


async def test_settled_history_is_refetched_on_a_new_day() -> None:
    """Yesterday's today is today's yesterday."""
    broker = FakeBroker(settled=[bar(OPEN - timedelta(days=1))])
    clock = ReplayClock(OPEN + timedelta(minutes=5))
    cache = CandleCache(source=broker, clock=clock)
    cache.wants(STOCK, MINUTE)
    await cache.refresh_due(session_start=OPEN)
    before = _settled_calls(broker)

    await clock.advance_by(timedelta(days=1))
    await cache.refresh_due(session_start=OPEN + timedelta(days=1))

    assert _settled_calls(broker) == before + 1


def _settled_calls(broker: FakeBroker) -> int:
    """Requests for closed days, which end at midnight."""
    return len([call for call in broker.calls if call[1].time() == call[1].time().min])


async def test_todays_bars_do_not_arrive_twice() -> None:
    """A broker asked for history up to midnight may include the boundary, and
    today's fetch will return the same bar again. Counted twice, an indicator
    over the series is wrong in a way that looks plausible."""
    broker = FakeBroker(
        settled=[bar(OPEN - timedelta(days=1)), bar(OPEN)],
        today=[bar(OPEN)],
    )
    cache = cache_at(broker, OPEN + timedelta(minutes=5))
    cache.wants(STOCK, MINUTE)

    await cache.refresh_due(session_start=OPEN)

    starts = [candle.start for candle in cache.get(STOCK, MINUTE, 10)]
    assert starts == sorted(set(starts))
