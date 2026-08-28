"""Client order ids.

The id is the idempotency key: a retry after a timeout carries the same one, so
a broker that already accepted the first attempt rejects the duplicate instead
of placing a second order.

It is generated from a counter rather than a random UUID, deliberately.
Replaying a journal has to produce the same ids as the run that recorded it,
and a random id would differ on every replay -- which would make the replay
harness useless for exactly the comparisons it exists to make.
"""

from __future__ import annotations

from collections.abc import Iterable
from datetime import date

from garuda.domain.errors import DomainError
from garuda.domain.order import ClientOrderId


class ClientOrderIdSequence:
    """Monotonic, per trading day.

    On restart the counter resumes from the highest id already in the day's
    journal, so ids never collide across a crash.
    """

    def __init__(self, trading_day: date, *, start: int = 0, prefix: str = "gar") -> None:
        if start < 0:
            raise DomainError(f"client order id sequence cannot start at {start}")
        if not prefix.isidentifier():
            raise DomainError(f"client order id prefix {prefix!r} is not a plain identifier")
        self._trading_day = trading_day
        self._prefix = prefix
        self._counter = start

    @property
    def issued(self) -> int:
        return self._counter

    def next(self) -> ClientOrderId:
        self._counter += 1
        return ClientOrderId(f"{self._prefix}-{self._trading_day:%Y%m%d}-{self._counter:06d}")

    @classmethod
    def resuming_from(
        cls, trading_day: date, issued_ids: Iterable[object], *, prefix: str = "gar"
    ) -> ClientOrderIdSequence:
        """Continue after the highest id already issued for the day."""
        highest = 0
        for issued in issued_ids:
            value = str(issued)
            head, _, tail = value.rpartition("-")
            if head.startswith(f"{prefix}-") and tail.isdigit():
                highest = max(highest, int(tail))
        return cls(trading_day, start=highest, prefix=prefix)
