"""Reading strategies out of the database.

Rows in, runnable subscriptions out. Three tables meet here:

* **definitions** say what a strategy is — its underlying, its product, its
  legs;
* **configuration** says how it behaves today, merged across its scopes;
* **subscriptions** say which account runs it, with how much capital.

No new tables were needed. Legs live in the definition's combo column, which
was built for multi-leg strategies and turns out to be the general case — a
single-leg strategy is a combo with one leg, and ``N = 1`` is not special.
Rules live in the rules table beside the indicator rules it was named for;
both names are now narrower than what they hold, and renaming them is a
migration worth doing on its own rather than in passing.

**A strategy that cannot be read is left out, by name.** One malformed rule
tree must not stop the others loading, and a strategy silently absent is worse
than one reported absent — so every refusal is logged with the strategy on it.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from garuda.domain.client import TradingClientId
from garuda.domain.enums import Direction, OrderType, ProductType
from garuda.domain.errors import DomainError
from garuda.domain.instrument import InstrumentId
from garuda.domain.intent import LegRole
from garuda.domain.money import Currency, Money
from garuda.engine.config import ConfigLayer, ResolvedConfig, resolve
from garuda.engine.daycondition import DayCondition
from garuda.engine.direction import DirectionRule
from garuda.engine.direction import build_all as build_directions
from garuda.engine.rules.compose import AllOf
from garuda.engine.rules.registry import Rule
from garuda.engine.rules.registry import build as build_rule
from garuda.engine.selectors import build as build_selector
from garuda.engine.spec import (
    DirectionProvider,
    FixedDirection,
    LegSpec,
    SideRule,
    StrategySpec,
)
from garuda.engine.strategy import StrategySubscription
from garuda.persistence.models import (
    StrategyConfigRow,
    StrategyDefinitionsRow,
    StrategyIndicatorRulesRow,
    SubscriptionsRow,
)
from garuda.persistence.uow import UnitOfWork

logger = logging.getLogger(__name__)

#: What a strategy enters when its rules say nothing. An empty conjunction
#: passes, which is a strategy with no conditions -- a real thing to configure.
NO_CONDITIONS = AllOf(())

#: Columns of the configuration table that are not settings. Everything else
#: becomes a field a strategy can read.
NOT_A_SETTING = frozenset(
    {
        "id",
        "priority",
        "strategy_name",
        "tranch_number",
        "day_condition",
        "description",
        "created_at",
        "updated_at",
    }
)


@dataclass(frozen=True)
class Strategy:
    """One strategy, ready to be subscribed to."""

    spec: StrategySpec
    entry_rules: Rule
    exit_rules: Rule | None
    direction_rules: tuple[DirectionRule, ...]
    layers: tuple[ConfigLayer, ...]
    tranches: tuple[int, ...]

    @property
    def name(self) -> str:
        return self.spec.name

    def configuration(self, tranche: int, conditions: frozenset[DayCondition]) -> ResolvedConfig:

        return resolve(self.name, self.layers, tranche=tranche, conditions=conditions)


@dataclass(frozen=True)
class Loaded:
    """Everything read, and everything refused."""

    strategies: Mapping[str, Strategy]
    subscriptions: tuple[StrategySubscription, ...]
    #: Strategy name to the reason it was left out.
    refused: Mapping[str, str]


async def load_strategies(
    sessions: async_sessionmaker[AsyncSession], *, currency: Currency = Currency.INR
) -> Loaded:
    """Read every active strategy and the subscriptions to it."""
    async with UnitOfWork(sessions) as uow:
        definitions = await uow.repositories.strategy_definitions.all()
        configs = await uow.repositories.strategy_config.all()
        rules = await uow.repositories.strategy_indicator_rules.all()
        subscriptions = await uow.repositories.subscriptions.all()

    return assemble(definitions, configs, rules, subscriptions, currency=currency)


def assemble(
    definitions: Sequence[StrategyDefinitionsRow],
    configs: Sequence[StrategyConfigRow],
    rules: Sequence[StrategyIndicatorRulesRow],
    subscriptions: Sequence[SubscriptionsRow],
    *,
    currency: Currency = Currency.INR,
) -> Loaded:
    """Turn rows into strategies. The whole mapping, and nothing else."""
    by_strategy_config: dict[str, list[StrategyConfigRow]] = {}
    for row in configs:
        by_strategy_config.setdefault(row.strategy_name, []).append(row)
    by_strategy_rules = {row.strategy_name: row for row in rules}

    built: dict[str, Strategy] = {}
    refused: dict[str, str] = {}
    for definition in definitions:
        if (definition.status or "").upper() != "ACTIVE":
            continue
        try:
            built[definition.strategy_name] = _strategy(
                definition,
                by_strategy_config.get(definition.strategy_name, []),
                by_strategy_rules.get(definition.strategy_name),
            )
        except DomainError as error:
            refused[definition.strategy_name] = str(error)
            logger.error("%s will not be traded: %s", definition.strategy_name, error)

    return Loaded(
        strategies=built,
        subscriptions=_subscriptions(subscriptions, built, refused, currency),
        refused=refused,
    )


def _subscriptions(
    rows: Sequence[SubscriptionsRow],
    strategies: Mapping[str, Strategy],
    refused: Mapping[str, str],
    currency: Currency,
) -> tuple[StrategySubscription, ...]:
    out: list[StrategySubscription] = []
    for row in rows:
        if not row.is_active:
            continue
        strategy = strategies.get(row.strategy_name)
        if strategy is None:
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
            StrategySubscription(
                trading_client=TradingClientId(row.trading_client_id),
                spec=strategy.spec,
                capital=Money(Decimal(row.capital), currency),
                entry_rules=strategy.entry_rules,
                direction_rules=strategy.direction_rules,
                tranches=strategy.tranches,
                is_paper=bool(row.is_paper_trading),
            )
        )
    return tuple(out)


def _strategy(
    definition: StrategyDefinitionsRow,
    configs: Sequence[StrategyConfigRow],
    rules: StrategyIndicatorRulesRow | None,
) -> Strategy:
    underlying = InstrumentId(f"{definition.exchange}:{definition.underlying_symbol}")
    layers = tuple(_layer(row) for row in configs)

    spec = StrategySpec(
        name=definition.strategy_name,
        underlying=underlying,
        direction=_direction(definition),
        legs=_legs(definition),
    )
    return Strategy(
        spec=spec,
        entry_rules=_rules(definition.strategy_name, "entry", rules),
        exit_rules=_optional_rules(definition.strategy_name, "exit", rules),
        direction_rules=_direction_rules(definition, rules),
        layers=layers,
        tranches=_tranches(configs),
    )


def _layer(row: StrategyConfigRow) -> ConfigLayer:
    """One configuration row, reduced to the fields it actually sets.

    A null means "not set at this scope" and must not be carried, or it would
    override a broader scope with nothing.
    """
    values = {
        column.name: getattr(row, column.name)
        for column in row.__table__.columns
        if column.name not in NOT_A_SETTING and getattr(row, column.name) is not None
    }
    return ConfigLayer(
        values=values,
        tranche=row.tranch_number,
        day_condition=(DayCondition.parse(row.day_condition) if row.day_condition else None),
    )


def _tranches(configs: Sequence[StrategyConfigRow]) -> tuple[int, ...]:
    """Which tranches this strategy has, from the rows configuring them.

    A strategy with no tranche-scoped configuration has one tranche, numbered
    zero — which is the single-entry case wearing the same clothes as the
    multi-entry one, rather than a special case beside it.
    """
    numbered = sorted({row.tranch_number for row in configs if row.tranch_number is not None})
    return tuple(numbered) if numbered else (0,)


def _direction(definition: StrategyDefinitionsRow) -> DirectionProvider:
    """The fallback for a strategy with no direction rules.

    An undirectional strategy takes a fixed side and its legs read it — a short
    strangle sells both, so which side it is told hardly matters. A directional
    one without rules is refused (see :func:`_direction_rules`), so this is
    never the answer for one that needs a real opinion.
    """
    del definition
    return FixedDirection(Direction.SHORT)


def _direction_rules(
    definition: StrategyDefinitionsRow, rules: StrategyIndicatorRulesRow | None
) -> tuple[DirectionRule, ...]:
    """The rules that decide which way, in the order they are asked.

    A directional strategy with none is refused rather than traded: trading it
    in a direction nobody chose is worse than not trading it, and the only
    other option is to guess.
    """
    configured = _direction_json(definition.strategy_name, rules)
    if definition.is_directional and not configured:
        raise DomainError(
            f"{definition.strategy_name} is directional but has no direction rules; "
            "it is left out rather than traded in a direction nobody chose"
        )
    return configured


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
        return build_directions(parsed if isinstance(parsed, list) else [parsed])
    except DomainError as error:
        raise DomainError(f"{strategy}: its direction rules are not usable — {error}") from None


def _legs(definition: StrategyDefinitionsRow) -> tuple[LegSpec, ...]:
    """The legs a strategy enters, from its combo column."""
    raw = (definition.combo_spec_json or "").strip()
    if not raw:
        raise DomainError(
            f"{definition.strategy_name} describes no legs; nothing can be entered for it"
        )

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        raise DomainError(
            f"{definition.strategy_name}: its legs are not readable JSON ({error})"
        ) from None

    entries = parsed.get("legs") if isinstance(parsed, Mapping) else parsed
    if not isinstance(entries, Sequence) or isinstance(entries, str) or not entries:
        raise DomainError(f"{definition.strategy_name}: expected a list of legs")

    return tuple(_leg(definition, index, entry) for index, entry in enumerate(entries))


def _leg(definition: StrategyDefinitionsRow, index: int, entry: object) -> LegSpec:
    if not isinstance(entry, Mapping):
        raise DomainError(f"{definition.strategy_name}: leg {index} is not an object")

    try:
        return LegSpec(
            selector=build_selector(entry.get("instrument")),
            side=SideRule(str(entry.get("side", SideRule.ALWAYS_SHORT.value))),
            role=LegRole(str(entry.get("role", LegRole.MAIN.value))),
            product=_product(definition, entry),
            order_type=OrderType(str(entry.get("order_type", OrderType.MARKET.value))),
            ratio_numerator=int(entry.get("ratio_numerator", 1)),
            ratio_denominator=int(entry.get("ratio_denominator", 1)),
            sequence=int(entry.get("sequence", index)),
        )
    except ValueError as error:
        raise DomainError(f"{definition.strategy_name}: leg {index} — {error}") from None


def _product(definition: StrategyDefinitionsRow, entry: Mapping[str, object]) -> ProductType:
    """A leg's product, or the strategy's if the leg does not say.

    The definition's product is the reference engine's vocabulary — intraday
    or positional — and a leg may override it, because a cash-and-futures pair
    is two products in one position.
    """
    named = entry.get("product")
    if named is not None:
        return ProductType(str(named))
    return ProductType.MIS if (definition.product or "").upper() == "INTRADAY" else ProductType.NRML


def _rules(strategy: str, which: str, rules: StrategyIndicatorRulesRow | None) -> Rule:
    parsed = _optional_rules(strategy, which, rules)
    return parsed if parsed is not None else NO_CONDITIONS


def _optional_rules(
    strategy: str, which: str, rules: StrategyIndicatorRulesRow | None
) -> Rule | None:
    if rules is None:
        return None
    raw = (getattr(rules, f"{which}_rules_json", None) or "").strip()
    if not raw:
        return None
    try:
        return build_rule(json.loads(raw))
    except json.JSONDecodeError as error:
        raise DomainError(
            f"{strategy}: its {which} rules are not readable JSON ({error})"
        ) from None
    except DomainError as error:
        raise DomainError(f"{strategy}: its {which} rules are not usable — {error}") from None
