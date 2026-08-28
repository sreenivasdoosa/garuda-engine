"""Instrument selectors.

Asset class lives on the leg, not on the strategy. Each selector knows how to
pick one kind of instrument; the evaluator knows none of it.

This phase ships the fixed selector, which is enough to run a strategy end to
end. Option strike, expiry and underlying-future selection arrive with the
phase that needs them, and they are registrations rather than changes to the
evaluator -- which is the whole reason there is only one evaluator.
"""

from __future__ import annotations

from dataclasses import dataclass

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId


@dataclass(frozen=True, slots=True)
class FixedInstrumentSelector:
    """Always the same instrument, named up front."""

    instrument: InstrumentId

    def select(self, underlying: InstrumentId, context: object) -> InstrumentId | None:  # noqa: ARG002
        return self.instrument


@dataclass(frozen=True, slots=True)
class UnderlyingSelector:
    """The strategy's own underlying — an equity or index traded directly."""

    def select(self, underlying: InstrumentId, context: object) -> InstrumentId | None:  # noqa: ARG002
        if not underlying.value:  # pragma: no cover - InstrumentId refuses this
            raise DomainError("no underlying to select")
        return underlying
