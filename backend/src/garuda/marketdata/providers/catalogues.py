"""Where each provider's translation table lives while the engine runs.

One holder, keyed by provider, swapped whole when a load succeeds -- the same
shape as :class:`InstrumentRegistryHolder` and for the same reason: a failed
reload must not leave an adapter reading half of yesterday's master and half
of today's.

A catalogue is deliberately untyped here. Dhan's is a segment and a security
id, Fyers' will be a symbol string, XTS's an exchange instrument id; what they
have in common is only that one provider adapter knows how to read its own.
The adapter asks for its provider's and casts; nothing generic reads inside.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import Any

logger = logging.getLogger(__name__)


class CatalogueHolder:
    """One translation table per provider."""

    def __init__(self, catalogues: Mapping[str, Any] | None = None) -> None:
        self._catalogues: dict[str, Any] = dict(catalogues or {})

    def publish(self, provider: str, catalogue: Any) -> None:
        self._catalogues[provider] = catalogue
        logger.info("%s catalogue published: %d instruments", provider, len(catalogue))

    def has(self, provider: str) -> bool:
        return provider in self._catalogues

    def for_provider(self, provider: str, empty: Any) -> Any:
        """That provider's table, or ``empty`` before its first load.

        Empty rather than an error: an engine can be built before any master
        has been downloaded, and every lookup on an empty catalogue answers
        "not listed", which is the truth at that moment.
        """
        return self._catalogues.get(provider, empty)
