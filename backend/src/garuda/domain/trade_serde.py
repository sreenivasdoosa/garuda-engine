"""Trades and signals, as text and back.

A live trade is stored as a JSON payload beside a handful of indexed columns.
The columns are what a query filters on -- the account, the strategy, the
state; the payload is everything else, so adding a field to a trade does not
need a migration.

**Money is text, never a float.** A price that round-trips through a JSON
number is a price that has been rounded, and a rounded average entry is a
wrong P&L on every report after it. The same convention the journal uses.

Anything unrecognised in a stored payload is ignored rather than refused. A
trade written by a newer version must still load into an older one during a
rollback, and refusing would mean an engine that cannot see its own positions.
"""

from __future__ import annotations

import json
from datetime import datetime
from decimal import Decimal
from typing import Any

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, ProductType
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.journal import decode_money, encode_money
from garuda.domain.money import Money
from garuda.domain.trade import (
    CorporateActionState,
    ExitAttempts,
    Protection,
    Relationships,
    Trade,
    TradeId,
)
from garuda.domain.trade_signal import (
    EntryRules,
    EscalationMode,
    ReEntryRules,
    SignalType,
    TradeSignal,
)
from garuda.domain.trade_state import TradeExitReason, TradeState

#: Bumped when a payload's shape changes in a way a reader must know about.
#: Written on every record so an unreadable one can be told from an old one.
PAYLOAD_VERSION = 1


def _money(value: Money | None) -> Any:
    return encode_money(value) if value is not None else None


def _read_money(raw: Any) -> Money | None:
    return decode_money(raw) if isinstance(raw, dict) else None


def _decimal(value: Decimal | None) -> str | None:
    return str(value) if value is not None else None


def _read_decimal(raw: Any) -> Decimal | None:
    return Decimal(raw) if isinstance(raw, str) else None


def _moment(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _read_moment(raw: Any) -> datetime | None:
    return datetime.fromisoformat(raw) if isinstance(raw, str) else None


# -- trades -----------------------------------------------------------------


def encode_trade(trade: Trade) -> str:
    protection = trade.protection
    relationships = trade.relationships
    actions = trade.corporate_actions
    attempts = trade.attempts
    return json.dumps(
        {
            "version": PAYLOAD_VERSION,
            "id": trade.id.value,
            "trading_client": trade.trading_client.value,
            "instrument": trade.instrument.value,
            "strategy": trade.strategy,
            "direction": trade.direction.value,
            "product": trade.product.value,
            "quantity": trade.quantity,
            "quantity_per_lot": trade.quantity_per_lot,
            "contract_multiplier": str(trade.contract_multiplier),
            "state": trade.state.value,
            "filled_quantity": trade.filled_quantity,
            "entry": _money(trade.entry),
            "exit": _money(trade.exit),
            "exit_reason": trade.exit_reason.value if trade.exit_reason else None,
            "exiting_for": trade.exiting_for.value if trade.exiting_for else None,
            "failure_reason": trade.failure_reason,
            "started_at": _moment(trade.started_at),
            "ended_at": _moment(trade.ended_at),
            "high_since_entry": _money(trade.high_since_entry),
            "low_since_entry": _money(trade.low_since_entry),
            "signal_id": trade.signal_id,
            "group": trade.group,
            "tranche": trade.tranche,
            "slice": trade.slice,
            "re_entry_count": trade.re_entry_count,
            "is_paper": trade.is_paper,
            "no_square_off": trade.no_square_off,
            "square_off_at": _moment(trade.square_off_at),
            "remarks": trade.remarks,
            "protection": {
                "stop_loss": _money(protection.stop_loss),
                "initial_stop_loss": _money(protection.initial_stop_loss),
                "target": _money(protection.target),
                "combined_stop_loss": _money(protection.combined_stop_loss),
                "initial_combined_stop_loss": _money(protection.initial_combined_stop_loss),
                "combined_stop_loss_percent": _decimal(protection.combined_stop_loss_percent),
                "combined_target_percent": _decimal(protection.combined_target_percent),
                "no_stop_loss": protection.no_stop_loss,
                "no_target": protection.no_target,
                "dont_place_stop_loss_order": protection.dont_place_stop_loss_order,
                "is_trailing": protection.is_trailing,
                "trail_to_cost": protection.trail_to_cost,
                "exit_with_trail": protection.exit_with_trail,
                "trigger_to_limit_gap_percent": _decimal(protection.trigger_to_limit_gap_percent),
            },
            "relationships": {
                "combo_id": relationships.combo_id,
                "hedge_correlation_id": relationships.hedge_correlation_id,
                "hedge_trade_id": (
                    relationships.hedge_trade_id.value if relationships.hedge_trade_id else None
                ),
                "pair_correlation_id": relationships.pair_correlation_id,
                "leg_role": relationships.leg_role.value if relationships.leg_role else None,
                "entry_sequence": relationships.entry_sequence,
                "hedge_distance_percent": _decimal(relationships.hedge_distance_percent),
                "main_entry_failed": relationships.main_entry_failed,
                "hedge_trade_id_to_square_off": (
                    relationships.hedge_trade_id_to_square_off.value
                    if relationships.hedge_trade_id_to_square_off
                    else None
                ),
            },
            "corporate_actions": {
                "original_entry": _money(actions.original_entry),
                "original_quantity": actions.original_quantity,
                "original_filled_quantity": actions.original_filled_quantity,
                "factor": str(actions.factor),
                "applied_action_ids": list(actions.applied_action_ids),
            },
            "attempts": {
                "square_off_attempts": attempts.square_off_attempts,
                "exit_placement_attempts": attempts.exit_placement_attempts,
                "last_attempt_at": _moment(attempts.last_attempt_at),
                "stop_loss_order_attempts": attempts.stop_loss_order_attempts,
                "target_order_attempts": attempts.target_order_attempts,
            },
        }
    )


def decode_trade(payload: str) -> Trade:
    raw = json.loads(payload)
    protection = raw.get("protection") or {}
    relationships = raw.get("relationships") or {}
    actions = raw.get("corporate_actions") or {}
    attempts = raw.get("attempts") or {}

    return Trade(
        id=TradeId(raw["id"]),
        trading_client=TradingClientId(raw["trading_client"]),
        instrument=InstrumentId(raw["instrument"]),
        strategy=raw["strategy"],
        direction=Direction(raw["direction"]),
        product=ProductType(raw["product"]),
        quantity=raw["quantity"],
        quantity_per_lot=raw.get("quantity_per_lot", 1),
        contract_multiplier=Decimal(raw.get("contract_multiplier", "1")),
        state=TradeState(raw["state"]),
        filled_quantity=raw.get("filled_quantity", 0),
        entry=_read_money(raw.get("entry")),
        exit=_read_money(raw.get("exit")),
        exit_reason=_read_reason(raw.get("exit_reason")),
        exiting_for=_read_reason(raw.get("exiting_for")),
        failure_reason=raw.get("failure_reason"),
        started_at=_read_moment(raw.get("started_at")),
        ended_at=_read_moment(raw.get("ended_at")),
        high_since_entry=_read_money(raw.get("high_since_entry")),
        low_since_entry=_read_money(raw.get("low_since_entry")),
        signal_id=raw.get("signal_id"),
        group=raw.get("group", "DEFAULT"),
        tranche=raw.get("tranche", 0),
        slice=raw.get("slice", 1),
        re_entry_count=raw.get("re_entry_count", 0),
        is_paper=raw.get("is_paper", False),
        no_square_off=raw.get("no_square_off", False),
        square_off_at=_read_moment(raw.get("square_off_at")),
        remarks=raw.get("remarks"),
        protection=Protection(
            stop_loss=_read_money(protection.get("stop_loss")),
            initial_stop_loss=_read_money(protection.get("initial_stop_loss")),
            target=_read_money(protection.get("target")),
            combined_stop_loss=_read_money(protection.get("combined_stop_loss")),
            initial_combined_stop_loss=_read_money(protection.get("initial_combined_stop_loss")),
            combined_stop_loss_percent=_read_decimal(protection.get("combined_stop_loss_percent")),
            combined_target_percent=_read_decimal(protection.get("combined_target_percent")),
            no_stop_loss=protection.get("no_stop_loss", False),
            no_target=protection.get("no_target", False),
            dont_place_stop_loss_order=protection.get("dont_place_stop_loss_order", False),
            is_trailing=protection.get("is_trailing", False),
            trail_to_cost=protection.get("trail_to_cost", False),
            exit_with_trail=protection.get("exit_with_trail", False),
            trigger_to_limit_gap_percent=_read_decimal(
                protection.get("trigger_to_limit_gap_percent")
            ),
        ),
        relationships=Relationships(
            combo_id=relationships.get("combo_id"),
            hedge_correlation_id=relationships.get("hedge_correlation_id"),
            hedge_trade_id=_read_trade_id(relationships.get("hedge_trade_id")),
            pair_correlation_id=relationships.get("pair_correlation_id"),
            leg_role=LegRole(relationships["leg_role"]) if relationships.get("leg_role") else None,
            entry_sequence=relationships.get("entry_sequence", 0),
            hedge_distance_percent=_read_decimal(relationships.get("hedge_distance_percent")),
            main_entry_failed=relationships.get("main_entry_failed", False),
            hedge_trade_id_to_square_off=_read_trade_id(
                relationships.get("hedge_trade_id_to_square_off")
            ),
        ),
        corporate_actions=CorporateActionState(
            original_entry=_read_money(actions.get("original_entry")),
            original_quantity=actions.get("original_quantity"),
            original_filled_quantity=actions.get("original_filled_quantity"),
            factor=Decimal(actions.get("factor", "1")),
            applied_action_ids=tuple(actions.get("applied_action_ids") or ()),
        ),
        attempts=ExitAttempts(
            square_off_attempts=attempts.get("square_off_attempts", 0),
            exit_placement_attempts=attempts.get("exit_placement_attempts", 0),
            last_attempt_at=_read_moment(attempts.get("last_attempt_at")),
            stop_loss_order_attempts=attempts.get("stop_loss_order_attempts", 0),
            target_order_attempts=attempts.get("target_order_attempts", 0),
        ),
    )


# -- signals ----------------------------------------------------------------


def encode_signal(signal: TradeSignal) -> str:
    entry = signal.entry
    re_entry = signal.re_entry
    return json.dumps(
        {
            "version": PAYLOAD_VERSION,
            "id": signal.id,
            "trading_client": signal.trading_client.value,
            "instrument": signal.instrument.value,
            "strategy": signal.strategy,
            "signal_type": signal.signal_type.value,
            "product": signal.product.value,
            "quantity": signal.quantity,
            "generated_at": signal.generated_at.isoformat(),
            "quantity_per_lot": signal.quantity_per_lot,
            "contract_multiplier": str(signal.contract_multiplier),
            "trigger_instrument": (
                signal.trigger_instrument.value if signal.trigger_instrument else None
            ),
            "group": signal.group,
            "tranche": signal.tranche,
            "slice": signal.slice,
            "is_paper": signal.is_paper,
            "no_square_off": signal.no_square_off,
            "square_off_at": _moment(signal.square_off_at),
            "expiry": signal.expiry,
            "combo_leg_count": signal.combo_leg_count,
            "remarks": signal.remarks,
            "is_triggered": signal.is_triggered,
            "disabled": signal.disabled,
            "disabled_reason": signal.disabled_reason,
            "execution_attempts": signal.execution_attempts,
            "last_error": signal.last_error,
            "entry": {
                "trigger": _money(entry.trigger),
                "trigger_limit": _money(entry.trigger_limit),
                "place_market_order": entry.place_market_order,
                "limit_buffer_percent": _decimal(entry.limit_buffer_percent),
                "entry_with_stop_limit_order": entry.entry_with_stop_limit_order,
                "escalation_mode": entry.escalation_mode.value,
                "escalation_seconds": entry.escalation_seconds,
                "escalation_steps": entry.escalation_steps,
                "cancel_unfilled_order_at": _moment(entry.cancel_unfilled_order_at),
                "not_before": _moment(entry.not_before),
                "valid_till": _moment(entry.valid_till),
                "toggle_long_short": entry.toggle_long_short,
            },
            "re_entry": {
                "max_entries": re_entry.max_entries,
                "consider_reverse": re_entry.consider_reverse,
                "reverse_correlation_id": re_entry.reverse_correlation_id,
                "entries_so_far": re_entry.entries_so_far,
            },
            "protection": json.loads(encode_trade(_trade_shell(signal)))["protection"],
            "relationships": json.loads(encode_trade(_trade_shell(signal)))["relationships"],
        }
    )


def decode_signal(payload: str) -> TradeSignal:
    raw = json.loads(payload)
    entry = raw.get("entry") or {}
    re_entry = raw.get("re_entry") or {}
    # The protection and relationship shapes are shared with a trade, so they
    # are read back through the same decoder rather than duplicated.
    shell = decode_trade(
        json.dumps(
            {
                "id": raw["id"],
                "trading_client": raw["trading_client"],
                "instrument": raw["instrument"],
                "strategy": raw["strategy"],
                "direction": SignalType(raw["signal_type"]).direction.value,
                "product": raw["product"],
                "quantity": raw["quantity"],
                "state": TradeState.OPEN.value,
                "protection": raw.get("protection") or {},
                "relationships": raw.get("relationships") or {},
            }
        )
    )

    return TradeSignal(
        id=raw["id"],
        trading_client=TradingClientId(raw["trading_client"]),
        instrument=InstrumentId(raw["instrument"]),
        strategy=raw["strategy"],
        signal_type=SignalType(raw["signal_type"]),
        product=ProductType(raw["product"]),
        quantity=raw["quantity"],
        generated_at=datetime.fromisoformat(raw["generated_at"]),
        quantity_per_lot=raw.get("quantity_per_lot", 1),
        contract_multiplier=Decimal(raw.get("contract_multiplier", "1")),
        trigger_instrument=(
            InstrumentId(raw["trigger_instrument"]) if raw.get("trigger_instrument") else None
        ),
        entry=EntryRules(
            trigger=_read_money(entry.get("trigger")),
            trigger_limit=_read_money(entry.get("trigger_limit")),
            place_market_order=entry.get("place_market_order", False),
            limit_buffer_percent=_read_decimal(entry.get("limit_buffer_percent")),
            entry_with_stop_limit_order=entry.get("entry_with_stop_limit_order", False),
            escalation_mode=EscalationMode(entry.get("escalation_mode", "NONE")),
            escalation_seconds=entry.get("escalation_seconds", 0),
            escalation_steps=entry.get("escalation_steps"),
            cancel_unfilled_order_at=_read_moment(entry.get("cancel_unfilled_order_at")),
            not_before=_read_moment(entry.get("not_before")),
            valid_till=_read_moment(entry.get("valid_till")),
            toggle_long_short=entry.get("toggle_long_short", False),
        ),
        protection=shell.protection,
        relationships=shell.relationships,
        re_entry=ReEntryRules(
            max_entries=re_entry.get("max_entries", 1),
            consider_reverse=re_entry.get("consider_reverse", False),
            reverse_correlation_id=re_entry.get("reverse_correlation_id"),
            entries_so_far=re_entry.get("entries_so_far", 0),
        ),
        group=raw.get("group", "DEFAULT"),
        tranche=raw.get("tranche", 0),
        slice=raw.get("slice", 1),
        is_paper=raw.get("is_paper", False),
        no_square_off=raw.get("no_square_off", False),
        square_off_at=_read_moment(raw.get("square_off_at")),
        expiry=raw.get("expiry"),
        combo_leg_count=raw.get("combo_leg_count", 0),
        remarks=raw.get("remarks"),
        is_triggered=raw.get("is_triggered", False),
        disabled=raw.get("disabled", False),
        disabled_reason=raw.get("disabled_reason"),
        execution_attempts=raw.get("execution_attempts", 0),
        last_error=raw.get("last_error"),
    )


def _trade_shell(signal: TradeSignal) -> Trade:
    """A trade carrying only the parts a signal shares with one.

    Encoding protection and relationships once, in one place, is what keeps
    the two records from drifting apart field by field.
    """
    return Trade(
        id=TradeId(signal.id),
        trading_client=signal.trading_client,
        instrument=signal.instrument,
        strategy=signal.strategy,
        direction=signal.direction,
        product=signal.product,
        quantity=signal.quantity,
        protection=signal.protection,
        relationships=signal.relationships,
    )


def _read_reason(raw: Any) -> TradeExitReason | None:
    return TradeExitReason(raw) if isinstance(raw, str) else None


def _read_trade_id(raw: Any) -> TradeId | None:
    return TradeId(raw) if isinstance(raw, str) else None


__all__ = [
    "PAYLOAD_VERSION",
    "decode_signal",
    "decode_trade",
    "encode_signal",
    "encode_trade",
]
