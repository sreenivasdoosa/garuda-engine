"""Reading strategies out of the database.

Rows in, strategies the loop can run out (`STRATEGY_ENGINE.md` §2). Five
tables meet here:

* **definitions** -- what a strategy is, parsed through the vocabulary;
* **configuration** -- how it behaves, as layers merged per column per day;
* **indicator rules** -- entry, exit and direction trees, when it uses them;
* **day allocation** -- its share of lots by kind of day;
* **subscriptions** -- which account runs it, with what capital, paper or live.

**A strategy that cannot be read is left out, by name.** One malformed rule
tree must not stop the others loading, and a strategy silently absent is
worse than one reported absent -- so every refusal is logged with the
strategy on it, and the Console refuses the save that would cause it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.composition.runtime_config import definition_of, layer_of, terms_of
from garuda.domain.client import TradingClientId
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.engine.config import ConfigLayer
from garuda.engine.daycondition import DayCondition
from garuda.engine.direction import DirectionRule
from garuda.engine.direction import build_all as build_directions
from garuda.engine.direction_providers import build as build_provider
from garuda.engine.lots import FULL_SIZE_EVERY_DAY, DayAllocation
from garuda.engine.rules.registry import Rule
from garuda.engine.rules.registry import build as build_rule
from garuda.engine.rules.translate import (
    is_console_directions,
    is_console_shape,
    translate,
    translate_directions,
)
from garuda.engine.runtime_config import (
    Definition,
    RuntimeConfig,
    SubscriptionTerms,
    build_runtime_config,
)
from garuda.engine.vocabulary import CONFIG_CHOICES, StrategyStatus
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDaysAllocationRow,
    StrategyDefinitionsRow,
    StrategyIndicatorRulesRow,
    SubscriptionsRow,
)
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Strategy:
    """One strategy, ready to be subscribed to."""

    definition: Definition
    layers: tuple[ConfigLayer, ...]
    entry_rules: Rule | None = None
    exit_rules: Rule | None = None
    direction_rules: tuple[DirectionRule, ...] = ()
    day_allocation: DayAllocation = FULL_SIZE_EVERY_DAY

    @property
    def name(self) -> str:
        return self.definition.name

    @property
    def underlying(self) -> InstrumentId:
        return InstrumentId(f"{self.definition.exchange}:{self.definition.underlying_symbol}")

    @property
    def winding_down(self) -> bool:
        """WIND_DOWN: open positions are managed to their end and nothing new
        is entered."""
        return self.definition.status is StrategyStatus.WIND_DOWN

    def runtime(
        self, terms: SubscriptionTerms, conditions: frozenset[DayCondition]
    ) -> RuntimeConfig:
        return build_runtime_config(self.definition, terms, self.layers, conditions=conditions)


@dataclass(frozen=True)
class Subscription:
    """One account running one strategy."""

    trading_client: TradingClientId
    strategy: str
    terms: SubscriptionTerms

    @property
    def is_paper(self) -> bool:
        return self.terms.is_paper_trading


@dataclass(frozen=True)
class Loaded:
    """Everything read, and everything refused."""

    strategies: Mapping[str, Strategy]
    subscriptions: tuple[Subscription, ...]
    #: Strategy name to the reason it was left out.
    refused: Mapping[str, str]

    def underlyings(self) -> set[InstrumentId]:
        """What the feed must quote for the subscribed strategies."""
        return {
            self.strategies[sub.strategy].underlying
            for sub in self.subscriptions
            if sub.strategy in self.strategies
        }

    def subscribers(self, strategy: str) -> tuple[Subscription, ...]:
        return tuple(sub for sub in self.subscriptions if sub.strategy == strategy)


NOTHING_LOADED = Loaded(strategies={}, subscriptions=(), refused={})


async def load_strategies(sessions: async_sessionmaker[AsyncSession]) -> Loaded:
    """Read every running strategy and the subscriptions to it."""
    async with UnitOfWork(sessions) as uow:
        definitions = await uow.repositories.strategy_definitions.all()
        configs = await uow.repositories.strategy_config.all()
        rules = await uow.repositories.strategy_indicator_rules.all()
        allocations = await uow.repositories.strategy_days_allocation.all()
        subscriptions = await uow.repositories.subscriptions.all()
    return assemble(definitions, configs, rules, subscriptions, allocations)


def assemble(
    definitions: Sequence[StrategyDefinitionsRow],
    configs: Sequence[StrategyConfigRow],
    rules: Sequence[StrategyIndicatorRulesRow],
    subscriptions: Sequence[SubscriptionsRow],
    allocations: Sequence[StrategyDaysAllocationRow] = (),
) -> Loaded:
    by_strategy_config: dict[str, list[StrategyConfigRow]] = {}
    for config in configs:
        by_strategy_config.setdefault(config.strategy_name, []).append(config)
    by_strategy_rules = {row.strategy_name: row for row in rules}
    by_strategy_allocation = {row.strategy_name: row for row in allocations}

    built: dict[str, Strategy] = {}
    refused: dict[str, str] = {}
    for row in definitions:
        status = (row.status or "").strip().upper()
        if status not in (StrategyStatus.ACTIVE.value, StrategyStatus.WIND_DOWN.value):
            continue
        try:
            built[row.strategy_name] = _strategy(
                row,
                by_strategy_config.get(row.strategy_name, []),
                by_strategy_rules.get(row.strategy_name),
                by_strategy_allocation.get(row.strategy_name),
            )
        except DomainError as error:
            refused[row.strategy_name] = str(error)
            logger.error("%s will not be traded: %s", row.strategy_name, error)

    return Loaded(
        strategies=built,
        subscriptions=_subscriptions(subscriptions, built, refused),
        refused=refused,
    )


def _subscriptions(
    rows: Sequence[SubscriptionsRow],
    strategies: Mapping[str, Strategy],
    refused: Mapping[str, str],
) -> tuple[Subscription, ...]:
    out: list[Subscription] = []
    for row in rows:
        if not row.is_active:
            continue
        if row.strategy_name not in strategies:
            if row.strategy_name in refused:
                logger.warning(
                    "%s is subscribed to %s, which will not be traded",
                    row.trading_client_id,
                    row.strategy_name,
                )
            continue
        if row.capital is None or row.capital <= 0:
            logger.warning(
                "%s has no capital allocated to %s; it will not trade",
                row.trading_client_id,
                row.strategy_name,
            )
            continue
        out.append(
            Subscription(
                trading_client=TradingClientId(row.trading_client_id),
                strategy=row.strategy_name,
                terms=terms_of(row),
            )
        )
    return tuple(out)


def _strategy(
    row: StrategyDefinitionsRow,
    configs: Sequence[StrategyConfigRow],
    rules: StrategyIndicatorRulesRow | None,
    allocation: StrategyDaysAllocationRow | None,
) -> Strategy:
    definition = definition_of(row)
    if definition.signal_trigger:
        raise DomainError(
            f"{definition.name} has the signal trigger on; external signals are not built "
            "yet (TODO.md), so it is left out rather than waiting on signals that never come"
        )
    layers = tuple(layer_of(config) for config in configs)
    for layer in layers:
        _check_choices(definition.name, layer)
    # Built once so a configuration that cannot resolve is refused here, at
    # load, and not at 09:20 on the first tranche.
    build_runtime_config(
        definition,
        SubscriptionTerms(trading_client_id=TradingClientId("validation"), capital=Decimal(1)),
        layers,
        conditions=frozenset(),
    )
    if definition.is_directional:
        build_provider(
            definition.direction_provider_type or "", definition.direction_provider_params
        )
    entry = _optional_rules(definition.name, "entry", rules)
    if definition.use_indicator_entry and entry is None:
        raise DomainError(
            f"{definition.name} gates entries on indicator rules but has no entry rules"
        )
    return Strategy(
        definition=definition,
        layers=layers,
        entry_rules=entry,
        exit_rules=_optional_rules(definition.name, "exit", rules),
        direction_rules=_direction_json(definition.name, rules),
        day_allocation=_allocation(allocation),
    )


def _check_choices(strategy: str, layer: ConfigLayer) -> None:
    for column, choices in CONFIG_CHOICES.items():
        value = layer.values.get(column)
        if value is not None and str(value) not in choices:
            raise DomainError(f"{strategy}: {column} {value!r} is not one of {', '.join(choices)}")


def _allocation(row: StrategyDaysAllocationRow | None) -> DayAllocation:
    if row is None:
        return FULL_SIZE_EVERY_DAY
    return DayAllocation(
        monday=row.monday,
        tuesday=row.tuesday,
        wednesday=row.wednesday,
        thursday=row.thursday,
        friday=row.friday,
        expiry_day=row.expiry_day,
        dt1_day=row.dt1_day,
        dt2_day=row.dt2_day,
    )


def _direction_json(
    strategy: str, rules: StrategyIndicatorRulesRow | None
) -> tuple[DirectionRule, ...]:
    if rules is None:
        return ()
    raw = (rules.direction_rules_json or "").strip()
    if not raw:
        return ()
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DomainError(
            f"{strategy}: its direction rules are not readable JSON ({error})"
        ) from None
    try:
        if is_console_directions(parsed):
            return build_directions(translate_directions(parsed))
        return build_directions(parsed if isinstance(parsed, list) else [parsed])
    except DomainError as error:
        raise DomainError(f"{strategy}: its direction rules are not usable — {error}") from None


def _optional_rules(
    strategy: str, which: str, rules: StrategyIndicatorRulesRow | None
) -> Rule | None:
    if rules is None:
        return None
    raw = (getattr(rules, f"{which}_rules_json", None) or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        return build_rule(translate(parsed) if is_console_shape(parsed) else parsed)
    except json.JSONDecodeError as error:
        raise DomainError(
            f"{strategy}: its {which} rules are not readable JSON ({error})"
        ) from None
    except DomainError as error:
        raise DomainError(f"{strategy}: its {which} rules are not usable — {error}") from None


def validate_strategy(
    definition: StrategyDefinitionsRow,
    configs: Sequence[StrategyConfigRow],
    rules: StrategyIndicatorRulesRow | None,
) -> str | None:
    """Why the engine would refuse this strategy at load, or None.

    Built exactly the way :func:`load_strategies` builds it, so the Console
    can refuse a save for the reason the morning's log would otherwise give.
    A definition that is neither ACTIVE nor WIND_DOWN is not built at all,
    and so has nothing to be refused for.
    """
    loaded = assemble([definition], configs, [rules] if rules is not None else [], [])
    return loaded.refused.get(definition.strategy_name)
