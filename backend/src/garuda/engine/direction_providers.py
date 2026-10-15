"""Direction providers: which way a directional strategy trades.

`STRATEGY_ENGINE.md` §4 step 3. A provider answers LONG, SHORT, BOTH or
declines; "LONG" always means *bullish*, and what that trades is the leg
shape's business (`OPTION_SELLING` sells the put on a bullish answer). A
definition names one provider by `direction_provider_type` and configures it
with `direction_provider_params`; the reference's `applicableDirection`
param then suppresses the side the operator does not want.

Providers are a registry, so adding one is a registration: a function from
its params to an object with ``decide``. Unknown names are refused at load,
by name.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Protocol

from garuda.domain.errors import DomainError


class Side(StrEnum):
    """A provider's answer."""

    LONG = "LONG"
    SHORT = "SHORT"
    #: Both sides at once: a non-directional pair, or a provider that sees no
    #: reason to prefer either.
    BOTH = "BOTH"


@dataclass(frozen=True, slots=True)
class Answer:
    side: Side | None
    because: str
    #: State the provider wants kept for its next call, under its own
    #: namespace. None leaves what it had.
    remember: Mapping[str, Any] | None = None

    @classmethod
    def declined(cls, because: str) -> Answer:
        return cls(None, because)


class DirectionContext(Protocol):
    """What a provider may consult. The strategy environment implements it;
    a provider that needs something richer asks for it by attribute and
    declines when it is absent, rather than guessing."""

    @property
    def memory(self) -> Mapping[str, Any]: ...


class DirectionProvider(Protocol):
    def decide(self, context: DirectionContext) -> Answer: ...


type ProviderFactory = Callable[[Mapping[str, Any]], DirectionProvider]

_PROVIDERS: dict[str, ProviderFactory] = {}


def provider(name: str) -> Callable[[ProviderFactory], ProviderFactory]:
    """Register a provider under the name a definition stores."""

    def register(factory: ProviderFactory) -> ProviderFactory:
        key = name.strip().upper()
        if key in _PROVIDERS:
            raise DomainError(f"direction provider {key} is registered twice")
        _PROVIDERS[key] = factory
        return factory

    return register


def registered() -> tuple[str, ...]:
    return tuple(sorted(_PROVIDERS))


def build(name: str, params: Mapping[str, Any]) -> DirectionProvider:
    key = (name or "").strip().upper()
    factory = _PROVIDERS.get(key)
    if factory is None:
        raise DomainError(
            f"direction provider {name!r} is not one of {', '.join(registered()) or 'none'}"
        )
    try:
        return factory(params)
    except DomainError:
        raise
    except (TypeError, ValueError, KeyError) as error:
        raise DomainError(f"direction provider {key}: {error}") from None


def applicable(side: Side | None, params: Mapping[str, Any], *, provider_name: str) -> Side | None:
    """The reference's `applyApplicableDirectionFilter`.

    ``applicableDirection`` of LONG or SHORT suppresses the other side; BOTH
    or absent lets either through. FIXED is never filtered: the operator
    already said which way.
    """
    if side is None or provider_name.strip().upper() == "FIXED":
        return side
    wanted = str(params.get("applicableDirection") or "BOTH").strip().upper()
    if wanted in ("", "BOTH"):
        return side
    if wanted not in ("LONG", "SHORT"):
        raise DomainError(f"applicableDirection {wanted!r} is not LONG, SHORT or BOTH")
    if side is Side.BOTH:
        return Side(wanted)
    return side if side.value == wanted else None


@provider("FIXED")
def _fixed(params: Mapping[str, Any]) -> DirectionProvider:
    return FixedProvider.of(params)


@dataclass(frozen=True, slots=True)
class FixedProvider:
    """Always the configured way. NONE, blank or anything else means no trade,
    as the reference reads it."""

    side: Side | None

    @classmethod
    def of(cls, params: Mapping[str, Any]) -> FixedProvider:
        named = str(params.get("direction") or "").strip().upper()
        return cls(Side(named) if named in ("LONG", "SHORT") else None)

    def decide(self, context: DirectionContext) -> Answer:
        del context
        if self.side is None:
            return Answer.declined("FIXED provider has no direction configured")
        return Answer(self.side, f"FIXED {self.side.value}")
