"""What the audit log says a write was.

Behavioural: column images go in, and the claims are about the line the
log would show -- the entity type, the action in the reference's
vocabulary, and what a secret looks like once it is written down.
"""

from __future__ import annotations

import datetime as dt
from decimal import Decimal

from garuda.api.audit import button_press
from garuda.persistence.audit import (
    AuditAction,
    Change,
    entity_type_for,
    infer_action,
    snapshot,
)


class TestTheEntityType:
    def test_the_references_names_where_the_concept_is_the_same(self) -> None:
        assert entity_type_for("exchanges") == "EXCHANGE"
        assert entity_type_for("strategy_definitions") == "STRATEGY_DEFINITION"
        assert entity_type_for("rms_config") == "RMS_CONFIG"

    def test_garudas_names_where_its_model_differs(self) -> None:
        assert entity_type_for("trading_clients") == "TRADING_CLIENT"
        assert entity_type_for("trading_client_login_status") == "TRADING_CLIENT_SESSION"

    def test_an_unlisted_table_is_shown_by_its_own_name(self) -> None:
        assert entity_type_for("corporate_actions") == "CORPORATE_ACTION"


class TestTheAction:
    def test_a_lone_flag_flip_is_enable_or_disable(self) -> None:
        before = {"id": "zerodha", "enabled": True, "description": "x"}
        assert infer_action(AuditAction.UPDATE, before, {**before, "enabled": False}) is (
            AuditAction.DISABLE
        )
        assert (
            infer_action(AuditAction.UPDATE, {**before, "enabled": False}, before)
            is AuditAction.ENABLE
        )

    def test_stopped_reads_the_other_way_round(self) -> None:
        before = {"id": "zerodha", "stopped": False}
        assert infer_action(AuditAction.UPDATE, before, {**before, "stopped": True}) is (
            AuditAction.DISABLE
        )

    def test_a_flag_flipped_with_other_edits_is_an_update(self) -> None:
        before = {"id": "zerodha", "enabled": True, "description": "x"}
        after = {"id": "zerodha", "enabled": False, "description": "y"}
        assert infer_action(AuditAction.UPDATE, before, after) is AuditAction.UPDATE

    def test_a_session_written_with_a_token_is_a_login_and_without_one_a_logout(self) -> None:
        table = "trading_client_login_status"
        with_token = {"trading_client_id": "appa", "access_token_encrypted": "***"}
        without = {"trading_client_id": "appa", "access_token_encrypted": None}
        assert infer_action(AuditAction.UPDATE, without, with_token, table=table) is (
            AuditAction.LOGIN
        )
        assert infer_action(AuditAction.UPDATE, with_token, without, table=table) is (
            AuditAction.LOGOUT
        )
        assert infer_action(AuditAction.CREATE, None, with_token, table=table) is (
            AuditAction.LOGIN
        )
        assert infer_action(AuditAction.DELETE, with_token, None, table=table) is (
            AuditAction.LOGOUT
        )


class TestTheImage:
    def test_secrets_are_redacted_and_money_stays_exact(self) -> None:
        image = snapshot(
            {
                "api_key": "kite-key",
                "api_secret_encrypted": "gAAAA...",
                "password_hash": "argon2...",
                "access_token_encrypted": None,
                "capital": Decimal("100000.50"),
                "created_at": dt.datetime(2026, 10, 11, 4, 0, tzinfo=dt.UTC),
            }
        )
        assert image["api_key"] == "kite-key", "an identifier the page already shows"
        assert image["api_secret_encrypted"] == "***"
        assert image["password_hash"] == "***"
        assert image["access_token_encrypted"] is None, "an absent secret is still absent"
        assert image["capital"] == "100000.50"
        assert image["created_at"] == "2026-10-11T04:00:00+00:00"

    def test_a_change_names_its_entity_from_the_row(self) -> None:
        change = Change(
            table="exchanges",
            action=AuditAction.UPDATE,
            key_columns=["exchange_code"],
            before={"exchange_code": "NSE", "exchange_name": "National Stock Exchange"},
            after={"exchange_code": "NSE", "exchange_name": "NSE"},
        )
        assert change.entity_type == "EXCHANGE"
        assert change.entity_id == "NSE"
        assert change.entity_name == "NSE", "the name after the change"
        assert change.old_json() == (
            '{"exchange_code": "NSE", "exchange_name": "National Stock Exchange"}'
        )


class TestAButton:
    def test_a_press_is_recorded_from_the_path(self) -> None:
        pressed = button_press("POST", "/api/market-data/ticker/restart", b"")
        assert pressed is not None
        assert pressed.entity_type == "MARKET_DATA"
        assert pressed.entity_id == "ticker"
        assert pressed.effective_action is AuditAction.RESTART

    def test_a_square_off_names_the_account_and_keeps_the_scope(self) -> None:
        pressed = button_press(
            "POST", "/api/terminal/clients/appa/square-off", b'{"product": "INTRADAY"}'
        )
        assert pressed is not None
        assert pressed.entity_type == "TERMINAL"
        assert pressed.entity_id == "appa"
        assert pressed.effective_action is AuditAction.SQUARE_OFF
        assert pressed.after == {"target": "appa", "product": "INTRADAY"}

    def test_an_ordinary_post_is_not_a_button(self) -> None:
        assert button_press("POST", "/api/exchanges", b"{}") is None
        assert button_press("GET", "/api/market-data/ticker/start", b"") is None
