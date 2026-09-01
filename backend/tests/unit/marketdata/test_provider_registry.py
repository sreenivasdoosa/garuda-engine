"""Choosing a provider that cannot do the job says so, by name."""

from __future__ import annotations

import pytest

from garuda.marketdata.providers.registry import (
    ADAPTERS,
    ProviderAdapters,
    ProviderUnsupportedError,
    adapters_for,
    feed_factory,
    history_factory,
    register,
)


@pytest.fixture(autouse=True)
def restore_registry() -> object:
    """The registry is module state; each test gets it back as it was."""
    before = dict(ADAPTERS)
    yield
    ADAPTERS.clear()
    ADAPTERS.update(before)


def test_every_provider_the_engine_configures_is_in_the_registry() -> None:
    """Listed even with nothing attached, so choosing one fails with a reason
    rather than as an unknown name."""
    assert {"zerodha", "fyers", "dhan", "xts", "truedata"} <= set(ADAPTERS)


def test_an_unknown_provider_is_refused() -> None:
    with pytest.raises(ProviderUnsupportedError, match="not a provider"):
        adapters_for("quandl")


def test_a_provider_with_no_feed_says_it_cannot_stream() -> None:
    """The failure an operator sees when they pick a provider whose adapter is
    not written. Silence here would look exactly like an outage."""
    register("fyers", ProviderAdapters())

    with pytest.raises(ProviderUnsupportedError, match="cannot stream ticks"):
        feed_factory("fyers")


def test_a_provider_with_no_history_says_it_cannot_answer_candles() -> None:
    register("truedata", ProviderAdapters())

    with pytest.raises(ProviderUnsupportedError, match="cannot answer candles"):
        history_factory("truedata")


def test_a_registered_feed_is_returned() -> None:
    def build(**_: object) -> object:
        return object()

    register("xts", ProviderAdapters(feed=build))  # type: ignore[arg-type]

    assert feed_factory("xts") is build
    assert adapters_for("xts").can_stream is True
    assert adapters_for("xts").can_answer_history is False


def test_zerodha_can_do_both_once_the_composition_root_has_registered() -> None:
    from garuda.composition.providers import register_providers

    register_providers()

    assert adapters_for("zerodha").can_stream is True
    assert adapters_for("zerodha").can_answer_history is True
