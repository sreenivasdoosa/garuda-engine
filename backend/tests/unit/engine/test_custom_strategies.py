"""A custom strategy overrides a hook; everything around it stays the engine's."""

from __future__ import annotations

from collections.abc import Iterator

import pytest

from garuda.domain.errors import DomainError
from garuda.engine import BaseStrategy, Evaluation, StandDown, strategy
from garuda.engine.custom_strategies import instance, is_registered, registered, unregister
from garuda.engine.direction_providers import Side


@pytest.fixture
def registered_one() -> Iterator[type[BaseStrategy]]:
    @strategy("only_puts")
    class OnlyPuts(BaseStrategy):
        def direction(self, ev: Evaluation) -> Side:
            return Side.LONG  # a seller's bullish answer: sell the put

    yield OnlyPuts
    unregister("ONLY_PUTS")


def test_a_registered_class_is_found_by_name(registered_one: type[BaseStrategy]) -> None:
    assert is_registered("only_puts")
    assert "ONLY_PUTS" in registered()
    assert isinstance(instance("ONLY_PUTS"), registered_one)


def test_no_name_means_the_configured_base() -> None:
    assert instance(None) is None


def test_an_unknown_name_is_refused() -> None:
    with pytest.raises(DomainError, match="not registered"):
        instance("NOBODY")


def test_only_a_base_strategy_can_register() -> None:
    with pytest.raises(DomainError):
        strategy("BAD")(object)  # type: ignore[arg-type]


def test_stand_down_is_exported_for_hooks() -> None:
    assert StandDown("why").because == "why"
