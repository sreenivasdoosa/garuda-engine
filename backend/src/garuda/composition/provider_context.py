"""Everything an adapter factory might need, in one place.

The registry's factories are deliberately untyped in their arguments: the
composition root supplies them and each adapter takes what it needs. This is
that supply. One context is built per provider and splatted into the factory,
so adding a provider that needs a client id, or ports, or its own catalogue,
does not mean changing the call site for the providers that do not.

The rate gates are built here rather than inside an adapter because their
spacing is a row an operator edits, and because two adapters on the same
provider -- quotes and history -- must share one gate each or the limit is
enforced twice at half strength.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta
from typing import Any

import httpx

from garuda.brokers.websocket import Connector
from garuda.marketdata.registry import InstrumentRegistry
from garuda.marketdata.throttle import RateGate
from garuda.protocols.clock import Clock


@dataclass(frozen=True)
class ProviderContext:
    """What one provider's adapters are built from."""

    provider: str
    api_key: str
    access_token: str
    client_id: str
    registry: Callable[[], InstrumentRegistry]
    clock: Clock
    connector: Connector
    http: httpx.AsyncClient
    quote_gate: RateGate
    history_gate: RateGate
    #: The provider's own translation table, read through a callable because
    #: it is replaced whole every morning. An adapter holding this morning's
    #: would resolve this morning's strikes tomorrow.
    catalogue: Callable[[], Any]
    static_ip: str | None = None
    websocket_port: int | None = None
    history_port: int | None = None
    batch_size: int | None = None

    def as_kwargs(self) -> dict[str, Any]:
        return {
            "provider": self.provider,
            "api_key": self.api_key,
            "access_token": self.access_token,
            "client_id": self.client_id,
            "registry": self.registry,
            "clock": self.clock,
            "connector": self.connector,
            "http": self.http,
            "quote_gate": self.quote_gate,
            "history_gate": self.history_gate,
            "catalogue": self.catalogue,
            "static_ip": self.static_ip,
            "websocket_port": self.websocket_port,
            "history_port": self.history_port,
            "batch_size": self.batch_size,
        }


def gates(quote_ms: int, history_ms: int, clock: Clock) -> tuple[RateGate, RateGate]:
    """One gate per kind. Separate, because providers meter them separately
    and a history sweep must not spend the budget a quote needs to size an
    order."""
    return (
        RateGate(timedelta(milliseconds=max(quote_ms, 0)), clock),
        RateGate(timedelta(milliseconds=max(history_ms, 0)), clock),
    )
