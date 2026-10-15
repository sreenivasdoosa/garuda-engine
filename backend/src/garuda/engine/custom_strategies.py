"""Custom strategies: code for what the configuration cannot express.

`STRATEGY_ENGINE.md` §7. A developer subclasses `BaseStrategy`, overrides the
hooks they need, and registers the class under a name; a definition names it
in `strategy_class`. Everything around the hooks -- the schedule, the state,
the ids, slicing, delivery, trade management, risk -- stays the engine's.

    from garuda.engine import BaseStrategy, strategy

    @strategy("MY_EXPIRY_SCALPER")
    class MyExpiryScalper(BaseStrategy):
        def direction(self, ev):
            ...

Classes are found two ways at startup: an installed package's
``garuda.strategies`` entry point, or a module in ``<app home>/plugins/``.
Core registers none. An unknown name on a definition is refused at save and
at load, never run as the base by mistake.
"""

from __future__ import annotations

from collections.abc import Callable

from garuda.domain.errors import DomainError
from garuda.engine.base_strategy import BaseStrategy

_REGISTERED: dict[str, type[BaseStrategy]] = {}


def strategy(name: str) -> Callable[[type[BaseStrategy]], type[BaseStrategy]]:
    """Register a custom strategy class under the name a definition stores."""
    key = name.strip().upper()
    if not key:
        raise DomainError("a custom strategy needs a name")

    def register(cls: type[BaseStrategy]) -> type[BaseStrategy]:
        if not issubclass(cls, BaseStrategy):
            raise DomainError(f"{cls.__name__} is not a BaseStrategy")
        existing = _REGISTERED.get(key)
        if existing is not None and existing is not cls:
            raise DomainError(f"custom strategy {key} is registered twice")
        cls.name = key
        _REGISTERED[key] = cls
        return cls

    return register


def registered() -> tuple[str, ...]:
    return tuple(sorted(_REGISTERED))


def is_registered(name: str) -> bool:
    return name.strip().upper() in _REGISTERED


def instance(name: str | None) -> BaseStrategy | None:
    """The registered class's instance, or None for the configured base."""
    if not name:
        return None
    cls = _REGISTERED.get(name.strip().upper())
    if cls is None:
        raise DomainError(
            f"strategy class {name!r} is not registered; known: {', '.join(registered()) or 'none'}"
        )
    return cls()


def unregister(name: str) -> None:
    """For tests: forget a registration."""
    _REGISTERED.pop(name.strip().upper(), None)
