"""Trading clients.

A trading client is one broker account. The operator manages several -- their
own and their family's -- and every order, position and subscription is scoped
to one of them.

This replaces the reference engine's user/broker pair. There is exactly one
login identity for the product itself, so a "user" in the old sense no longer
exists; what remains is the set of accounts orders can be routed to.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from garuda.domain.errors import DomainError


class BrokerCode(StrEnum):
    ZERODHA = "ZERODHA"
    FYERS = "FYERS"
    KOTAK = "KOTAK"
    DHAN = "DHAN"
    #: Not a venue. Orders routed here are simulated in process; see the paper
    #: broker. A subscription chooses paper or live, so the same strategy can
    #: run both ways on different accounts at the same time.
    PAPER = "PAPER"


@dataclass(frozen=True, slots=True)
class TradingClientId:
    value: str

    def __post_init__(self) -> None:
        if not self.value or self.value.strip() != self.value:
            raise DomainError(f"trading client id {self.value!r} is empty or padded")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True, slots=True)
class TradingClient:
    """One broker account.

    ``display_name`` is what the Console shows and is unique on its own, so an
    operator running three Zerodha accounts can tell them apart by name rather
    than by client id. ``(broker, client_id)`` is unique too: the same account
    cannot be registered twice.
    """

    id: TradingClientId
    display_name: str
    broker: BrokerCode
    client_id: str
    enabled: bool = True

    def __post_init__(self) -> None:
        if not self.display_name.strip():
            raise DomainError(f"{self.id}: a trading client needs a display name")
        if self.display_name.strip() != self.display_name:
            raise DomainError(f"display name {self.display_name!r} is padded")
        if not self.client_id.strip():
            raise DomainError(f"{self.id}: a trading client needs a broker client id")

    @property
    def account_key(self) -> tuple[BrokerCode, str]:
        """The natural key. Unique across all trading clients."""
        return (self.broker, self.client_id)

    def __str__(self) -> str:
        return f"{self.display_name} ({self.broker}:{self.client_id})"
