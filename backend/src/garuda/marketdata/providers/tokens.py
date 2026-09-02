"""Mapping the engine's instruments to a provider's own identifiers.

Every provider names an instrument differently: Zerodha has a numeric token,
Dhan a segment and a security id, Fyers a symbol string, XTS an exchange
instrument id. Subscribing, quoting and asking for candles all need the
provider's name for a thing the engine knows by :class:`InstrumentId`.

**This is a token map, not a second instrument master.** The reference
market-data service gives each provider a full catalogue — expiries, option
chains, strike lookup, the lot — and each is another seven hundred lines that
can disagree with the others about when NIFTY expires. Garuda has one
`InstrumentRegistry` that already answers those questions and is what the
strike selectors are built on, so a provider adapter needs only the
translation, and cannot hold a different opinion about the instrument itself.

What a provider's master parser must still do is rebuild the *canonical*
trading symbol from the contract's own fields, because that is the name the
registry is keyed by. That part is genuinely provider-specific and is ported
as it stands.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from garuda.domain.instrument import InstrumentId


@runtime_checkable
class ProviderTokens(Protocol):
    """One provider's names for the instruments the engine knows."""

    @property
    def provider(self) -> str: ...

    def token_for(self, instrument: InstrumentId) -> str | None:
        """The provider's identifier, or None when it does not list it."""
        ...

    def instrument_for(self, token: str) -> InstrumentId | None:
        """Back the other way, for turning a tick into something the engine
        can route. None when the token is not one we subscribed to."""
        ...


@dataclass(frozen=True)
class TokenMap:
    """A finished translation, both ways.

    Built once when a provider's master is loaded and treated as immutable:
    the map changes when the master is reloaded, which replaces it whole.
    """

    provider: str
    _forward: Mapping[InstrumentId, str]
    _reverse: Mapping[str, InstrumentId]

    @classmethod
    def of(cls, provider: str, pairs: Iterable[tuple[InstrumentId, str]]) -> TokenMap:
        forward: dict[InstrumentId, str] = {}
        reverse: dict[str, InstrumentId] = {}
        for instrument, token in pairs:
            forward[instrument] = token
            reverse[token] = instrument
        return cls(provider=provider, _forward=forward, _reverse=reverse)

    def token_for(self, instrument: InstrumentId) -> str | None:
        return self._forward.get(instrument)

    def instrument_for(self, token: str) -> InstrumentId | None:
        return self._reverse.get(token)

    def __len__(self) -> int:
        return len(self._forward)
