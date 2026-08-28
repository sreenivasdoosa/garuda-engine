"""Domain-level errors.

These signal a violated invariant, never a transient condition. Nothing in the
domain layer catches them: a caller that sees one has a defect, not a retry.
"""

from __future__ import annotations


class DomainError(Exception):
    """Base for every domain invariant violation."""


class CurrencyMismatchError(DomainError):
    """Arithmetic was attempted between two different currencies.

    There is no implicit conversion anywhere in this engine. Conversion happens
    only at an explicit reporting boundary, with a named rate source and a
    timestamp recorded alongside the result.
    """


class FloatInMoneyPathError(DomainError, TypeError):
    """A float reached a money or price path.

    Binary floating point cannot represent 0.1, so it cannot represent a rupee
    or a paisa. Every amount here is a Decimal, and this error exists to make
    the moment of contamination loud rather than silent.
    """


class InvalidInstrumentError(DomainError):
    """An instrument's fields contradict its kind."""


class NaiveDatetimeError(DomainError):
    """A datetime without a timezone reached the domain.

    Every instant is stored UTC-aware. Local time exists for display and
    calendar arithmetic only.
    """
