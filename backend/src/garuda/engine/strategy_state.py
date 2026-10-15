"""What a subscription remembers about its own day.

The reference's `StrategyState`, one per subscription per trading day
(`STRATEGY_ENGINE.md` §6). The field that matters most is which tranches
have fired: it is what stops a restart at 13:05 from entering again a
tranche that went on at 13:00.

Immutable; every change returns a new state, and :meth:`critical_change`
says whether the difference must be written now rather than at the next
periodic flush -- the reference's `hasCriticalDifferencesFrom`.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from decimal import Decimal
from typing import Any

from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError


@dataclass(frozen=True)
class StrategyState:
    trading_client: TradingClientId
    strategy: str
    trading_day: dt.date
    #: Tranche number to when it signalled.
    signalled: Mapping[int, dt.datetime] = field(default_factory=dict)
    last_tranche_signalled: int = 0
    signals_generated_today: int = 0
    used_risk: Decimal = Decimal(0)
    allocated_lots_today: int = 0
    evaluation_count: int = 0
    signal_count: int = 0
    last_evaluation_at: dt.datetime | None = None
    last_signal_at: dt.datetime | None = None
    #: Owned by direction providers and custom strategies, each under its own
    #: namespaced key.
    data: Mapping[str, Any] = field(default_factory=dict)

    def has_signalled(self, tranche: int) -> bool:
        return tranche in self.signalled

    def evaluated(self, at: dt.datetime) -> StrategyState:
        return replace(self, evaluation_count=self.evaluation_count + 1, last_evaluation_at=at)

    def tranche_signalled(
        self, tranche: int, at: dt.datetime, *, signals: int, lots: int
    ) -> StrategyState:
        if tranche in self.signalled:
            raise DomainError(
                f"{self.strategy} on {self.trading_client.value}: tranche {tranche} has "
                "already signalled today; signalling it again would enter it twice"
            )
        return replace(
            self,
            signalled={**self.signalled, tranche: at},
            last_tranche_signalled=max(self.last_tranche_signalled, tranche),
            signals_generated_today=self.signals_generated_today + signals,
            allocated_lots_today=self.allocated_lots_today + lots,
            signal_count=self.signal_count + 1,
            last_signal_at=at,
        )

    def critical_change(self, before: StrategyState) -> bool:
        """Whether this must be written now. Counters alone can wait."""
        return (
            self.signalled != before.signalled
            or self.last_tranche_signalled != before.last_tranche_signalled
            or self.used_risk != before.used_risk
            or self.allocated_lots_today != before.allocated_lots_today
            or self.signals_generated_today != before.signals_generated_today
            or self.data != before.data
        )

    # -- the stored shape --------------------------------------------------

    def to_json(self) -> dict[str, Any]:
        return {
            "signalled": {str(n): at.isoformat() for n, at in sorted(self.signalled.items())},
            "lastTrancheSignalled": self.last_tranche_signalled,
            "signalsGeneratedToday": self.signals_generated_today,
            "usedRisk": str(self.used_risk),
            "allocatedLotsToday": self.allocated_lots_today,
            "data": dict(self.data),
        }

    @classmethod
    def from_json(
        cls,
        trading_client: TradingClientId,
        strategy: str,
        trading_day: dt.date,
        stored: Mapping[str, Any],
        *,
        evaluation_count: int = 0,
        signal_count: int = 0,
        last_evaluation_at: dt.datetime | None = None,
        last_signal_at: dt.datetime | None = None,
    ) -> StrategyState:
        raw = stored.get("signalled") or {}
        if not isinstance(raw, Mapping):
            raise DomainError(f"{strategy}: stored state's signalled tranches are not a map")
        data = stored.get("data") or {}
        return cls(
            trading_client=trading_client,
            strategy=strategy,
            trading_day=trading_day,
            signalled={int(n): dt.datetime.fromisoformat(str(at)) for n, at in raw.items()},
            last_tranche_signalled=int(stored.get("lastTrancheSignalled") or 0),
            signals_generated_today=int(stored.get("signalsGeneratedToday") or 0),
            used_risk=Decimal(str(stored.get("usedRisk") or "0")),
            allocated_lots_today=int(stored.get("allocatedLotsToday") or 0),
            evaluation_count=evaluation_count,
            signal_count=signal_count,
            last_evaluation_at=last_evaluation_at,
            last_signal_at=last_signal_at,
            data=dict(data) if isinstance(data, Mapping) else {},
        )
