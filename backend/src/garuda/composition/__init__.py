"""The composition root.

The one place that knows about every layer at once: it reads configuration,
builds the adapters, wires the services together and hands the result to the
runner. Nothing below it may import from here, which is what keeps the rest of
the dependencies pointing downward.
"""

from garuda.composition.accounts import build_resolver, load_accounts, load_sessions
from garuda.composition.engine import ClientParts, Engine, EngineParts, build_engine
from garuda.composition.instruments import build_loader, load_symbols
from garuda.composition.persistence import TradePersistence
from garuda.composition.runtime import Runtime, start
from garuda.composition.venues import Venues, load_venues

__all__ = [
    "ClientParts",
    "Engine",
    "EngineParts",
    "Runtime",
    "TradePersistence",
    "Venues",
    "build_engine",
    "build_loader",
    "build_resolver",
    "load_accounts",
    "load_sessions",
    "load_symbols",
    "load_venues",
    "start",
]
