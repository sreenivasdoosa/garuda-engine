"""Raising alerts, without drowning the operator in them.

Every module calls this instead of only logging, because a log line is for
someone already looking and an alert is what makes them look. The log line
stays as well: it carries the internal identifiers the alert deliberately
leaves out.

Two mechanisms keep the list readable, and both were learned rather than
designed:

**Coalescing.** Alerts sharing a key on the same trading day are one alert
with a count. A socket flapping through the night produces one row saying it
happened two hundred times.

**Throttling.** Some things fire faster than a person can read even when each
one is genuinely distinct -- a tick decoder rejecting every packet of a
malformed stream. A throttled alert is raised at most once per interval, and
what it suppresses is counted so the next one can say how much was hidden.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from garuda.core.bus import InProcessEventBus
from garuda.domain.alert import Alert, AlertLevel, EntityType
from garuda.protocols.clock import Clock
from garuda.protocols.topics import Topic

logger = logging.getLogger(__name__)

#: How often a throttled alert may be raised. Long enough that a storm becomes
#: a handful of lines, short enough that a person watching sees it move.
DEFAULT_THROTTLE = timedelta(seconds=30)

#: Persists an alert, or updates the count of one already there. Injected so
#: the manager works with no database at all -- during tests, and during the
#: window at startup before one is connected.
type AlertSink = Callable[[Alert], Awaitable[None]]


@dataclass
class _Throttle:
    last_raised_at: datetime
    suppressed: int = 0


@dataclass
class AlertManager:
    """The one way anything tells the operator something."""

    clock: Clock
    bus: InProcessEventBus
    trading_day_for: Callable[[datetime], date]
    sink: AlertSink | None = None
    throttle_interval: timedelta = DEFAULT_THROTTLE

    _open: dict[tuple[date, str], Alert] = field(default_factory=dict)
    _throttles: dict[str, _Throttle] = field(default_factory=dict)

    async def info(
        self,
        entity_type: EntityType,
        entity: str,
        operation: str,
        message: str,
        *,
        key: str | None = None,
    ) -> Alert | None:
        return await self.raise_alert(
            AlertLevel.INFO, entity_type, entity, operation, message, key=key
        )

    async def warning(
        self,
        entity_type: EntityType,
        entity: str,
        operation: str,
        message: str,
        *,
        key: str | None = None,
    ) -> Alert | None:
        return await self.raise_alert(
            AlertLevel.WARNING, entity_type, entity, operation, message, key=key
        )

    async def critical(
        self,
        entity_type: EntityType,
        entity: str,
        operation: str,
        message: str,
        *,
        key: str | None = None,
    ) -> Alert | None:
        return await self.raise_alert(
            AlertLevel.CRITICAL, entity_type, entity, operation, message, key=key
        )

    async def raise_alert(
        self,
        level: AlertLevel,
        entity_type: EntityType,
        entity: str,
        operation: str,
        message: str,
        *,
        key: str | None = None,
    ) -> Alert | None:
        """Record and publish one alert, coalescing it if it has a key."""
        now = self.clock.now()
        day = self.trading_day_for(now)
        alert = Alert(
            level=level,
            entity_type=entity_type,
            entity=entity,
            operation=operation,
            message=message,
            raised_at=now,
            trading_day=day,
            key=key,
        )

        if key is not None:
            existing = self._open.get((day, key))
            if existing is not None:
                alert = existing.merged_with(alert)
            self._open[(day, key)] = alert

        _log(alert)
        await self.bus.publish(Topic.ALERTS, alert)
        if self.sink is not None:
            try:
                await self.sink(alert)
            except Exception as error:
                # An alert that cannot be stored must still have been seen. A
                # failure here is never allowed to propagate into the code
                # that was reporting a problem in the first place.
                logger.error("failed to store an alert: %s: %s", type(error).__name__, error)
        return alert

    async def throttled(
        self,
        level: AlertLevel,
        entity_type: EntityType,
        entity: str,
        operation: str,
        message: str,
        *,
        key: str,
    ) -> Alert | None:
        """Raise at most once per interval, saying how much was suppressed.

        Returns None when suppressed, so a caller can tell whether anything
        reached the operator.
        """
        now = self.clock.now()
        throttle = self._throttles.get(key)
        if throttle is not None and now - throttle.last_raised_at < self.throttle_interval:
            throttle.suppressed += 1
            return None

        suppressed = throttle.suppressed if throttle is not None else 0
        self._throttles[key] = _Throttle(last_raised_at=now)
        if suppressed:
            message = f"{message} ({suppressed} similar suppressed in the last interval)"
        return await self.raise_alert(level, entity_type, entity, operation, message, key=key)

    def open_alerts(self, day: date) -> Sequence[Alert]:
        """Everything coalesced on a day, most severe and most recent first."""
        alerts = [alert for (alert_day, _), alert in self._open.items() if alert_day == day]
        return sorted(alerts, key=lambda a: (a.level.demands_attention, a.raised_at), reverse=True)

    def forget_day(self, day: date) -> int:
        """Drop a day's coalescing state. Run at day-init.

        Without this a key raised yesterday keeps coalescing into yesterday's
        row and today's operator never sees it happen again.
        """
        keys = [entry for entry in self._open if entry[0] == day]
        for entry in keys:
            del self._open[entry]
        self._throttles.clear()
        return len(keys)


def _log(alert: Alert) -> None:
    line = alert.describe()
    if alert.level is AlertLevel.CRITICAL:
        logger.error(line)
    elif alert.level is AlertLevel.WARNING:
        logger.warning(line)
    else:
        logger.info(line)
