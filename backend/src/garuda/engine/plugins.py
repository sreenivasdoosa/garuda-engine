"""Building things by name from configuration.

Rules and selectors are both "a frozen dataclass registered under a name,
constructed from JSON". The registry is generic so the second kind cost
nothing, and so a third costs nothing either.

Two refusals carry the weight, and they are the same for every kind:

* **A name nobody registered** is refused, never ignored. Something silently
  dropped turns "enter only if volatility is low" into "enter".
* **A parameter nobody recognises** is refused too. A typo must be a
  configuration error, not a condition that quietly stopped applying.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Mapping, Sequence
from datetime import time
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from types import UnionType
from typing import Any, TypeGuard, Union, get_args, get_origin, get_type_hints

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId

#: The key naming which kind a configuration fragment describes.
TYPE_KEY = "type"


class Cost(StrEnum):
    """How expensive something is to answer.

    A hint, never a result. Rules are pure, so a conjunction may evaluate its
    cheap members first and skip the rest — a clock check before an option
    chain scan, without anyone having ordered them that way.
    """

    FREE = "FREE"
    CHEAP = "CHEAP"
    EXPENSIVE = "EXPENSIVE"


@dataclasses.dataclass(frozen=True, slots=True)
class Registration:
    """One registered kind, as the engine knows it."""

    name: str
    factory: type[Any]
    cost: Cost
    #: Field annotations resolved to real types.
    #:
    #: Every module here uses postponed annotations, so ``dataclasses.fields``
    #: reports the *text* of an annotation rather than the type. Coercing
    #: against text silently leaves an enum as the string it arrived as, and an
    #: identity comparison against the member is then quietly False for a
    #: perfectly valid configuration. Resolved once, here, where it is cheap.
    types: Mapping[str, object] = dataclasses.field(default_factory=dict)


class Registry[T]:
    """Everything of one kind that can be configured by name."""

    def __init__(self, kind: str) -> None:
        self._kind = kind
        self._entries: dict[str, Registration] = {}

    def register(self, name: str, *, cost: Cost = Cost.CHEAP) -> Callable[[type[T]], type[T]]:
        def add(factory: type[T]) -> type[T]:
            if not name or name != name.strip().lower():
                raise DomainError(f"{self._kind} name {name!r} must be lower case and unpadded")
            existing = self._entries.get(name)
            if existing is not None and existing.factory is not factory:
                raise DomainError(
                    f"two {self._kind}s are registered as {name!r}: "
                    f"{existing.factory.__name__} and {factory.__name__}"
                )
            if not hasattr(factory, "__dataclass_fields__"):
                # Parameters are read off the dataclass fields, so something
                # that is not one cannot be configured at all.
                raise DomainError(f"{factory.__name__} must be a dataclass to be configurable")
            self._entries[name] = Registration(
                name=name, factory=factory, cost=cost, types=_resolved_types(factory)
            )
            return factory

        return add

    def known(self) -> Mapping[str, Registration]:
        return dict(self._entries)

    def cost_of(self, instance: object) -> Cost:
        for entry in self._entries.values():
            if isinstance(instance, entry.factory):
                return entry.cost
        return Cost.CHEAP

    def build(self, config: object) -> T:
        """One configuration fragment into an instance.

        Recurses through any field whose type is itself buildable, so a whole
        tree comes out of one call.
        """
        if not isinstance(config, Mapping):
            raise DomainError(
                f"a {self._kind} must be an object with a {TYPE_KEY!r}, not {type(config).__name__}"
            )

        named = config.get(TYPE_KEY)
        if not isinstance(named, str) or not named.strip():
            raise DomainError(f"a {self._kind} must name its {TYPE_KEY}; got {named!r}")

        entry = self._entries.get(named.strip().lower())
        if entry is None:
            known = ", ".join(sorted(self._entries)) or "none registered"
            raise DomainError(
                f"{named!r} is not a {self._kind} this engine knows; it knows {known}"
            )

        params = {key: value for key, value in config.items() if key != TYPE_KEY}
        return self._construct(entry, params)

    def build_all(self, configs: object) -> tuple[T, ...]:
        if not isinstance(configs, Sequence) or isinstance(configs, str | bytes):
            raise DomainError(f"expected a list of {self._kind}s, got {type(configs).__name__}")
        return tuple(self.build(entry) for entry in configs)

    def _construct(self, entry: Registration, params: Mapping[str, object]) -> T:
        fields = {field.name: field for field in dataclasses.fields(entry.factory)}

        unknown = set(params) - set(fields)
        if unknown:
            raise DomainError(
                f"{entry.name} takes no parameter "
                f"{', '.join(repr(name) for name in sorted(unknown))}; "
                f"it takes {', '.join(sorted(fields)) or 'none'}"
            )

        arguments = {
            name: self._coerce(entry, name, entry.types.get(name, fields[name].type), value)
            for name, value in params.items()
        }
        try:
            built: T = entry.factory(**arguments)
        except DomainError:
            raise
        except TypeError as error:
            raise DomainError(f"{entry.name}: {error}") from None
        return built

    def _coerce(self, entry: Registration, field: str, annotation: object, value: object) -> object:
        """A stored value into the type its field declares.

        Configuration arrives as JSON, so a price is a string or a number and
        an instrument is a string. Nothing here produces a ``float``: a price
        that became one would be the defect the whole engine is arranged to
        prevent.
        """
        wanted = _without_none(annotation)
        name = entry.name

        if wanted is Decimal:
            return _decimal(name, field, value)
        if wanted is int:
            return _whole(name, field, value)
        if wanted is bool:
            return bool(value)
        if wanted is str:
            return str(value)
        if wanted is InstrumentId:
            return InstrumentId(str(value))
        if wanted is time:
            return _time(name, field, value)
        if isinstance(wanted, type) and issubclass(wanted, StrEnum):
            return _member(name, field, wanted, value)
        if _is_value_object(wanted) and isinstance(value, Mapping):
            # A nested value object — a reference, a window. Built the same
            # way and refusing the same things, because a field left as the
            # dict it arrived as is the third time that bug has appeared.
            return self._value_object(entry, field, wanted, value)
        if _reads_itself(wanted):
            # A value object that knows how to read its own written form —
            # a moneyness, a duration. Without this it stays the string it
            # arrived as, which is the failure the enum branch above exists to
            # prevent and looks exactly as harmless.
            return _parsed(name, field, wanted, value)
        if self._is_mine(wanted):
            return self.build(value)
        if self._is_sequence_of_mine(wanted):
            return self.build_all(value)
        return value

    def _value_object(
        self,
        entry: Registration,
        field: str,
        wanted: type[Any],
        value: Mapping[str, object],
    ) -> object:
        fields = {member.name: member for member in dataclasses.fields(wanted)}
        unknown = set(value) - set(fields)
        if unknown:
            raise DomainError(
                f"{entry.name}: {field} takes no "
                f"{', '.join(repr(name) for name in sorted(unknown))}; "
                f"it takes {', '.join(sorted(fields)) or 'none'}"
            )
        types = _resolved_types(wanted)
        nested = Registration(name=f"{entry.name}.{field}", factory=wanted, cost=entry.cost)
        arguments = {
            name: self._coerce(nested, name, types.get(name, fields[name].type), inner)
            for name, inner in value.items()
        }
        try:
            return wanted(**arguments)
        except DomainError:
            raise
        except TypeError as error:
            raise DomainError(f"{entry.name}: {field} — {error}") from None

    def _is_mine(self, wanted: object) -> bool:
        return any(wanted is entry.factory for entry in self._entries.values()) or (
            isinstance(wanted, type) and getattr(wanted, "_is_protocol", False)
        )

    def _is_sequence_of_mine(self, wanted: object) -> bool:
        if get_origin(wanted) not in (tuple, list):
            return False
        return any(self._is_mine(arg) for arg in get_args(wanted))


def _is_value_object(wanted: object) -> TypeGuard[type[Any]]:
    """A dataclass that is data rather than a registered plug-in."""
    return isinstance(wanted, type) and hasattr(wanted, "__dataclass_fields__")


def _reads_itself(wanted: object) -> TypeGuard[type[Any]]:
    """Whether a value object knows how to read its own written form."""
    return isinstance(wanted, type) and callable(getattr(wanted, "parse", None))


def _parsed(kind: str, field: str, wanted: type[Any], value: object) -> object:
    if isinstance(value, wanted):
        return value
    try:
        return wanted.parse(str(value))
    except DomainError as error:
        raise DomainError(f"{kind}: {field} — {error}") from None


def _resolved_types(factory: type[Any]) -> Mapping[str, object]:
    try:
        return get_type_hints(factory)
    except Exception as error:  # a forward reference nothing can resolve
        raise DomainError(
            f"{factory.__name__}: its parameter types cannot be resolved ({error})"
        ) from None


def _without_none(annotation: object) -> object:
    """``X | None`` is X for the purpose of reading a value that is present."""
    if get_origin(annotation) in (Union, UnionType):
        present = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(present) == 1:
            return present[0]
    return annotation


def _decimal(kind: str, field: str, value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise DomainError(f"{kind}: {field} is {value!r}, which is not a number")
    try:
        # Through the text, always: Decimal(0.1) is not one tenth.
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise DomainError(f"{kind}: {field} is {value!r}, which is not a number") from None


def _whole(kind: str, field: str, value: object) -> int:
    if isinstance(value, bool):
        raise DomainError(f"{kind}: {field} is {value!r}, which is not a whole number")
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise DomainError(f"{kind}: {field} is {value!r}, which is not a whole number") from None


def _time(kind: str, field: str, value: object) -> time:
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value))
    except (TypeError, ValueError):
        raise DomainError(
            f"{kind}: {field} is {value!r}, which is not a time like '13:00'"
        ) from None


def _member(kind: str, field: str, enum: type[Any], value: object) -> object:
    try:
        return enum(str(value))
    except ValueError:
        allowed = ", ".join(sorted(member.value for member in enum))
        raise DomainError(f"{kind}: {field} is {value!r}; expected one of {allowed}") from None
