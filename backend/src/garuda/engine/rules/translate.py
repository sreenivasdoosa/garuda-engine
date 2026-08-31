"""Reading the rule JSON the Console writes.

Two shapes exist and both are real. The registry builds rules from garuda's
own shape -- ``{"type": "all", "rules": [...]}`` -- and the Console writes the
reference engine's, an ``operator``/``condition`` tree with camelCase keys and
its own names for comparators and intervals. The frontend is copied from that
Console and its rule builder is kept, so the shape it emits has to be read
rather than rewritten.

They are told apart by the ``type`` on the node, and the two vocabularies do
not overlap: nothing in the registry is called ``operator`` or ``condition``,
and the reference has no rule called ``all``. So detection is exact, not a
guess, and a tree in either shape loads.

Three things this refuses rather than translates, because each would change
what a strategy does:

* **An operator node with no children.** The reference logs a warning and
  treats it as false; garuda's ``all`` treats an empty set as "no conditions",
  which passes. Mapping it either way silently flips a strategy between never
  entering and always entering, so the row is refused and the operator told.
* **An interval or comparator with no equivalent.** ``2minute``, ``10minute``
  and ``month`` are intervals the engine does not carry, and ``FLIP`` is a
  comparator it does not implement. Rounding to the nearest is not a smaller
  version of the strategy, it is a different one.
* **An indicator nobody registered.** Left to the registry, which already
  refuses by name -- so a typo is a configuration error rather than a
  condition that quietly stopped applying.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from garuda.domain.errors import DomainError
from garuda.domain.market import BarInterval

#: The reference's node types. Their presence is what says which shape a tree
#: is in.
OPERATOR = "operator"
CONDITION = "condition"

#: `AND` and `OR` are the only two the reference has -- its evaluator treats
#: anything that is not AND as OR -- and it has no NOT at all. Spelled out
#: rather than defaulted, so a third operator appearing is refused instead of
#: quietly becoming an OR.
OPERATORS: Mapping[str, str] = {"AND": "all", "OR": "any"}

COMPARATORS: Mapping[str, str] = {
    "GREATER_THAN": "gt",
    "GREATER_THAN_OR_EQUAL": "gte",
    "LESS_THAN": "lt",
    "LESS_THAN_OR_EQUAL": "lte",
    "EQUAL": "eq",
    "NOT_EQUAL": "ne",
    "CROSS_ABOVE": "cross_above",
    "CROSS_BELOW": "cross_below",
}

#: The reference names intervals by their length in minutes. `2minute`,
#: `10minute` and `month` are deliberately absent: it has them and the engine
#: does not, and a rule configured for one must not be silently rounded.
INTERVALS: Mapping[str, BarInterval] = {
    "minute": BarInterval.ONE_MINUTE,
    "3minute": BarInterval.THREE_MINUTES,
    "5minute": BarInterval.FIVE_MINUTES,
    "15minute": BarInterval.FIFTEEN_MINUTES,
    "30minute": BarInterval.THIRTY_MINUTES,
    "60minute": BarInterval.ONE_HOUR,
    "day": BarInterval.ONE_DAY,
}

#: The price is an indicator here and its field is called `field`. The
#: reference calls that field `type`, which is the one key a plug-in parameter
#: may not be: `type` is how the registry chooses what to build.
PRICE = "price"


def is_console_shape(node: object) -> bool:
    """Whether this tree came from the Console rather than from the registry."""
    if not isinstance(node, Mapping):
        return False
    return node.get("type") in (OPERATOR, CONDITION) or "condition" in node


def translate_directions(parsed: object) -> list[dict[str, Any]]:
    """The Console's direction rules: a tree for long and a tree for short.

    Answered as a single ``rules`` direction rule rather than two, because
    either passing on its own is an answer and both passing is a contradiction
    -- which only one rule holding both trees can tell.
    """
    if not isinstance(parsed, Mapping):
        raise DomainError(f"direction rules must be an object, not {type(parsed).__name__}")

    built: dict[str, Any] = {"type": "rules"}
    for key, field in (("longRules", "long_rules"), ("shortRules", "short_rules")):
        tree = parsed.get(key)
        if tree is not None:
            built[field] = translate(tree)
    if len(built) == 1:
        raise DomainError(
            "direction rules name neither longRules nor shortRules, so nothing decides "
            "which way the strategy goes"
        )
    return [built]


def is_console_directions(parsed: object) -> bool:
    """Whether direction rules came from the Console rather than the registry."""
    return isinstance(parsed, Mapping) and ("longRules" in parsed or "shortRules" in parsed)


def translate(node: object) -> dict[str, Any]:
    """One rule tree, in the shape the registry builds from."""
    if not isinstance(node, Mapping):
        raise DomainError(f"a rule node must be an object, not {type(node).__name__}")

    kind = node.get("type")
    if kind == CONDITION or "condition" in node:
        return _condition(node.get("condition"))
    if kind == OPERATOR or "operator" in node:
        return _operator(node)
    raise DomainError(f"a rule node is neither a condition nor an operator: {sorted(node)}")


def _operator(node: Mapping[str, object]) -> dict[str, Any]:
    named = str(node.get("operator", "")).strip().upper()
    if named not in OPERATORS:
        raise DomainError(
            f"{named or '(none)'} is not a rule operator; expected one of "
            f"{', '.join(sorted(OPERATORS))}"
        )

    children = node.get("children")
    if not isinstance(children, list) or not children:
        # See the module docstring: the two engines disagree about what an
        # empty one means, and the disagreement is between never entering and
        # always entering.
        raise DomainError(
            f"an {named} rule node has no conditions under it, which the Console reads as "
            "never true and this engine would read as nothing asked for"
        )

    return {"type": OPERATORS[named], "rules": [translate(child) for child in children]}


def _condition(raw: object) -> dict[str, Any]:
    if not isinstance(raw, Mapping):
        raise DomainError(f"a condition must be an object, not {type(raw).__name__}")

    indicator, params = _indicator(raw.get("indicator"), raw.get("params"))
    built: dict[str, Any] = {
        "type": "indicator",
        "indicator": indicator,
        "comparator": _comparator(raw.get("comparator")),
        "interval": _interval(raw.get("interval")).value,
    }
    if params:
        built["params"] = params

    reference = raw.get("referenceIndicator")
    if reference is not None:
        name, shape = _indicator(reference, raw.get("referenceParams"))
        built["reference"] = name
        if shape:
            built["reference_params"] = shape
        if raw.get("referenceInterval") is not None:
            built["reference_interval"] = _interval(raw.get("referenceInterval")).value
    elif "value" in raw:
        built["value"] = raw["value"]
    else:
        raise DomainError(
            f"the {indicator} condition compares against neither a value nor another indicator"
        )

    if raw.get("instrument") is not None:
        built["instrument"] = raw["instrument"]
    return built


def _indicator(named: object, params: object) -> tuple[str, dict[str, Any]]:
    """An indicator and its parameters, in the registry's spelling."""
    if not isinstance(named, str) or not named.strip():
        raise DomainError("a condition names no indicator")
    name = named.strip().lower()

    shape: dict[str, Any] = {}
    if isinstance(params, Mapping):
        shape = {str(key): value for key, value in params.items()}

    if name == PRICE and "type" in shape:
        # `type` is how the registry chooses what to build, so the price's
        # field cannot keep that name.
        shape["field"] = shape.pop("type")
    return name, shape


def _comparator(named: object) -> str:
    if not isinstance(named, str):
        raise DomainError("a condition names no comparator")
    key = named.strip().upper()
    if key not in COMPARATORS:
        raise DomainError(
            f"{named} is not a comparator this engine implements; it has "
            f"{', '.join(sorted(COMPARATORS))}"
        )
    return COMPARATORS[key]


def _interval(named: object) -> BarInterval:
    if named is None:
        raise DomainError("a condition names no interval")
    key = str(named).strip().lower()
    if key not in INTERVALS:
        raise DomainError(
            f"{named} is not an interval this engine carries; it has {', '.join(sorted(INTERVALS))}"
        )
    return INTERVALS[key]
