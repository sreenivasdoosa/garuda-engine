"""Trades and signals as text, and back.

A round trip that loses something is a restart that loses it. The claims are
about exactness and about what happens to a payload the reader does not fully
understand.
"""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal

from garuda.domain.intent import LegRole
from garuda.domain.trade import (
    CorporateActionState,
    ExitAttempts,
    Protection,
    Relationships,
    Trade,
    TradeId,
)
from garuda.domain.trade_serde import (
    decode_signal,
    decode_trade,
    encode_signal,
    encode_trade,
)
from garuda.domain.trade_signal import EntryRules, EscalationMode, ReEntryRules, TradeSignal
from garuda.domain.trade_state import TradeExitReason
from tests.unit.trademgmt.conftest import PUT, TODAY, a_signal, a_trade, rupees


def a_rich_trade() -> Trade:
    trade = replace(
        a_trade(),
        protection=Protection(
            stop_loss=rupees("150.55"),
            initial_stop_loss=rupees("160"),
            target=rupees("80.25"),
            # The group's levels, which ride on the leg as percentages: the
            # price cannot be known until every leg has filled, so a restart
            # that dropped these would leave the group unprotected.
            combined_stop_loss_percent=Decimal(10),
            combined_target_percent=Decimal("12.5"),
            is_trailing=True,
            trigger_to_limit_gap_percent=Decimal("2.5"),
        ),
        relationships=Relationships(
            combo_id="c-1",
            hedge_correlation_id="h-1",
            hedge_trade_id=TradeId("t-hedge"),
            leg_role=LegRole.MAIN,
            entry_sequence=2,
            hedge_distance_percent=Decimal("1.5"),
            main_entry_failed=True,
            hedge_trade_id_to_square_off=TradeId("t-old"),
        ),
        corporate_actions=CorporateActionState(
            original_entry=rupees("100"),
            original_quantity=50,
            factor=Decimal(2),
            applied_action_ids=(41, 42),
        ),
        attempts=ExitAttempts(
            square_off_attempts=3, exit_placement_attempts=2, target_order_attempts=1
        ),
        square_off_at=TODAY + timedelta(hours=5),
        remarks="carried overnight",
    )
    trade = trade.with_entry_fill(75, rupees("120.3333"), TODAY)
    return trade.exiting(TradeExitReason.SQUARE_OFF).with_price_seen(rupees("133.75"))


class TestATradeRoundTrip:
    def test_everything_survives(self) -> None:
        original = a_rich_trade()
        assert decode_trade(encode_trade(original)) == original

    def test_a_price_is_not_rounded_on_the_way_through(self) -> None:
        """A price that round-trips through a JSON number is a price that has
        been rounded, and a rounded average entry is a wrong P&L after it."""
        original = a_rich_trade()
        restored = decode_trade(encode_trade(original))
        assert restored.entry is not None
        assert original.entry is not None
        assert restored.entry.amount == original.entry.amount
        assert str(restored.entry.amount) == str(original.entry.amount)

    def test_money_is_stored_as_text(self) -> None:
        payload = json.loads(encode_trade(a_rich_trade()))
        assert isinstance(payload["entry"]["amount"], str)

    def test_a_finished_trade_survives(self) -> None:
        original = a_rich_trade().closed(rupees("111.11"), TradeExitReason.STOP_LOSS, TODAY)
        assert decode_trade(encode_trade(original)) == original

    def test_a_cancelled_trade_survives(self) -> None:
        original = a_trade().cancelled(TradeExitReason.ENTRY_FAILED, TODAY, "no margin")
        assert decode_trade(encode_trade(original)) == original

    def test_the_high_water_marks_survive(self) -> None:
        """A restart that forgot them would trail from the price at restart."""
        original = a_rich_trade()
        restored = decode_trade(encode_trade(original))
        assert restored.high_since_entry == original.high_since_entry
        assert restored.low_since_entry == original.low_since_entry

    def test_the_orphan_flag_survives(self) -> None:
        """It is durable precisely so an orphan is still closed after a restart."""
        restored = decode_trade(encode_trade(a_rich_trade()))
        assert restored.relationships.main_entry_failed

    def test_an_exit_already_under_way_survives(self) -> None:
        restored = decode_trade(encode_trade(a_rich_trade()))
        assert restored.exiting_for is TradeExitReason.SQUARE_OFF


class TestASignalRoundTrip:
    def rich_signal(self) -> TradeSignal:
        return replace(
            a_signal(),
            entry=EntryRules(
                trigger=rupees("120.05"),
                trigger_limit=rupees("121"),
                limit_buffer_percent=Decimal("0.5"),
                entry_with_stop_limit_order=True,
                escalation_mode=EscalationMode.STEPPED,
                escalation_seconds=30,
                escalation_steps='[{"buffer": 1}]',
                valid_till=TODAY + timedelta(hours=1),
                not_before=TODAY,
                cancel_unfilled_order_at=TODAY + timedelta(minutes=5),
                toggle_long_short=True,
            ),
            protection=Protection(stop_loss=rupees("150"), is_trailing=True),
            relationships=Relationships(hedge_correlation_id="h-1", leg_role=LegRole.HEDGE),
            re_entry=ReEntryRules(max_entries=3, consider_reverse=True, entries_so_far=1),
            trigger_instrument=PUT,
            expiry="2026-08-27",
            combo_leg_count=2,
        )

    def test_everything_survives(self) -> None:
        original = self.rich_signal()
        assert decode_signal(encode_signal(original)) == original

    def test_a_triggered_signal_stays_triggered(self) -> None:
        """Otherwise a restart places a second order for one decision."""
        original = self.rich_signal().triggered()
        assert decode_signal(encode_signal(original)).is_triggered

    def test_a_disabled_signal_keeps_its_reason(self) -> None:
        original = self.rich_signal().disable("the broker refused it")
        restored = decode_signal(encode_signal(original))
        assert restored.disabled
        assert restored.disabled_reason == "the broker refused it"

    def test_the_shared_shapes_are_read_by_one_decoder(self) -> None:
        """Protection and relationships live on both records; encoding them
        once is what stops the two drifting apart field by field."""
        original = self.rich_signal()
        restored = decode_signal(encode_signal(original))
        assert restored.protection == original.protection
        assert restored.relationships == original.relationships


class TestReadingWhatWeDoNotFullyUnderstand:
    def test_an_unknown_field_is_ignored(self) -> None:
        """A trade written by a newer version must still load during a
        rollback; refusing means an engine that cannot see its positions."""
        payload = json.loads(encode_trade(a_rich_trade()))
        payload["something_added_later"] = {"nested": True}
        payload["protection"]["a_new_level"] = "1.23"
        assert decode_trade(json.dumps(payload)).id == TradeId("t-1")

    def test_a_missing_optional_section_defaults(self) -> None:
        payload = json.loads(encode_trade(a_trade()))
        del payload["corporate_actions"]
        del payload["attempts"]
        restored = decode_trade(json.dumps(payload))
        assert restored.corporate_actions.factor == Decimal(1)
        assert restored.attempts.square_off_attempts == 0

    def test_the_payload_says_which_version_wrote_it(self) -> None:
        assert json.loads(encode_trade(a_trade()))["version"] >= 1
