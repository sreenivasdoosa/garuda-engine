"""Rules by name.

A rule is registered under a name and configured by parameters, so a strategy
stores ``{"type": "price_below", "value": 14}`` and the engine knows nothing
about what any particular rule means. A new rule is a new class with a
decorator; nothing here changes, and nothing above here changes either.

**An unknown rule type is refused, never ignored.** A rule silently dropped
turns "enter only if volatility is low" into "enter", which is the most
expensive failure this feature can have. The same goes for a parameter nobody
recognises: a typo must be a configuration error, not a condition that quietly
stopped applying.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Callable, Mapping, Sequence
from datetime import time
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from types import UnionType
from typing import (
    Any,
    Protocol,
    Union,
    get_args,
    get_origin,
    get_type_hints,
    runtime_checkable,
)

from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.market import BarInterval
from garuda.engine.rules.context import RuleContext
from garuda.engine.rules.outcome import RuleOutcome

#: The key naming which rule a configuration fragment describes.
TYPE_KEY = "type"


class Cost(StrEnum):
    """How expensive a rule is to answer.

    A hint, never a result. Rules are pure, so an ``all`` may evaluate its
    cheap members first and skip the rest -- a clock check before an option
    chain scan, without anyone having ordered them that way.
    """

    FREE = "FREE"
    CHEAP = "CHEAP"
    EXPENSIVE = "EXPENSIVE"


@runtime_checkable
class Rule(Protocol):
    """A pure predicate over a context."""

    def evaluate(self, context: RuleContext) -> RuleOutcome: ...


@dataclasses.dataclass(frozen=True, slots=True)
class Registration:
    """A rule type, as the engine knows it."""

    name: str
    factory: type[Rule]
    cost: Cost
    #: Field annotations resolved to real types.
    #:
    #: Every module here uses ``from __future__ import annotations``, so
    #: ``dataclasses.fields`` reports the *text* of an annotation rather than
    #: the type. Coercing against text silently leaves an enum as the string it
    #: arrived as, and ``self.way is Way.UP`` is then quietly False for a
    #: perfectly valid configuration. Resolved once, here, where it is cheap.
    types: Mapping[str, object] = dataclasses.field(default_factory=dict)


_REGISTRY: dict[str, Registration] = {}


def rule(name: str, *, cost: Cost = Cost.CHEAP) -> Callable[[type[Rule]], type[Rule]]:
    """Register a rule class under a configuration name."""

    def register(factory: type[Rule]) -> type[Rule]:
        if not name or name != name.strip().lower():
            raise DomainError(f"rule name {name!r} must be lower case and unpadded")
        if name in _REGISTRY and _REGISTRY[name].factory is not factory:
            raise DomainError(
                f"two rules are registered as {name!r}: "
                f"{_REGISTRY[name].factory.__name__} and {factory.__name__}"
            )
        if not hasattr(factory, "__dataclass_fields__"):
            # Parameters are read off the dataclass fields, so a rule that is
            # not one cannot be configured at all.
            raise DomainError(f"{factory.__name__} must be a dataclass to be configurable")
        _REGISTRY[name] = Registration(
            name=name, factory=factory, cost=cost, types=_resolved_types(factory)
        )
        return factory

    return register


def _resolved_types(factory: type[Rule]) -> Mapping[str, object]:
    try:
        return get_type_hints(factory)
    except Exception as error:  # a forward reference nothing can resolve
        raise DomainError(
            f"{factory.__name__}: its parameter types cannot be resolved ({error})"
        ) from None


def registered() -> Mapping[str, Registration]:
    return dict(_REGISTRY)


def cost_of(instance: Rule) -> Cost:
    for registration in _REGISTRY.values():
        if isinstance(instance, registration.factory):
            return registration.cost
    return Cost.CHEAP


def build(config: object) -> Rule:
    """One configuration fragment into a rule.

    Recurses: a composition rule's children are fragments too, so an entire
    tree is built by one call.
    """
    if not isinstance(config, Mapping):
        raise DomainError(
            f"a rule must be an object with a {TYPE_KEY!r}, not {type(config).__name__}"
        )

    named = config.get(TYPE_KEY)
    if not isinstance(named, str) or not named.strip():
        raise DomainError(f"a rule must name its {TYPE_KEY}; got {named!r}")

    registration = _REGISTRY.get(named.strip().lower())
    if registration is None:
        known = ", ".join(sorted(_REGISTRY)) or "none registered"
        raise DomainError(f"{named!r} is not a rule this engine knows; it knows {known}")

    return _construct(registration, {k: v for k, v in config.items() if k != TYPE_KEY})


def build_all(configs: object) -> tuple[Rule, ...]:
    if not isinstance(configs, Sequence) or isinstance(configs, str | bytes):
        raise DomainError(f"expected a list of rules, got {type(configs).__name__}")
    return tuple(build(entry) for entry in configs)


def _construct(registration: Registration, params: Mapping[str, object]) -> Rule:
    fields = {field.name: field for field in dataclasses.fields(registration.factory)}  # type: ignore[arg-type]

    unknown = set(params) - set(fields)
    if unknown:
        raise DomainError(
            f"{registration.name} takes no parameter "
            f"{', '.join(repr(name) for name in sorted(unknown))}; "
            f"it takes {', '.join(sorted(fields)) or 'none'}"
        )

    arguments: dict[str, object] = {}
    for name, value in params.items():
        annotation = registration.types.get(name, fields[name].type)
        arguments[name] = _coerce(registration.name, name, annotation, value)

    try:
        return registration.factory(**arguments)
    except DomainError:
        raise
    except TypeError as error:
        raise DomainError(f"{registration.name}: {error}") from None


def _coerce(rule_name: str, field: str, annotation: object, value: object) -> object:
    """A stored value into the type its field declares.

    Configuration arrives as JSON, so a price is a string or a number and an
    instrument is a string. Nothing here produces a ``float``: a price that
    became one would be a defect the whole engine is arranged to prevent.
    """
    wanted = _unwrap_optional(annotation)

    if wanted in {"Decimal", Decimal}:
        return _decimal(rule_name, field, value)
    if wanted in {"int", int}:
        return _whole(rule_name, field, value)
    if wanted in {"bool", bool}:
        return bool(value)
    if wanted in {"str", str}:
        return str(value)
    if wanted in {"InstrumentId", InstrumentId}:
        return InstrumentId(str(value))
    if wanted in {"BarInterval", BarInterval}:
        return _member(rule_name, field, BarInterval, value)
    if wanted in {"time", time}:
        return _time(rule_name, field, value)
    if wanted in {"Rule", Rule}:
        return build(value)
    if _is_rule_sequence(wanted):
        return build_all(value)
    if isinstance(wanted, type) and issubclass(wanted, StrEnum):
        return _member(rule_name, field, wanted, value)
    return value


def _unwrap_optional(annotation: object) -> object:
    """``X | None`` is X for the purpose of reading a value that is present."""
    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        present = [arg for arg in get_args(annotation) if arg is not type(None)]
        if len(present) == 1:
            return present[0]
    if isinstance(annotation, str) and annotation.endswith(" | None"):
        return annotation.removesuffix(" | None")
    return annotation


def _is_rule_sequence(wanted: object) -> bool:
    if isinstance(wanted, str):
        return wanted.replace(" ", "") in {"tuple[Rule,...]", "Sequence[Rule]", "list[Rule]"}
    return get_origin(wanted) in (tuple, list) and Rule in get_args(wanted)


def _decimal(rule_name: str, field: str, value: object) -> Decimal:
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        raise DomainError(f"{rule_name}: {field} is {value!r}, which is not a number")
    try:
        # Through the text, always: Decimal(0.1) is not one tenth.
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        raise DomainError(f"{rule_name}: {field} is {value!r}, which is not a number") from None


def _whole(rule_name: str, field: str, value: object) -> int:
    if isinstance(value, bool):
        raise DomainError(f"{rule_name}: {field} is {value!r}, which is not a whole number")
    if isinstance(value, int):
        return value
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        raise DomainError(
            f"{rule_name}: {field} is {value!r}, which is not a whole number"
        ) from None


def _time(rule_name: str, field: str, value: object) -> time:
    if isinstance(value, time):
        return value
    try:
        return time.fromisoformat(str(value))
    except (TypeError, ValueError):
        raise DomainError(
            f"{rule_name}: {field} is {value!r}, which is not a time like '13:00'"
        ) from None


def _member(rule_name: str, field: str, enum: type[Any], value: object) -> object:
    try:
        return enum(str(value))
    except ValueError:
        allowed = ", ".join(sorted(member.value for member in enum))
        raise DomainError(f"{rule_name}: {field} is {value!r}; expected one of {allowed}") from None
