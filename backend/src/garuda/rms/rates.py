"""How much an account has sent, and how recently.

Four windows, and they are not the same kind of limit. **Per second** is the
broker's: Kite refuses the eleventh order in a second whatever anyone here
thinks, so the engine counting is about failing early with a clear reason
rather than about policy. **Per minute, per day, and per day on one
instrument** are policy: how much trading an operator is willing to have this
account do, which the broker has no opinion about.

That difference is why they are two checks. A stop-loss must go out on an
account that has hit its daily order cap -- the cap is about taking on risk --
while the same stop-loss genuinely cannot go out eleven-deep in one second,
because the broker will not take it.

**Only orders that were actually sent are counted.** The reference counts an
order as soon as its pre-trade checks pass, before the position and loss
checks have run, so an order refused later still consumes a slot. Its own
comment says as much about the daily counter, which it moved to count after
every check for exactly that reason; the per-second and per-minute counters
were left where they were. Here the count happens once, where the request
leaves for the broker, because a request that was never made used no rate.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import InstrumentId


@dataclass(frozen=True, slots=True)
class OrderCounts:
    """What an account has already sent, in each window."""

    this_second: int = 0
    this_minute: int = 0
    today: int = 0
    today_on_instrument: int = 0


class OrderRates:
    """Counts orders per account, per window.

    In memory and per process, which is what a rate limit is: a restart has
    sent nothing this second and nothing this minute. The daily count is the
    one a restart genuinely loses, and losing it errs towards letting an
    account keep trading rather than towards locking it out on the strength of
    a counter it cannot verify -- the broker's own daily cap is the backstop.
    """

    def __init__(self) -> None:
        self._seconds: dict[tuple[str, int], int] = defaultdict(int)
        self._minutes: dict[tuple[str, int], int] = defaultdict(int)
        self._days: dict[tuple[str, date], int] = defaultdict(int)
        self._instrument_days: dict[tuple[str, str, date], int] = defaultdict(int)

    def counted(
        self, trading_client: TradingClientId, instrument: InstrumentId, now: datetime
    ) -> OrderCounts:
        """What has gone before the order being considered."""
        who = trading_client.value
        return OrderCounts(
            this_second=self._seconds[(who, _second(now))],
            this_minute=self._minutes[(who, _minute(now))],
            today=self._days[(who, now.date())],
            today_on_instrument=self._instrument_days[(who, instrument.value, now.date())],
        )

    def record(
        self, trading_client: TradingClientId, instrument: InstrumentId, now: datetime
    ) -> None:
        """One order sent."""
        who = trading_client.value
        self._seconds[(who, _second(now))] += 1
        self._minutes[(who, _minute(now))] += 1
        self._days[(who, now.date())] += 1
        self._instrument_days[(who, instrument.value, now.date())] += 1
        self._forget_before(now)

    def _forget_before(self, now: datetime) -> None:
        """Drop windows that have passed.

        Without this a session leaves one entry per second per account behind
        it -- twenty-odd thousand by the close, for counts nothing will ask
        about again. The day buckets are kept: a day is the window.
        """
        second, minute, today = _second(now), _minute(now), now.date()
        for stale in [key for key in self._seconds if key[1] < second]:
            del self._seconds[stale]
        for passed in [key for key in self._minutes if key[1] < minute]:
            del self._minutes[passed]
        for yesterday in [key for key in self._days if key[1] < today]:
            del self._days[yesterday]
        for earlier in [key for key in self._instrument_days if key[2] < today]:
            del self._instrument_days[earlier]


def _second(now: datetime) -> int:
    return int(now.timestamp())


def _minute(now: datetime) -> int:
    return int(now.timestamp()) // 60
