"""The risk gate.

**Every intent passes through here, and there is no path around it.** It is the
last line of defence against a strategy bug placing a thousand orders in a
loop, so it is a core safety component rather than a feature.

Three properties matter more than the individual checks:

* **Fail closed.** A check that raises is a veto, not a shrug. A gate that
  cannot answer must not wave the order through.
* **Every breach is reported, not just the first.** Short-circuiting would tell
  an operator the spread was wide and hide that the kill switch was also on.
* **The gate decides nothing about what to do next.** It reports. Halting,
  alerting and retrying belong to the caller.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Protocol, runtime_checkable

from garuda.domain.client import TradingClientId
from garuda.domain.instrument import Instrument
from garuda.domain.market import Tick
from garuda.domain.money import Money
from garuda.domain.order import OrderRequest
from garuda.domain.position import Position
from garuda.rms.breaches import BreachType
from garuda.rms.limits import RiskLimits


@dataclass(frozen=True, slots=True)
class Breach:
    """One reason an order was refused."""

    type: BreachType
    detail: str
    #: What was measured and what was allowed, kept apart from the sentence
    #: as well as in it. The sentence is for a person reading one refusal;
    #: these are for querying a day of them -- "every volume breach under
    #: five hundred" is a question the detail cannot answer.
    current: str | None = None
    limit: str | None = None

    def __str__(self) -> str:
        return f"{self.type}: {self.detail}"


@dataclass(frozen=True, slots=True)
class RiskContext:
    """Everything the checks are allowed to see.

    Passed rather than fetched, so a check is a pure function and can be tested
    without a broker, a feed or a database.
    """

    request: OrderRequest
    instrument: Instrument
    now: datetime
    limits: RiskLimits
    quote: Tick | None = None
    position: Position | None = None
    market_open: bool = True
    kill_switch_reason: str | None = None
    #: What the account has actually lost or made today, realised. Typed
    #: rather than left open: it was `object` and nothing read it, which is
    #: how the daily loss limit came to be configurable and unenforced.
    realized_pnl_today: Money | None = None
    #: What the engine's own book holds on the side this order would close,
    #: gross. Only meaningful on an exit, and None when the placing path did
    #: not supply one — which reads as "no bound available", never as zero.
    open_quantity: int | None = None
    #: What the book already holds or has resting on the side this order
    #: would take on, for a cap on position size. None when the placing path
    #: did not supply one.
    committed_quantity: int | None = None
    #: Whether this order is leaving a position rather than taking one.
    #:
    #: An exit is checked, but not by everything: a limit that stops an
    #: account taking more risk must not stop it leaving the risk it has, so
    #: the checks that would prevent closing stand down. Which ones is each
    #: check's own answer, not this flag's.
    is_exit: bool = False


@runtime_checkable
class RiskCheck(Protocol):
    """One rule. Returns a breach, or None if it has nothing to say."""

    @property
    def breach_type(self) -> BreachType: ...

    @property
    def guards_exits(self) -> bool:
        """Whether this check has any business stopping an exit.

        Most do not. A check that caps how much risk an account may take is
        about entries by definition, and running it against an exit would trap
        a position on exactly the day the cap was reached. The few that answer
        True are the ones a broker would refuse anyway, or that protect the
        exit itself.
        """
        ...

    def __call__(self, context: RiskContext) -> Breach | None: ...


@dataclass(frozen=True)
class RiskDecision:
    """What the gate concluded."""

    breaches: tuple[Breach, ...] = field(default_factory=tuple)

    @property
    def allowed(self) -> bool:
        return not self.breaches

    @property
    def reason(self) -> str:
        return "; ".join(str(breach) for breach in self.breaches)

    def has(self, breach_type: BreachType) -> bool:
        return any(breach.type is breach_type for breach in self.breaches)


class RiskGate:
    """Runs every check and reports everything that failed."""

    def __init__(self, checks: Sequence[RiskCheck]) -> None:
        self._checks = tuple(checks)

    @property
    def checks(self) -> tuple[RiskCheck, ...]:
        return self._checks

    def evaluate(self, context: RiskContext) -> RiskDecision:
        breaches: list[Breach] = []
        for check in self._checks:
            if context.is_exit and not check.guards_exits:
                continue
            try:
                breach = check(context)
            except Exception as error:
                breaches.append(
                    Breach(
                        BreachType.CHECK_FAILED,
                        f"{type(check).__name__} raised {type(error).__name__}: {error}",
                    )
                )
                continue
            if breach is not None:
                breaches.append(breach)
        return RiskDecision(breaches=tuple(breaches))


@dataclass(frozen=True, slots=True)
class KillSwitch:
    """A scoped stop.

    Global first, then per trading client. An operator hitting the global one
    at 09:20 expects nothing further to leave the process, whatever any
    strategy thinks.
    """

    global_reason: str | None = None
    client_reasons: frozenset[tuple[TradingClientId, str]] = field(default_factory=frozenset)

    def reason_for(self, client: TradingClientId) -> str | None:
        if self.global_reason is not None:
            return f"global kill switch: {self.global_reason}"
        for held, reason in self.client_reasons:
            if held == client:
                return f"kill switch on {client}: {reason}"
        return None

    @property
    def is_active(self) -> bool:
        return self.global_reason is not None or bool(self.client_reasons)
