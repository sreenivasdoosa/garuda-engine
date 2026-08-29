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

Separately from either, an alert may or may not interrupt the operator. Every
alert is recorded and every alert reaches anything listening; only some raise
a toast in the Console. Warnings and criticals always do. Informational ones
do not unless the caller asks, because a restart otherwise fires a toast per
account for every socket that connected -- which trains the operator to
dismiss toasts without reading them, and that is worse than having none.

The toast is published after the alert is stored, never before, so the Console
never shows something that is not yet durable.
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

#: Informational alerts whose content is already recorded somewhere better --
#: the trade store and the log -- and which at scale were most of what the
#: reference engine's alert table held. Dropped at INFO unless the caller
#: explicitly wants the operator told; the same operation at WARNING or
#: CRITICAL is a real signal and is always kept.
NOT_WORTH_STORING_AT_INFO: frozenset[str] = frozenset(
    {"trade-entry", "trade-exit", "square-off", "square-off-all"}
)
#: These are the *routine* forms of those events. A related operation that is
#: not routine -- "square-off-stopped", say, meaning the engine has given up --
#: is deliberately named differently so it is never swept up by the rule above.
#: Naming it "square-off" would silently discard the one record an operator has
#: that a position was left open.

#: Occurrence counts at which a recurring problem is worth interrupting the
#: operator again. Between them the count advances silently and the Alerts
#: page shows it; a toast per occurrence is how a storm becomes unreadable.
COUNT_MILESTONES: frozenset[int] = frozenset({10, 100, 1000})


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
        notify_ui: bool = False,
    ) -> Alert | None:
        """Worth recording. Set ``notify_ui`` for the few worth interrupting for."""
        return await self.raise_alert(
            AlertLevel.INFO, entity_type, entity, operation, message, key=key, notify_ui=notify_ui
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
        notify_ui: bool = False,
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

        if not self._worth_storing(alert, notify_ui):
            # Already in the trade store and the log. Recording it again was
            # most of what the reference engine's alert table held.
            _log(alert)
            return None

        previous: Alert | None = None
        if key is not None:
            previous = self._open.get((day, key))
            if previous is not None:
                alert = previous.merged_with(alert)
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

        # After the store, never before: the Console must not show a toast for
        # something that is not yet durable.
        if self._should_interrupt(alert, previous, notify_ui):
            await self.bus.publish(Topic.UI, alert)
        return alert

    @staticmethod
    def _worth_storing(alert: Alert, notify_ui: bool) -> bool:
        if alert.level is not AlertLevel.INFO or notify_ui:
            return True
        return alert.operation not in NOT_WORTH_STORING_AT_INFO

    @staticmethod
    def _should_interrupt(alert: Alert, previous: Alert | None, notify_ui: bool) -> bool:
        """Whether this raises a toast rather than only appearing on the page.

        A recurring problem interrupts on its first occurrence, at a
        milestone, and when it becomes critical having not been. In between,
        the count advances quietly.
        """
        if not (alert.level.demands_attention or notify_ui):
            return False
        if previous is None:
            return True
        if alert.occurrences in COUNT_MILESTONES:
            return True
        return alert.level is AlertLevel.CRITICAL and previous.level is not AlertLevel.CRITICAL

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
