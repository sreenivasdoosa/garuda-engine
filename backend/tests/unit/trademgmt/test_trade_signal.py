"""Trade signals: a strategy's request, before it becomes a position."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from garuda.domain import Currency, Direction, Money, ProductType
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.trade_signal import (
    EntryRules,
    EscalationMode,
    ReEntryRules,
    SignalType,
    TradeSignal,
)

T0 = datetime(2026, 8, 31, 9, 20, tzinfo=UTC)
CLIENT = TradingClientId("appa-zerodha")
CALL = InstrumentId("NFO:NIFTY26AUG25000CE")
FUTURE = InstrumentId("NFO:NIFTY26AUGFUT")


def rupees(value: str) -> Money:
    return Money.of(value, Currency.INR)


def a_signal(
    *,
    signal_type: SignalType = SignalType.SHORT_ENTRY,
    entry: EntryRules | None = None,
    re_entry: ReEntryRules | None = None,
    trigger_instrument: InstrumentId | None = None,
) -> TradeSignal:
    return TradeSignal(
        id="sig-1",
        trading_client=CLIENT,
        instrument=CALL,
        strategy="straddle",
        signal_type=signal_type,
        product=ProductType.NRML,
        quantity=75,
        generated_at=T0,
        entry=entry or EntryRules(trigger=rupees("120")),
        re_entry=re_entry or ReEntryRules(),
        trigger_instrument=trigger_instrument,
    )


class TestDirection:
    def test_a_long_entry_is_long(self) -> None:
        assert a_signal(signal_type=SignalType.LONG_ENTRY).direction is Direction.LONG

    def test_a_short_entry_is_short(self) -> None:
        assert a_signal(signal_type=SignalType.SHORT_ENTRY).direction is Direction.SHORT


class TestWhenASignalMayFire:
    def test_a_fresh_signal_is_actionable(self) -> None:
        assert a_signal().is_actionable(T0)

    def test_a_triggered_signal_is_not(self) -> None:
        """Otherwise it places a second order for one decision."""
        assert not a_signal().triggered().is_actionable(T0)

    def test_triggering_twice_is_refused(self) -> None:
        with pytest.raises(DomainError, match="already triggered"):
            a_signal().triggered().triggered()

    def test_a_disabled_signal_is_not(self) -> None:
        signal = a_signal().disable("the strategy was stopped")
        assert not signal.is_actionable(T0)
        assert signal.disabled_reason == "the strategy was stopped"

    def test_a_signal_past_its_validity_is_not(self) -> None:
        signal = a_signal(
            entry=EntryRules(trigger=rupees("120"), valid_till=T0 + timedelta(minutes=30))
        )
        assert signal.is_actionable(T0)
        assert not signal.is_actionable(T0 + timedelta(hours=1))
        assert signal.has_expired(T0 + timedelta(hours=1))

    def test_a_signal_held_back_until_later_is_not_yet(self) -> None:
        """Used to keep an entry out of the opening auction."""
        signal = a_signal(
            entry=EntryRules(trigger=rupees("120"), not_before=T0 + timedelta(minutes=15))
        )
        assert not signal.is_actionable(T0)
        assert signal.is_actionable(T0 + timedelta(minutes=20))

    def test_every_reason_not_to_act_is_checked_in_one_place(self) -> None:
        """A caller cannot act on a signal by forgetting one of them."""
        signal = a_signal(
            entry=EntryRules(trigger=rupees("120"), valid_till=T0 + timedelta(minutes=30))
        ).disable("stopped")
        assert not signal.is_actionable(T0)


class TestWhatIsWatched:
    def test_by_default_the_traded_instrument_is_the_watched_one(self) -> None:
        assert a_signal().watched_instrument == CALL

    def test_a_signal_can_be_triggered_by_another_instrument(self) -> None:
        """An option entry triggered by the future's price."""
        signal = a_signal(trigger_instrument=FUTURE)
        assert signal.watched_instrument == FUTURE
        assert signal.instrument == CALL


class TestReEntry:
    def test_a_single_entry_signal_allows_one(self) -> None:
        rules = ReEntryRules()
        assert rules.may_re_enter
        assert ReEntryRules(entries_so_far=1).may_re_enter is False

    def test_a_cap_of_three_allows_three(self) -> None:
        rules = ReEntryRules(max_entries=3, entries_so_far=2)
        assert rules.may_re_enter
        assert ReEntryRules(max_entries=3, entries_so_far=3).may_re_enter is False

    def test_reversal_is_a_separate_decision_from_the_cap(self) -> None:
        rules = ReEntryRules(max_entries=2, consider_reverse=True)
        assert rules.consider_reverse
        assert rules.may_re_enter


class TestEscalation:
    def test_a_signal_defaults_to_no_escalation(self) -> None:
        assert a_signal().entry.escalation_mode is EscalationMode.NONE

    def test_market_escalation_carries_its_wait(self) -> None:
        signal = a_signal(
            entry=EntryRules(
                trigger=rupees("120"),
                escalation_mode=EscalationMode.MARKET,
                escalation_seconds=30,
            )
        )
        assert signal.entry.escalation_seconds == 30


class TestAttempts:
    def test_a_failed_execution_is_recorded_with_its_reason(self) -> None:
        signal = a_signal().attempted("the risk gate refused")
        assert signal.execution_attempts == 1
        assert signal.last_error == "the risk gate refused"
        assert signal.is_actionable(T0), "a failed attempt does not consume the signal"

    def test_attempts_accumulate(self) -> None:
        signal = a_signal().attempted("one").attempted("two")
        assert signal.execution_attempts == 2


class TestValidation:
    def test_a_signal_for_nothing_is_refused(self) -> None:
        with pytest.raises(DomainError, match="is not a signal"):
            TradeSignal(
                id="sig-1",
                trading_client=CLIENT,
                instrument=CALL,
                strategy="s",
                signal_type=SignalType.LONG_ENTRY,
                product=ProductType.NRML,
                quantity=0,
                generated_at=T0,
            )

    def test_a_signal_without_an_id_is_refused(self) -> None:
        with pytest.raises(DomainError, match="needs an id"):
            TradeSignal(
                id="  ",
                trading_client=CLIENT,
                instrument=CALL,
                strategy="s",
                signal_type=SignalType.LONG_ENTRY,
                product=ProductType.NRML,
                quantity=75,
                generated_at=T0,
            )

    def test_a_multiplier_of_zero_is_refused(self) -> None:
        with pytest.raises(DomainError, match="contract multiplier"):
            TradeSignal(
                id="sig-1",
                trading_client=CLIENT,
                instrument=CALL,
                strategy="s",
                signal_type=SignalType.LONG_ENTRY,
                product=ProductType.NRML,
                quantity=75,
                generated_at=T0,
                contract_multiplier=Decimal(0),
            )
