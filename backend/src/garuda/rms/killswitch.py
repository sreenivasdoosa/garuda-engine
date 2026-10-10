"""Stopping an account, a venue, an instrument, or everything.

An operator's hand on the brake. Distinct from every other risk check in what
it means: the limits describe what a strategy may do, and this describes what
the operator has decided it may not, whatever the limits say.

**Scoped, and the widest scope wins the explanation.** A global stop, one on a
venue, one on an underlying, one on an account. All four are checked and the
first that applies is the reason given, widest first, because "everything is
stopped" is a better answer than "this account is stopped" when both are true.

**No broker scope.** Stopping every account at one broker is what
``brokers.stopped`` does, and two places deciding the same thing means the
wrong one wins on the day they disagree.

**A source can be switched off.** The reference keeps a row per source in
``kill_switch_types`` so a class of switch can be disabled without removing
the switches themselves -- an operator turning off automatic loss stops for a
morning, without losing the record of what fired. A switch from a disabled
source does not apply and is not an error.

Nothing here creates a switch. Every one in the table today is one an operator
set; the reference also raises them automatically from a daily loss, a
volatility circuit or a rejection rate, and none of that is built. Garuda
refuses at the loss limit through `DailyLossCheck` instead, which stops the
same orders without the state machine that decides when an automatic switch
may re-fire.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from garuda.rms.scope import names_of

if TYPE_CHECKING:
    from collections.abc import Sequence

    from garuda.domain.client import TradingClientId
    from garuda.domain.instrument import Instrument

#: The source every operator-set switch carries. The column is wider because
#: the reference fills it with what raised the switch, and everything that
#: raises one automatically is unbuilt here.
MANUAL = "MANUAL"


@dataclass(frozen=True, slots=True)
class KillSwitchScope:
    """What one switch stops. Every field None is a global stop."""

    trading_client: str | None = None
    exchange: str | None = None
    symbol: str | None = None

    def covers(self, instrument: Instrument, trading_client: TradingClientId) -> bool:
        if self.trading_client is not None and self.trading_client != trading_client.value:
            return False
        if self.exchange is not None and self.exchange != instrument.exchange.code:
            return False
        return self.symbol is None or self.symbol in names_of(instrument)

    @property
    def breadth(self) -> int:
        """How much this stops. Lower is wider, so a sort reports the widest.

        A global stop is the whole engine and an account-scoped one is a
        corner of it, and when both apply the operator wants to hear the one
        that explains the most.
        """
        return (
            (1 if self.exchange is not None else 0)
            + (2 if self.symbol is not None else 0)
            + (4 if self.trading_client is not None else 0)
        )

    def __str__(self) -> str:
        parts = [
            f"{label} {value}"
            for label, value in (
                ("exchange", self.exchange),
                ("symbol", self.symbol),
                ("account", self.trading_client),
            )
            if value is not None
        ]
        return " and ".join(parts) if parts else "everything"


@dataclass(frozen=True, slots=True)
class ActiveKillSwitch:
    """One switch an operator set and has not removed."""

    scope: KillSwitchScope
    reason: str | None = None
    source: str = MANUAL

    def __str__(self) -> str:
        because = f": {self.reason}" if self.reason else ""
        return f"kill switch on {self.scope}{because}"


class KillSwitch:
    """Every switch in force, resolved per order.

    A book rather than a value: every account's placement holds the same
    one, and the Kill Switches page swaps its contents while the engine
    runs. A stop set at 10:31 has to stop the order at 10:31:02, not the
    one after the next restart.
    """

    def __init__(self, switches: Sequence[ActiveKillSwitch] = ()) -> None:
        self._switches: tuple[ActiveKillSwitch, ...] = tuple(switches)
        self.version = 0

    @property
    def switches(self) -> tuple[ActiveKillSwitch, ...]:
        return self._switches

    def reason_for(self, instrument: Instrument, trading_client: TradingClientId) -> str | None:
        """Why this order may not go, or None."""
        covering = sorted(
            (
                switch
                for switch in self._switches
                if switch.scope.covers(instrument, trading_client)
            ),
            key=lambda switch: switch.scope.breadth,
        )
        return str(covering[0]) if covering else None

    def replace(self, switches: Sequence[ActiveKillSwitch]) -> None:
        """Take the table whole: a switch turned off has to stop applying."""
        self._switches = tuple(switches)
        self.version += 1

    @property
    def is_active(self) -> bool:
        return bool(self._switches)

    def __len__(self) -> int:
        return len(self._switches)

    def __eq__(self, other: object) -> bool:
        return isinstance(other, KillSwitch) and other._switches == self._switches

    __hash__ = None  # type: ignore[assignment]


#: What a placement holds when it was wired without a book. Shared, so it
#: is never replaced into: an engine that can be stopped from the Console
#: builds its own book and hands that to every account.
NOTHING_STOPPED = KillSwitch()
