"""Capturing what a request changed, for the audit log.

The reference engine writes an audit row from each servlet by hand -- the
entity before, the entity after, who did it -- and over the years some
servlets remembered and some did not. Garuda's design asks for the opposite
guarantee: every operator mutation is audited, and a new endpoint cannot
forget. Both are wanted. The rows the Console diffs need the before and the
after; the guarantee needs a place nothing can bypass.

That place is the session. A row the API edits in place -- ``row.stopped =
True`` and a commit -- is seen at flush, with the attribute's old value
from the ORM's own history; a row it inserts or deletes as an object, the
same. The statements that never flush an object -- the repository's
``update``, ``delete`` and ``upsert`` -- are recorded by the repository,
which reads the row first because it is the one place that knows the key.
While a request is in flight the API opens a capture here; both paths fill
it, and the middleware turns it into rows once the request has succeeded.
A request that was refused changed nothing and writes nothing.

The capture is a context variable, so it follows the request's task and no
other: the engine's own writes -- a trade persisted, a breach logged --
run in their own tasks, find no capture, and are not operator actions.
"""

from __future__ import annotations

import datetime as dt
import decimal
import json
from collections.abc import Mapping
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from sqlalchemy import event, inspect
from sqlalchemy.orm import Session

# -- vocabulary ---------------------------------------------------------------


class AuditAction(StrEnum):
    """The reference's actions, plus the operator's hands on the engine.

    CREATE, UPDATE and DELETE are what a row write is. ENABLE and DISABLE
    are the reference's own distinction for a flag toggle, so the log can
    be filtered by them. LOGIN and LOGOUT are session events. The rest are
    the buttons that change the engine without changing a row.
    """

    CREATE = "CREATE"
    UPDATE = "UPDATE"
    DELETE = "DELETE"
    ENABLE = "ENABLE"
    DISABLE = "DISABLE"
    LOGIN = "LOGIN"
    LOGOUT = "LOGOUT"
    START = "START"
    STOP = "STOP"
    RESTART = "RESTART"
    SQUARE_OFF = "SQUARE_OFF"
    DOWNLOAD = "DOWNLOAD"
    RUN = "RUN"


#: Table name to the entity type the log shows. The reference's names where
#: the concept is the same; garuda's where its model differs (the trading
#: client replaces the user-broker pair). A table not listed is shown by its
#: own name, upper-cased and singular.
ENTITY_TYPES: Mapping[str, str] = {
    "exchanges": "EXCHANGE",
    "holidays": "HOLIDAY",
    "special_trading_days": "SPECIAL_TRADING_DAY",
    "event_days": "EVENT_DAY",
    "strategy_event_days": "STRATEGY_EVENT_DAY_ACTION",
    "symbols": "SYMBOL",
    "stock_universes": "STOCK_UNIVERSE",
    "stock_universe_members": "STOCK_UNIVERSE_MEMBER",
    "brokers": "BROKER",
    "broker_exchange_config": "BROKER_EXCHANGE_CONFIG",
    "trading_clients": "TRADING_CLIENT",
    "trading_client_login_status": "TRADING_CLIENT_SESSION",
    "data_providers": "DATA_PROVIDER",
    "data_provider_sessions": "DATA_PROVIDER_SESSION",
    "strategy_definitions": "STRATEGY_DEFINITION",
    "strategy_indicator_rules": "STRATEGY_RULES",
    "strategy_config": "STRATEGY_CONFIG_TREE",
    "subscriptions": "SUBSCRIPTION",
    "rms_config": "RMS_CONFIG",
    "kill_switches": "KILL_SWITCH",
    "kill_switch_types": "KILL_SWITCH_TYPE",
    "system_config": "SYSTEM_CONFIG",
    "app_config": "SYSTEM_CONFIG",
}

#: What a row is called, when it has a name. Tried in order.
NAME_COLUMNS = (
    "display_name",
    "exchange_name",
    "strategy_name",
    "broker_name",
    "provider_name",
    "name",
    "symbol",
    "key_name",
    "config_key",
)

#: Flag columns whose lone change the reference logs as ENABLE or DISABLE
#: rather than UPDATE. ``stopped`` reads the other way round.
FLAG_COLUMNS = frozenset({"enabled", "is_active", "active", "is_enabled"})
INVERTED_FLAGS = frozenset({"stopped"})

#: Tables whose writes are a session coming or going rather than an edit.
SESSION_TABLES = frozenset({"trading_client_login_status", "data_provider_sessions"})
TOKEN_COLUMN = "access_token_encrypted"

#: Columns never written to the log. A secret in an audit row is a secret
#: in a table every operator can read.
SECRET_MARKERS = ("secret", "password", "token", "encrypted", "totp", "pin")
REDACTED = "***"


def entity_type_for(table: str) -> str:
    """The entity type the log shows for a table."""
    known = ENTITY_TYPES.get(table)
    if known is not None:
        return known
    name = table.upper()
    return name[:-1] if name.endswith("S") else name


def is_secret(column: str) -> bool:
    lowered = column.lower()
    return any(marker in lowered for marker in SECRET_MARKERS)


def plain(value: Any) -> Any:
    """A column value as JSON can carry it. Money and prices stay exact."""
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.datetime, dt.date, dt.time)):
        return value.isoformat()
    if isinstance(value, bytes):
        return REDACTED
    if isinstance(value, (list, tuple, set, frozenset)):
        return [plain(v) for v in value]
    if isinstance(value, Mapping):
        return {str(k): plain(v) for k, v in value.items()}
    return value


def snapshot(values: Mapping[str, Any]) -> dict[str, Any]:
    """Column values as the log stores them: JSON-safe, secrets redacted."""
    return {
        key: (REDACTED if is_secret(key) and value is not None else plain(value))
        for key, value in values.items()
    }


def row_values(row: Any) -> dict[str, Any]:
    """Every column of an ORM row, by attribute name."""
    return {attr.key: getattr(row, attr.key) for attr in inspect(type(row)).column_attrs}


def row_name(values: Mapping[str, Any]) -> str | None:
    for column in NAME_COLUMNS:
        value = values.get(column)
        if isinstance(value, str) and value:
            return value
    return None


def key_text(values: Mapping[str, Any], key_columns: list[str]) -> str:
    """The row's key as one string: ``NSE``, or ``zerodha:NSE`` for a pair."""
    return ":".join(str(plain(values.get(column))) for column in key_columns)


def infer_action(
    action: AuditAction,
    before: Mapping[str, Any] | None,
    after: Mapping[str, Any] | None,
    *,
    table: str = "",
) -> AuditAction:
    """What the write *was*, in the log's vocabulary.

    A session row written with a token is a LOGIN and one written without,
    or deleted, is a LOGOUT, as the reference logs them. A lone flag flip is
    the reference's ENABLE or DISABLE. Anything else is what the repository
    said it was.
    """
    if table in SESSION_TABLES:
        if action is AuditAction.DELETE:
            return AuditAction.LOGOUT
        if after is not None and TOKEN_COLUMN in after:
            return AuditAction.LOGIN if after[TOKEN_COLUMN] else AuditAction.LOGOUT
        return action
    if action is not AuditAction.UPDATE or before is None or after is None:
        return action
    changed = {key for key in after if key in before and before[key] != after[key]}
    if len(changed) != 1:
        return action
    [column] = changed
    if column in FLAG_COLUMNS:
        return AuditAction.ENABLE if after[column] else AuditAction.DISABLE
    if column in INVERTED_FLAGS:
        return AuditAction.DISABLE if after[column] else AuditAction.ENABLE
    return action


# -- the capture ----------------------------------------------------------------


@dataclass
class Change:
    """One row written during a request, as the log will show it."""

    table: str
    action: AuditAction
    key_columns: list[str]
    before: dict[str, Any] | None = None
    after: dict[str, Any] | None = None
    #: An ORM row staged for insert. Its key is assigned at flush, so its
    #: values are read when the change is resolved rather than when staged.
    pending_row: Any = None

    def resolve(self) -> Change:
        if self.pending_row is not None and self.after is None:
            self.after = snapshot(row_values(self.pending_row))
        return self

    @property
    def entity_type(self) -> str:
        return entity_type_for(self.table)

    @property
    def entity_id(self) -> str:
        source = self.after if self.after is not None else self.before
        return key_text(source or {}, self.key_columns)

    @property
    def entity_name(self) -> str | None:
        return row_name(self.after or {}) or row_name(self.before or {})

    @property
    def effective_action(self) -> AuditAction:
        return infer_action(self.action, self.before, self.after, table=self.table)

    def old_json(self) -> str | None:
        return None if self.before is None else json.dumps(self.before, sort_keys=True)

    def new_json(self) -> str | None:
        return None if self.after is None else json.dumps(self.after, sort_keys=True)


@dataclass
class AuditCapture:
    """What one request changed. Opened by the API, filled by the repositories."""

    changes: list[Change] = field(default_factory=list)

    def record(self, change: Change) -> None:
        self.changes.append(change)

    def resolved(self) -> list[Change]:
        return [change.resolve() for change in self.changes]


_capture: ContextVar[AuditCapture | None] = ContextVar("garuda_audit_capture", default=None)


def current_capture() -> AuditCapture | None:
    """The request's capture, or None outside one -- which is the engine."""
    return _capture.get()


def open_capture() -> tuple[AuditCapture, Token[AuditCapture | None]]:
    capture = AuditCapture()
    return capture, _capture.set(capture)


def close_capture(token: Token[AuditCapture | None]) -> None:
    _capture.reset(token)


# -- the flush path -------------------------------------------------------------


def _key_columns(row: Any) -> list[str]:
    return [column.name for column in type(row).__table__.primary_key.columns]


def _images(row: Any) -> tuple[dict[str, Any], dict[str, Any]]:
    """A modified row before and after, from the ORM's attribute history."""
    before: dict[str, Any] = {}
    after: dict[str, Any] = {}
    state = inspect(row)
    for attr in inspect(type(row)).column_attrs:
        current = getattr(row, attr.key)
        history = state.attrs[attr.key].history
        was = history.deleted[0] if history.has_changes() and history.deleted else current
        before[attr.key] = was
        after[attr.key] = current
    return before, after


def _on_flush(session: Session, flush_context: object, instances: object) -> None:
    """Record every object write of a flush on the request's capture."""
    del flush_context, instances
    capture = current_capture()
    if capture is None:
        return
    for row in session.new:
        if hasattr(type(row), "__tablename__"):
            capture.record(
                Change(
                    table=type(row).__tablename__,
                    action=AuditAction.CREATE,
                    key_columns=_key_columns(row),
                    pending_row=row,
                )
            )
    for row in session.dirty:
        if not hasattr(type(row), "__tablename__") or not session.is_modified(row):
            continue
        before, after = _images(row)
        if before == after:
            continue
        capture.record(
            Change(
                table=type(row).__tablename__,
                action=AuditAction.UPDATE,
                key_columns=_key_columns(row),
                before=snapshot(before),
                after=snapshot(after),
            )
        )
    for row in session.deleted:
        if hasattr(type(row), "__tablename__"):
            capture.record(
                Change(
                    table=type(row).__tablename__,
                    action=AuditAction.DELETE,
                    key_columns=_key_columns(row),
                    before=snapshot(row_values(row)),
                )
            )


_listening = False


def listen() -> None:
    """Watch every session's flushes. Idempotent; the session factory calls it."""
    global _listening
    if _listening:
        return
    event.listen(Session, "before_flush", _on_flush)
    _listening = True
