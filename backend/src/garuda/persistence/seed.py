"""Loading seed data.

Seed is what a human curated and an engine cannot derive: which venues exist,
when they are closed, what a lot of crude oil is, how a broker charges. The
F&O stock universe is not seed — it is detected from the instrument master
every morning, and shipping a stale copy would be worse than shipping none.

Loading is an upsert, so it is safe to run on every start: an operator who has
edited a strike gap keeps their edit for rows they changed, and gains any rows
a later release adds. Nothing is deleted — a symbol removed from the seed is
one the operator may still be trading.
"""

from __future__ import annotations

import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import Boolean, Date, DateTime, Numeric, Time

from garuda.domain.errors import DomainError
from garuda.persistence.repositories import Repositories
from garuda.persistence.repository import Repository

SEED_DIRECTORY = Path(__file__).parent / "seed_data"

#: File name -> the repository it loads into, in dependency order. Exchanges
#: before symbols, plans before their rates: a foreign key is a fact about
#: order, not a suggestion.
SEED_ORDER: tuple[tuple[str, str], ...] = (
    ("exchanges", "exchanges"),
    ("holidays", "holidays"),
    ("products", "products"),
    ("brokers", "brokers"),
    ("symbols", "symbols"),
    ("brokerage_plans", "brokerage_plans"),
    ("brokerage_plan_rates", "brokerage_plan_rates"),
    ("statutory_charges", "statutory_charges"),
    ("rms_config", "rms_config"),
)


@dataclass(frozen=True, slots=True)
class SeedResult:
    """What a load did, per file."""

    loaded: dict[str, int]
    skipped: tuple[str, ...] = ()

    @property
    def total(self) -> int:
        return sum(self.loaded.values())


def read_seed(name: str, directory: Path = SEED_DIRECTORY) -> list[dict[str, Any]]:
    """Read one seed file. Missing means nothing to load, not an error."""
    path = directory / f"{name}.yaml"
    if not path.exists():
        return []
    rows = yaml.safe_load(path.read_text(encoding="utf-8"))
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise DomainError(f"seed file {path.name} must contain a list of rows")
    return rows


async def load_seed(
    repositories: Repositories,
    *,
    directory: Path = SEED_DIRECTORY,
    only: Sequence[str] | None = None,
) -> SeedResult:
    """Upsert every seed file into its table.

    Runs inside the caller's unit of work, so a failure part-way leaves the
    database as it was rather than half-seeded.
    """
    wanted = set(only) if only is not None else None
    loaded: dict[str, int] = {}
    skipped: list[str] = []

    for name, repository_name in SEED_ORDER:
        if wanted is not None and name not in wanted:
            continue
        rows = read_seed(name, directory)
        if not rows:
            skipped.append(name)
            continue
        repository: Repository[Any] = getattr(repositories, repository_name)
        rows = [coerce_row(repository.model, row) for row in rows]
        # Rows in one file can legitimately set different columns — a symbol
        # with no index symbol omits it — so they are grouped by shape.
        for shape in _grouped_by_columns(rows):
            await repository.upsert_all(shape)
        loaded[name] = len(rows)

    return SeedResult(loaded=loaded, skipped=tuple(skipped))


def coerce_row(model: type[Any], row: dict[str, Any]) -> dict[str, Any]:
    """Convert a YAML row to the types its columns actually hold.

    Seed files are text a human edits, so a date arrives as a string and a
    boolean as 0 or 1. Conversion is driven by the model's own column types
    rather than by guessing from the value, so a column that changes type
    cannot leave the loader quietly writing the old one.
    """
    table = model.__table__
    converted: dict[str, Any] = {}
    for name, value in row.items():
        column = table.columns.get(name)
        if column is None:
            raise DomainError(f"{table.name} has no column {name!r} in its seed file")
        converted[name] = _coerce(column.type, value, table.name, name)
    return converted


def _coerce(column_type: Any, value: Any, table: str, column: str) -> Any:
    if value is None:
        return None
    try:
        if isinstance(column_type, Boolean):
            return (
                bool(value)
                if not isinstance(value, str)
                else value.lower()
                in {
                    "1",
                    "true",
                    "yes",
                    "y",
                }
            )
        if isinstance(column_type, Numeric):
            return value if isinstance(value, Decimal) else Decimal(str(value))
        if isinstance(column_type, DateTime):
            return (
                value if isinstance(value, dt.datetime) else dt.datetime.fromisoformat(str(value))
            )
        if isinstance(column_type, Date):
            return value if isinstance(value, dt.date) else dt.date.fromisoformat(str(value))
        if isinstance(column_type, Time):
            return value if isinstance(value, dt.time) else dt.time.fromisoformat(str(value))
    except (ValueError, InvalidOperation) as error:
        raise DomainError(
            f"{table}.{column}: {value!r} is not a valid {type(column_type).__name__}"
        ) from error
    return value


def _grouped_by_columns(rows: Sequence[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    groups: dict[tuple[str, ...], list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(tuple(sorted(row)), []).append(row)
    return list(groups.values())
