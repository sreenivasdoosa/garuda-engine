"""A repository per table.

Thin subclasses of :class:`Repository`, one for every table, so a caller gets
a typed handle rather than passing a model class around. The generic base
covers fetch, filter, page, count, insert, upsert, update and delete; the
finders below are the ones the reference engine actually has, and nothing is
invented for a table that never needed one.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from garuda.persistence import models
from garuda.persistence.repository import Repository


class AggregatedPnlSnapshotsRepository(Repository[models.AggregatedPnlSnapshotsRow]):
    model = models.AggregatedPnlSnapshotsRow


class AlertsRepository(Repository[models.AlertsRow]):
    model = models.AlertsRow


class AllocationModelStrategiesRepository(Repository[models.AllocationModelStrategiesRow]):
    model = models.AllocationModelStrategiesRow


class AllocationModelsRepository(Repository[models.AllocationModelsRow]):
    model = models.AllocationModelsRow


class AppConfigRepository(Repository[models.AppConfigRow]):
    model = models.AppConfigRow

    async def value_of(self, key: str, default: str | None = None) -> str | None:
        row = await self.get(key)
        return row.value if row is not None else default

    async def set(self, key: str, value: str) -> None:
        await self.upsert({"key": key, "value": value})

    async def as_mapping(self) -> dict[str, str | None]:
        return {row.key: row.value for row in await self.all()}


class AuditLogRepository(Repository[models.AuditLogRow]):
    model = models.AuditLogRow

    async def for_entity(self, entity_type: str, entity_id: str) -> Sequence[models.AuditLogRow]:
        """Everything that ever happened to one thing."""
        return await self.find(entity_type=entity_type, entity_id=entity_id)


class BrokerApiStatsRepository(Repository[models.BrokerApiStatsRow]):
    model = models.BrokerApiStatsRow


class BrokerExchangeConfigRepository(Repository[models.BrokerExchangeConfigRow]):
    model = models.BrokerExchangeConfigRow


class BrokeragePlanRatesRepository(Repository[models.BrokeragePlanRatesRow]):
    model = models.BrokeragePlanRatesRow


class BrokeragePlansRepository(Repository[models.BrokeragePlansRow]):
    model = models.BrokeragePlansRow


class BrokersRepository(Repository[models.BrokersRow]):
    model = models.BrokersRow


class CapitalChangeHistoryRepository(Repository[models.CapitalChangeHistoryRow]):
    model = models.CapitalChangeHistoryRow


class ClientCapitalRepository(Repository[models.ClientCapitalRow]):
    model = models.ClientCapitalRow


class ClientMarginsRepository(Repository[models.ClientMarginsRow]):
    model = models.ClientMarginsRow


class ClientPnlSnapshotsRepository(Repository[models.ClientPnlSnapshotsRow]):
    model = models.ClientPnlSnapshotsRow


class CorporateActionsRepository(Repository[models.CorporateActionsRow]):
    model = models.CorporateActionsRow


class DailySymbolClosePricesRepository(Repository[models.DailySymbolClosePricesRow]):
    model = models.DailySymbolClosePricesRow


class DataProviderSessionsRepository(Repository[models.DataProviderSessionsRow]):
    model = models.DataProviderSessionsRow


class EodPnlReportsRepository(Repository[models.EodPnlReportsRow]):
    model = models.EodPnlReportsRow


class EventDaysRepository(Repository[models.EventDaysRow]):
    model = models.EventDaysRow


class EventJournalRepository(Repository[models.EventJournalRow]):
    model = models.EventJournalRow


class ExchangesRepository(Repository[models.ExchangesRow]):
    model = models.ExchangesRow


class ExitPolicyRepository(Repository[models.ExitPolicyRow]):
    model = models.ExitPolicyRow


class HedgeSchedulesRepository(Repository[models.HedgeSchedulesRow]):
    model = models.HedgeSchedulesRow


class HolidaysRepository(Repository[models.HolidaysRow]):
    model = models.HolidaysRow


class IvCandlesRepository(Repository[models.IvCandlesRow]):
    model = models.IvCandlesRow


class KillSwitchTypesRepository(Repository[models.KillSwitchTypesRow]):
    model = models.KillSwitchTypesRow


class KillSwitchesRepository(Repository[models.KillSwitchesRow]):
    model = models.KillSwitchesRow

    async def active(self) -> Sequence[models.KillSwitchesRow]:
        """Every switch currently stopping something."""
        return await self.find(is_active=True)


class LiveTradeSignalsRepository(Repository[models.LiveTradeSignalsRow]):
    model = models.LiveTradeSignalsRow


class LiveTradeSignalsArchiveRepository(Repository[models.LiveTradeSignalsArchiveRow]):
    model = models.LiveTradeSignalsArchiveRow


class LiveTradesRepository(Repository[models.LiveTradesRow]):
    model = models.LiveTradesRow

    async def for_client(self, trading_client_id: str) -> Sequence[models.LiveTradesRow]:
        return await self.find(trading_client_id=trading_client_id)

    async def in_state(self, state: str) -> Sequence[models.LiveTradesRow]:
        return await self.find(state=state)


class LiveTradesArchiveRepository(Repository[models.LiveTradesArchiveRow]):
    model = models.LiveTradesArchiveRow


class OrderFillEscalationPolicyRepository(Repository[models.OrderFillEscalationPolicyRow]):
    model = models.OrderFillEscalationPolicyRow


class PcrCandlesRepository(Repository[models.PcrCandlesRow]):
    model = models.PcrCandlesRow


class ProductsRepository(Repository[models.ProductsRow]):
    model = models.ProductsRow


class RmsBreachLogRepository(Repository[models.RmsBreachLogRow]):
    model = models.RmsBreachLogRow

    async def for_client(self, trading_client_id: str) -> Sequence[models.RmsBreachLogRow]:
        return await self.find(trading_client_id=trading_client_id)


class RmsClientStateRepository(Repository[models.RmsClientStateRow]):
    model = models.RmsClientStateRow


class RmsConfigRepository(Repository[models.RmsConfigRow]):
    model = models.RmsConfigRow


class RmsDailyStatsRepository(Repository[models.RmsDailyStatsRow]):
    model = models.RmsDailyStatsRow


class RulesRepository(Repository[models.RulesRow]):
    model = models.RulesRow


class SlTargetPolicyRepository(Repository[models.SlTargetPolicyRow]):
    model = models.SlTargetPolicyRow


class StatutoryChargesRepository(Repository[models.StatutoryChargesRow]):
    model = models.StatutoryChargesRow


class StatutoryChargesBrokerOverridesRepository(
    Repository[models.StatutoryChargesBrokerOverridesRow]
):
    model = models.StatutoryChargesBrokerOverridesRow


class StockUniverseMembersRepository(Repository[models.StockUniverseMembersRow]):
    model = models.StockUniverseMembersRow


class StockUniversesRepository(Repository[models.StockUniversesRow]):
    model = models.StockUniversesRow


class StraddleCandlesRepository(Repository[models.StraddleCandlesRow]):
    model = models.StraddleCandlesRow


class StrategyBreakoutWatchesRepository(Repository[models.StrategyBreakoutWatchesRow]):
    model = models.StrategyBreakoutWatchesRow


class StrategyConfigRepository(Repository[models.StrategyConfigRow]):
    model = models.StrategyConfigRow


class StrategyDefinitionsRepository(Repository[models.StrategyDefinitionsRow]):
    model = models.StrategyDefinitionsRow


class StrategyEvaluationLogRepository(Repository[models.StrategyEvaluationLogRow]):
    model = models.StrategyEvaluationLogRow


class StrategyIndicatorRulesRepository(Repository[models.StrategyIndicatorRulesRow]):
    model = models.StrategyIndicatorRulesRow


class StrategyRulesMapRepository(Repository[models.StrategyRulesMapRow]):
    model = models.StrategyRulesMapRow


class StrategyRulesOutputRepository(Repository[models.StrategyRulesOutputRow]):
    model = models.StrategyRulesOutputRow


class StrategySymbolSubscriptionsRepository(Repository[models.StrategySymbolSubscriptionsRow]):
    model = models.StrategySymbolSubscriptionsRow


class StrategyTemplatesRepository(Repository[models.StrategyTemplatesRow]):
    model = models.StrategyTemplatesRow


class StrikeSelectionPolicyRepository(Repository[models.StrikeSelectionPolicyRow]):
    model = models.StrikeSelectionPolicyRow


class SubscriptionStateRepository(Repository[models.SubscriptionStateRow]):
    model = models.SubscriptionStateRow


class SubscriptionsRepository(Repository[models.SubscriptionsRow]):
    model = models.SubscriptionsRow

    async def for_client(self, trading_client_id: str) -> Sequence[models.SubscriptionsRow]:
        return await self.find(trading_client_id=trading_client_id)

    async def for_strategy(self, strategy_name: str) -> Sequence[models.SubscriptionsRow]:
        """Every account running a strategy — the fan-out an evaluation drives."""
        return await self.find(strategy_name=strategy_name)


class SymbolBrokerInfoRepository(Repository[models.SymbolBrokerInfoRow]):
    model = models.SymbolBrokerInfoRow


class SymbolsRepository(Repository[models.SymbolsRow]):
    model = models.SymbolsRow

    async def for_exchange(self, exchange: str) -> Sequence[models.SymbolsRow]:
        return await self.find(exchange=exchange, order_by="symbol")

    async def indices(self) -> Sequence[models.SymbolsRow]:
        """Underlyings whose spot comes from an index feed rather than a stock."""
        return await self.find(is_index=True, order_by="symbol")


class SyntheticCandlesRepository(Repository[models.SyntheticCandlesRow]):
    model = models.SyntheticCandlesRow


class TradeCorporateActionsRepository(Repository[models.TradeCorporateActionsRow]):
    model = models.TradeCorporateActionsRow


class TradeLogRepository(Repository[models.TradeLogRow]):
    model = models.TradeLogRow


class TradesRepository(Repository[models.TradesRow]):
    model = models.TradesRow

    async def for_day(self, trade_date: object) -> Sequence[models.TradesRow]:
        """Every trade on one trading day. Hits a single partition."""
        return await self.find(trade_date=trade_date, order_by="start_timestamp")

    async def for_client_on(
        self, trading_client_id: str, trade_date: object
    ) -> Sequence[models.TradesRow]:
        return await self.find(
            trading_client_id=trading_client_id,
            trade_date=trade_date,
            order_by="start_timestamp",
        )

    async def for_strategy_on(
        self, strategy_name: str, trade_date: object
    ) -> Sequence[models.TradesRow]:
        return await self.find(strategy_name=strategy_name, trade_date=trade_date)

    async def by_combo(self, combo_id: str) -> Sequence[models.TradesRow]:
        """Every leg of one multi-leg position."""
        return await self.find(combo_id=combo_id, order_by="trade_id")


class TradingClientLoginStatusRepository(Repository[models.TradingClientLoginStatusRow]):
    model = models.TradingClientLoginStatusRow

    async def logged_in(self) -> Sequence[models.TradingClientLoginStatusRow]:
        return await self.find(is_login_success=True)

    async def failures(self) -> Sequence[models.TradingClientLoginStatusRow]:
        """Accounts whose last login attempt failed, for the Console to surface."""
        return await self.find(is_login_success=False)


class TradingClientsRepository(Repository[models.TradingClientRow]):
    model = models.TradingClientRow

    async def by_account(self, broker: str, client_id: str) -> models.TradingClientRow | None:
        """The natural key. One account cannot be registered twice."""
        return await self.find_one(broker=broker, client_id=client_id)

    async def by_display_name(self, display_name: str) -> models.TradingClientRow | None:
        return await self.find_one(display_name=display_name)

    async def enabled(self) -> Sequence[models.TradingClientRow]:
        """The accounts the engine will actually route to."""
        return await self.find(enabled=True, order_by="display_name")

    async def for_broker(self, broker: str) -> Sequence[models.TradingClientRow]:
        return await self.find(broker=broker, order_by="display_name")


class TrailingSlPolicyRepository(Repository[models.TrailingSlPolicyRow]):
    model = models.TrailingSlPolicyRow


class Repositories:
    """Every repository, bound to one session.

    Handed out by the unit of work so a caller reaches a table through a typed
    handle rather than passing model classes around, and so everything it
    touches is inside the same transaction.

    Instances are cached per session: two calls to the same repository return
    the same object, so identity map behaviour is not surprising.
    """

    def __init__(self, session: AsyncSession) -> None:
        self._session = session
        self._cache: dict[type[Any], Any] = {}

    def of[RepositoryT: Repository[Any]](self, repository: type[RepositoryT]) -> RepositoryT:
        """Any repository by class, for callers holding one generically."""
        cached = self._cache.get(repository)
        if cached is None:
            cached = repository(self._session)
            self._cache[repository] = cached
        return cached

    @property
    def aggregated_pnl_snapshots(self) -> AggregatedPnlSnapshotsRepository:
        return self.of(AggregatedPnlSnapshotsRepository)

    @property
    def alerts(self) -> AlertsRepository:
        return self.of(AlertsRepository)

    @property
    def allocation_model_strategies(self) -> AllocationModelStrategiesRepository:
        return self.of(AllocationModelStrategiesRepository)

    @property
    def allocation_models(self) -> AllocationModelsRepository:
        return self.of(AllocationModelsRepository)

    @property
    def app_config(self) -> AppConfigRepository:
        return self.of(AppConfigRepository)

    @property
    def audit_log(self) -> AuditLogRepository:
        return self.of(AuditLogRepository)

    @property
    def broker_api_stats(self) -> BrokerApiStatsRepository:
        return self.of(BrokerApiStatsRepository)

    @property
    def broker_exchange_config(self) -> BrokerExchangeConfigRepository:
        return self.of(BrokerExchangeConfigRepository)

    @property
    def brokerage_plan_rates(self) -> BrokeragePlanRatesRepository:
        return self.of(BrokeragePlanRatesRepository)

    @property
    def brokerage_plans(self) -> BrokeragePlansRepository:
        return self.of(BrokeragePlansRepository)

    @property
    def brokers(self) -> BrokersRepository:
        return self.of(BrokersRepository)

    @property
    def capital_change_history(self) -> CapitalChangeHistoryRepository:
        return self.of(CapitalChangeHistoryRepository)

    @property
    def client_capital(self) -> ClientCapitalRepository:
        return self.of(ClientCapitalRepository)

    @property
    def client_margins(self) -> ClientMarginsRepository:
        return self.of(ClientMarginsRepository)

    @property
    def client_pnl_snapshots(self) -> ClientPnlSnapshotsRepository:
        return self.of(ClientPnlSnapshotsRepository)

    @property
    def corporate_actions(self) -> CorporateActionsRepository:
        return self.of(CorporateActionsRepository)

    @property
    def daily_symbol_close_prices(self) -> DailySymbolClosePricesRepository:
        return self.of(DailySymbolClosePricesRepository)

    @property
    def data_provider_sessions(self) -> DataProviderSessionsRepository:
        return self.of(DataProviderSessionsRepository)

    @property
    def eod_pnl_reports(self) -> EodPnlReportsRepository:
        return self.of(EodPnlReportsRepository)

    @property
    def event_days(self) -> EventDaysRepository:
        return self.of(EventDaysRepository)

    @property
    def event_journal(self) -> EventJournalRepository:
        return self.of(EventJournalRepository)

    @property
    def exchanges(self) -> ExchangesRepository:
        return self.of(ExchangesRepository)

    @property
    def exit_policy(self) -> ExitPolicyRepository:
        return self.of(ExitPolicyRepository)

    @property
    def hedge_schedules(self) -> HedgeSchedulesRepository:
        return self.of(HedgeSchedulesRepository)

    @property
    def holidays(self) -> HolidaysRepository:
        return self.of(HolidaysRepository)

    @property
    def iv_candles(self) -> IvCandlesRepository:
        return self.of(IvCandlesRepository)

    @property
    def kill_switch_types(self) -> KillSwitchTypesRepository:
        return self.of(KillSwitchTypesRepository)

    @property
    def kill_switches(self) -> KillSwitchesRepository:
        return self.of(KillSwitchesRepository)

    @property
    def live_trade_signals_archive(self) -> LiveTradeSignalsArchiveRepository:
        return self.of(LiveTradeSignalsArchiveRepository)

    @property
    def live_trade_signals(self) -> LiveTradeSignalsRepository:
        return self.of(LiveTradeSignalsRepository)

    @property
    def live_trades_archive(self) -> LiveTradesArchiveRepository:
        return self.of(LiveTradesArchiveRepository)

    @property
    def live_trades(self) -> LiveTradesRepository:
        return self.of(LiveTradesRepository)

    @property
    def order_fill_escalation_policy(self) -> OrderFillEscalationPolicyRepository:
        return self.of(OrderFillEscalationPolicyRepository)

    @property
    def pcr_candles(self) -> PcrCandlesRepository:
        return self.of(PcrCandlesRepository)

    @property
    def products(self) -> ProductsRepository:
        return self.of(ProductsRepository)

    @property
    def rms_breach_log(self) -> RmsBreachLogRepository:
        return self.of(RmsBreachLogRepository)

    @property
    def rms_client_state(self) -> RmsClientStateRepository:
        return self.of(RmsClientStateRepository)

    @property
    def rms_config(self) -> RmsConfigRepository:
        return self.of(RmsConfigRepository)

    @property
    def rms_daily_stats(self) -> RmsDailyStatsRepository:
        return self.of(RmsDailyStatsRepository)

    @property
    def rules(self) -> RulesRepository:
        return self.of(RulesRepository)

    @property
    def sl_target_policy(self) -> SlTargetPolicyRepository:
        return self.of(SlTargetPolicyRepository)

    @property
    def statutory_charges_broker_overrides(self) -> StatutoryChargesBrokerOverridesRepository:
        return self.of(StatutoryChargesBrokerOverridesRepository)

    @property
    def statutory_charges(self) -> StatutoryChargesRepository:
        return self.of(StatutoryChargesRepository)

    @property
    def stock_universe_members(self) -> StockUniverseMembersRepository:
        return self.of(StockUniverseMembersRepository)

    @property
    def stock_universes(self) -> StockUniversesRepository:
        return self.of(StockUniversesRepository)

    @property
    def straddle_candles(self) -> StraddleCandlesRepository:
        return self.of(StraddleCandlesRepository)

    @property
    def strategy_breakout_watches(self) -> StrategyBreakoutWatchesRepository:
        return self.of(StrategyBreakoutWatchesRepository)

    @property
    def strategy_config(self) -> StrategyConfigRepository:
        return self.of(StrategyConfigRepository)

    @property
    def strategy_definitions(self) -> StrategyDefinitionsRepository:
        return self.of(StrategyDefinitionsRepository)

    @property
    def strategy_evaluation_log(self) -> StrategyEvaluationLogRepository:
        return self.of(StrategyEvaluationLogRepository)

    @property
    def strategy_indicator_rules(self) -> StrategyIndicatorRulesRepository:
        return self.of(StrategyIndicatorRulesRepository)

    @property
    def strategy_rules_map(self) -> StrategyRulesMapRepository:
        return self.of(StrategyRulesMapRepository)

    @property
    def strategy_rules_output(self) -> StrategyRulesOutputRepository:
        return self.of(StrategyRulesOutputRepository)

    @property
    def strategy_symbol_subscriptions(self) -> StrategySymbolSubscriptionsRepository:
        return self.of(StrategySymbolSubscriptionsRepository)

    @property
    def strategy_templates(self) -> StrategyTemplatesRepository:
        return self.of(StrategyTemplatesRepository)

    @property
    def strike_selection_policy(self) -> StrikeSelectionPolicyRepository:
        return self.of(StrikeSelectionPolicyRepository)

    @property
    def subscription_state(self) -> SubscriptionStateRepository:
        return self.of(SubscriptionStateRepository)

    @property
    def subscriptions(self) -> SubscriptionsRepository:
        return self.of(SubscriptionsRepository)

    @property
    def symbol_broker_info(self) -> SymbolBrokerInfoRepository:
        return self.of(SymbolBrokerInfoRepository)

    @property
    def symbols(self) -> SymbolsRepository:
        return self.of(SymbolsRepository)

    @property
    def synthetic_candles(self) -> SyntheticCandlesRepository:
        return self.of(SyntheticCandlesRepository)

    @property
    def trade_corporate_actions(self) -> TradeCorporateActionsRepository:
        return self.of(TradeCorporateActionsRepository)

    @property
    def trade_log(self) -> TradeLogRepository:
        return self.of(TradeLogRepository)

    @property
    def trades(self) -> TradesRepository:
        return self.of(TradesRepository)

    @property
    def trading_client_login_status(self) -> TradingClientLoginStatusRepository:
        return self.of(TradingClientLoginStatusRepository)

    @property
    def trading_clients(self) -> TradingClientsRepository:
        return self.of(TradingClientsRepository)

    @property
    def trailing_sl_policy(self) -> TrailingSlPolicyRepository:
        return self.of(TrailingSlPolicyRepository)
