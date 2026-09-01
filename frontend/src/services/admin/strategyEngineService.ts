/**
 * Strategy Engine Service
 * API service for the event-driven strategy execution engine
 */

import { api } from '@/api/client';
import apiClient from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { TemplateResolution } from '@/types/strategy-engine';
import type {
  StrategyTemplate,
  CreateStrategyTemplateRequest,
  UpdateStrategyTemplateRequest,
  StrategyDefinition,
  CreateStrategyDefinitionRequest,
  UpdateStrategyDefinitionRequest,
  StrategyStatus,
  UserStrategySubscription,
  CreateUserSubscriptionRequest,
  UpdateUserSubscriptionRequest,
  TranchSchedule,
  CreateTranchScheduleRequest,
  UpdateTranchScheduleRequest,
  ExternalSignal,
  CreateExternalSignalRequest,
  CancelSignalRequest,
  EngineStatus,
  SignalCleanupResult,
  AllEnginesStatus,
  ExchangeEngineStatus,
  ExchangeEngineMetrics,
  StrategyStateSnapshot,
  IndicatorRuleSet,
  StrategyStateSummary,
  StrategyStateFilters,
  BreakoutWatch,
  BreakoutWatchSummary,
} from '@/types/strategy-engine';

// ==================== ENGINE CONTROL ====================

export const engineControlService = {
  // Get all exchanges engine status
  async getAllStatus(): Promise<AllEnginesStatus> {
    return api.get<AllEnginesStatus>(API_ENDPOINTS.V2_ENGINE.STATUS);
  },

  // Get engine status for specific exchange
  async getStatus(exchange: string): Promise<ExchangeEngineStatus> {
    return api.get<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.STATUS_EXCHANGE(exchange));
  },

  // Get detailed metrics for specific exchange
  async getMetrics(exchange: string): Promise<ExchangeEngineMetrics> {
    return api.get<ExchangeEngineMetrics>(API_ENDPOINTS.V2_ENGINE.METRICS(exchange));
  },

  // Start the engine for specific exchange
  async start(exchange: string): Promise<ExchangeEngineStatus> {
    return api.post<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.START(exchange), {});
  },

  // Stop the engine for specific exchange
  async stop(exchange: string): Promise<ExchangeEngineStatus> {
    return api.post<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.STOP(exchange), {});
  },

  // Reload subscriptions for specific exchange
  async reload(exchange: string): Promise<ExchangeEngineStatus> {
    return api.post<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.RELOAD(exchange), {});
  },

  // Enable dry run mode for specific exchange
  async enableDryRun(exchange: string): Promise<ExchangeEngineStatus> {
    return api.post<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.DRYRUN_ENABLE(exchange), {});
  },

  // Disable dry run mode for specific exchange
  async disableDryRun(exchange: string): Promise<ExchangeEngineStatus> {
    return api.post<ExchangeEngineStatus>(API_ENDPOINTS.V2_ENGINE.DRYRUN_DISABLE(exchange), {});
  },

  // Shutdown all engines
  async shutdownAll(): Promise<{ message: string }> {
    return api.post<{ message: string }>(API_ENDPOINTS.V2_ENGINE.SHUTDOWN_ALL, {});
  },

  // Legacy single-engine methods (deprecated - for backwards compatibility)
  /** @deprecated Use getAllStatus() instead */
  async getLegacyStatus(): Promise<EngineStatus> {
    // Return combined status from all exchanges
    const allStatus = await this.getAllStatus();
    const combined: EngineStatus = {
      running: allStatus.activeEngines > 0,
      dryRunMode: allStatus.exchanges.some(e => e.dryRunMode),
      activeSubscriptions: allStatus.exchanges.reduce((sum, e) => sum + e.activeSubscriptions, 0),
      eventsProcessed: 0,
      signalsGenerated: 0,
      ticksPublished: 0,
      scheduledTranches: allStatus.exchanges.reduce((sum, e) => sum + e.scheduledTranches, 0),
      scheduledHedges: allStatus.exchanges.reduce((sum, e) => sum + (e.scheduledHedges || 0), 0),
    };
    return combined;
  },
};

// ==================== STRATEGY TEMPLATES ====================

export const strategyTemplateService = {
  // Get all templates
  async getAll(): Promise<StrategyTemplate[]> {
    return api.get<StrategyTemplate[]>(API_ENDPOINTS.V2_ENGINE_TEMPLATES.LIST);
  },

  // Get active templates only
  async getActive(): Promise<StrategyTemplate[]> {
    return api.get<StrategyTemplate[]>(API_ENDPOINTS.V2_ENGINE_TEMPLATES.ACTIVE);
  },

  // Get template by name
  async getByName(templateName: string): Promise<StrategyTemplate> {
    return api.get<StrategyTemplate>(API_ENDPOINTS.V2_ENGINE_TEMPLATES.DETAILS(templateName));
  },

  // Create template
  async create(data: CreateStrategyTemplateRequest): Promise<StrategyTemplate> {
    return api.post<StrategyTemplate>(API_ENDPOINTS.V2_ENGINE_TEMPLATES.BASE, data);
  },

  // Update template
  async update(templateName: string, data: UpdateStrategyTemplateRequest): Promise<StrategyTemplate> {
    return api.put<StrategyTemplate>(API_ENDPOINTS.V2_ENGINE_TEMPLATES.DETAILS(templateName), data);
  },

  // Delete template
  async delete(templateName: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_TEMPLATES.DETAILS(templateName));
  },
};

// ==================== STRATEGY DEFINITIONS ====================

export const strategyDefinitionService = {
  // Get all definitions
  async getAll(params?: {
    template?: string;
    symbol?: string;
    exchange?: string;
    status?: StrategyStatus;
  }): Promise<StrategyDefinition[]> {
    return api.get<StrategyDefinition[]>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.LIST, params);
  },

  // Get active definitions only
  async getActive(): Promise<StrategyDefinition[]> {
    return api.get<StrategyDefinition[]>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.ACTIVE);
  },

  // Get definition by ID
  async getById(id: number): Promise<StrategyDefinition> {
    return api.get<StrategyDefinition>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.DETAILS(id));
  },

  // Get definition by name
  async getByName(strategyName: string): Promise<StrategyDefinition> {
    return api.get<StrategyDefinition>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.BY_NAME(strategyName));
  },

  // Create definition
  async create(data: CreateStrategyDefinitionRequest): Promise<StrategyDefinition> {
    return api.post<StrategyDefinition>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.BASE, data);
  },

  /**
   * W4: resolve which template (engine) a definition draft lands on, without saving anything.
   * The form shows the result read-only instead of asking the admin to pick a template — generic
   * templates are an implementation detail; only custom-logic ones are ever chosen by hand.
   * Indicator flags travel as query params because rules are saved after the definition, so at
   * draft time they are stated intent, not storage.
   */
  async resolveTemplate(
    draft: Partial<CreateStrategyDefinitionRequest>,
    indicatorEntry: boolean,
    indicatorExit: boolean,
  ): Promise<TemplateResolution> {
    const qs = `?indicatorEntry=${indicatorEntry}&indicatorExit=${indicatorExit}`;
    return api.post<TemplateResolution>(
      API_ENDPOINTS.V2_ENGINE_DEFINITIONS.RESOLVE_TEMPLATE + qs, draft);
  },

  // Update definition
  async update(id: number, data: UpdateStrategyDefinitionRequest): Promise<StrategyDefinition> {
    return api.put<StrategyDefinition>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.DETAILS(id), data);
  },

  // Change definition status (ACTIVE, WIND_DOWN, INACTIVE)
  async changeStatus(id: number, status: StrategyStatus): Promise<StrategyDefinition> {
    return api.post<StrategyDefinition>(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.CHANGE_STATUS(id, status), {});
  },

  // Delete definition
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.DETAILS(id));
  },
};

// ==================== STRATEGY DEFINITION TRANSFER (Export/Import) ====================

export interface ImportPreviewResult {
  newStrategies: string[];
  conflictingStrategies: string[];
  configTreeEntries: number;
  indicatorRulesEntries: number;
  warnings: string[];
  errors: string[];
}

export interface ImportApplyResult {
  imported: number;
  overridden: number;
  skipped: number;
  errors: string[];
}

export const strategyDefinitionTransferService = {
  // Export strategies as xlsx blob
  async exportDefinitions(strategyNames: string[] | 'all'): Promise<Blob> {
    const body = strategyNames === 'all'
      ? { all: true }
      : { strategyNames };
    const response = await apiClient.post(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.EXPORT, body, {
      responseType: 'blob',
    });
    return response as unknown as Blob;
  },

  // Preview import from xlsx file
  async importPreview(file: File): Promise<ImportPreviewResult> {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.IMPORT_PREVIEW, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // Apply import with conflict resolutions
  async importApply(
    file: File,
    resolutions: Record<string, 'OVERRIDE' | 'SKIP'>,
    defaultResolution: 'OVERRIDE' | 'SKIP' = 'SKIP'
  ): Promise<ImportApplyResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('resolutions', JSON.stringify(resolutions));
    formData.append('defaultResolution', defaultResolution);
    return apiClient.post(API_ENDPOINTS.V2_ENGINE_DEFINITIONS.IMPORT_APPLY, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
};

// ==================== USER SUBSCRIPTIONS ====================

export const userSubscriptionService = {
  // Get all subscriptions (including inactive)
  async getAll(): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.LIST, { activeOnly: false });
  },

  // Server-side filtered list for the admin table. Returns the FULL matching set
  // (subscriptions for ACTIVE users only) — the page groups by user+broker and
  // paginates those groups on the client, so every filter is pushed to the server
  // and a filter change re-fetches the right data. status/strategy/broker accept
  // 'all' (treated as no filter); paper accepts 'all' | 'paper' | 'live'.
  async getFiltered(params: {
    status?: string;
    search?: string;
    strategy?: string;
    broker?: string;
    paper?: string;
  }): Promise<UserStrategySubscription[]> {
    const query: Record<string, unknown> = {};
    if (params.status && params.status !== 'all') query.status = params.status;
    if (params.search) query.search = params.search;
    if (params.strategy && params.strategy !== 'all') query.strategy = params.strategy;
    if (params.broker && params.broker !== 'all') query.broker = params.broker;
    if (params.paper && params.paper !== 'all') query.paper = params.paper;
    return api.get<UserStrategySubscription[]>(
      API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.LIST, query);
  },

  // Get active subscriptions only
  async getActive(): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.ACTIVE);
  },

  // Get subscription by ID
  async getById(id: number): Promise<UserStrategySubscription> {
    return api.get<UserStrategySubscription>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.DETAILS(id));
  },

  // Get subscriptions by user
  async getByUser(username: string): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.BY_USER(username));
  },

  // Get subscriptions by strategy
  async getByStrategy(strategyName: string): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.BY_STRATEGY(strategyName));
  },

  // Get subscriptions that accept external signals
  async getSignalSubscriptions(): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.SIGNALS);
  },

  // Create subscription
  async create(data: CreateUserSubscriptionRequest): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.BASE, data);
  },

  // Update subscription
  async update(id: number, data: UpdateUserSubscriptionRequest): Promise<UserStrategySubscription> {
    return api.put<UserStrategySubscription>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.DETAILS(id), data);
  },

  // Activate subscription
  async activate(id: number): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.ACTIVATE(id), {});
  },

  // Deactivate subscription
  async deactivate(id: number): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.DEACTIVATE(id), {});
  },

  // Delete subscription
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.DETAILS(id));
  },

  // Delete all subscriptions for a user
  async deleteByUser(username: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_SUBSCRIPTIONS.BY_USER(username));
  },
};

// ==================== EXTERNAL SIGNALS ====================

export const externalSignalService = {
  // Get pending signals
  async getPending(limit?: number): Promise<ExternalSignal[]> {
    const params = limit ? { limit } : undefined;
    return api.get<ExternalSignal[]>(API_ENDPOINTS.V2_ENGINE_SIGNALS.PENDING, params);
  },

  // Get recent signals
  async getRecent(limit?: number): Promise<ExternalSignal[]> {
    const params = limit ? { limit } : undefined;
    return api.get<ExternalSignal[]>(API_ENDPOINTS.V2_ENGINE_SIGNALS.RECENT, params);
  },

  // Get signal by ID
  async getById(id: number): Promise<ExternalSignal> {
    return api.get<ExternalSignal>(API_ENDPOINTS.V2_ENGINE_SIGNALS.DETAILS(id));
  },

  // Get signals by source
  async getBySource(source: string, limit?: number): Promise<ExternalSignal[]> {
    const params = limit ? { limit } : undefined;
    return api.get<ExternalSignal[]>(API_ENDPOINTS.V2_ENGINE_SIGNALS.BY_SOURCE(source), params);
  },

  // Submit new signal
  async submit(data: CreateExternalSignalRequest): Promise<ExternalSignal> {
    return api.post<ExternalSignal>(API_ENDPOINTS.V2_ENGINE_SIGNALS.BASE, data);
  },

  // Cancel/skip signal
  async cancel(id: number, data?: CancelSignalRequest): Promise<ExternalSignal> {
    return api.post<ExternalSignal>(API_ENDPOINTS.V2_ENGINE_SIGNALS.CANCEL(id), data || {});
  },

  // Delete signal
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_SIGNALS.DETAILS(id));
  },

  // Cleanup old processed signals
  async cleanup(daysOld?: number): Promise<SignalCleanupResult> {
    const params = daysOld ? { days: daysOld } : undefined;
    return api.delete<SignalCleanupResult>(API_ENDPOINTS.V2_ENGINE_SIGNALS.CLEANUP, params);
  },
};

// ==================== TRANCH SCHEDULES ====================

export const tranchScheduleService = {
  // Get all schedules
  async getAll(): Promise<TranchSchedule[]> {
    return api.get<TranchSchedule[]>(API_ENDPOINTS.V2_ENGINE_SCHEDULES.LIST);
  },

  // Get schedule by ID
  async getById(id: number): Promise<TranchSchedule> {
    return api.get<TranchSchedule>(API_ENDPOINTS.V2_ENGINE_SCHEDULES.DETAILS(id));
  },

  // Get schedules by strategy
  async getByStrategy(strategyName: string): Promise<TranchSchedule[]> {
    return api.get<TranchSchedule[]>(API_ENDPOINTS.V2_ENGINE_SCHEDULES.BY_STRATEGY(strategyName));
  },

  // Create schedule
  async create(data: CreateTranchScheduleRequest): Promise<TranchSchedule> {
    return api.post<TranchSchedule>(API_ENDPOINTS.V2_ENGINE_SCHEDULES.BASE, data);
  },

  // Update schedule
  async update(id: number, data: UpdateTranchScheduleRequest): Promise<TranchSchedule> {
    return api.put<TranchSchedule>(API_ENDPOINTS.V2_ENGINE_SCHEDULES.DETAILS(id), data);
  },

  // Delete schedule
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_SCHEDULES.DETAILS(id));
  },
};

// ==================== STRATEGY STATES (Monitoring) ====================

export const strategyStateService = {
  /**
   * Get all strategy states for today (or specified date)
   * Supports filtering by username, strategy, date
   */
  async getStates(filters?: StrategyStateFilters): Promise<StrategyStateSnapshot[]> {
    const params: Record<string, string> = {};
    if (filters?.username) params.username = filters.username;
    if (filters?.strategy) params.strategy = filters.strategy;
    if (filters?.date) params.date = filters.date;
    return api.get<StrategyStateSnapshot[]>(API_ENDPOINTS.V2_ENGINE_STATES.LIST, params);
  },

  /**
   * Get aggregate summary of strategy states
   */
  async getSummary(date?: string): Promise<StrategyStateSummary> {
    const params = date ? { date } : undefined;
    return api.get<StrategyStateSummary>(API_ENDPOINTS.V2_ENGINE_STATES.SUMMARY, params);
  },

  /**
   * Get specific strategy state for a user-strategy-broker combination
   */
  async getDetails(
    username: string,
    strategy: string,
    broker: string,
    date?: string
  ): Promise<StrategyStateSnapshot> {
    const params = date ? { date } : undefined;
    return api.get<StrategyStateSnapshot>(
      API_ENDPOINTS.V2_ENGINE_STATES.DETAILS(username, strategy, broker),
      params
    );
  },
};

// ==================== HEDGE REPLACE RECOVERY ====================

export interface HedgeReplaceStatusItem {
  tradeID: string;
  username: string;
  broker: string;
  strategy: string;
  tradingSymbol: string;
  hedgeReplaceStatus: string;
  hedgeReplaceWindowType: string | null;
  hedgeReplaceAttemptTimestamp: string | null;
  newHedgeTradeID: string | null;
  hedgeReplaceFailureReason: string | null;
  currentHedgeTradeID: string | null;
}

export interface HedgeReplaceStatusResponse {
  success: boolean;
  count: number;
  filters: {
    username: string;
    broker: string;
    strategy: string;
  };
  data: HedgeReplaceStatusItem[];
}

export interface HedgeReplaceRecoveryResult {
  success: boolean;
  strategyName: string;
  windowType: string;
  tradesChecked: number;
  tradesRecovered: number;
  tradesFailed: number;
  tradesComplete: number;
  tradesInProgress: number;
  message: string;
  details: Array<{
    tradeID: string;
    username: string;
    broker: string;
    status: string;
    action: string;
    strategy?: string;
    group?: string;
    hedgeDistance?: number;
    error?: string;
  }>;
}

const HEDGE_REPLACE_URL = '/api/v2/hedge-replace';

export const hedgeReplaceService = {
  /**
   * Get hedge replace status with optional filters
   */
  async getStatus(filters?: {
    username?: string;
    broker?: string;
    strategy?: string;
  }): Promise<HedgeReplaceStatusResponse> {
    return api.get<HedgeReplaceStatusResponse>(`${HEDGE_REPLACE_URL}/status`, filters);
  },

  /**
   * Trigger manual recovery for a specific strategy or ALL strategies
   * @param strategyName - Strategy name or 'ALL' for all strategies
   * @param windowType - 'MORNING' or 'EVENING'
   */
  async runRecovery(
    strategyName: string,
    windowType: 'MORNING' | 'EVENING'
  ): Promise<HedgeReplaceRecoveryResult> {
    return api.post<HedgeReplaceRecoveryResult>(`${HEDGE_REPLACE_URL}/recover`, {
      strategyName,
      windowType,
    });
  },
};

// ==================== INDICATOR RULES ====================

export const indicatorRulesService = {
  // Get all indicator rules
  async getAll(): Promise<IndicatorRuleSet[]> {
    return api.get<IndicatorRuleSet[]>(API_ENDPOINTS.V2_ENGINE_INDICATOR_RULES.LIST);
  },

  // Get indicator rules by strategy name
  async getByStrategy(strategyName: string): Promise<IndicatorRuleSet | null> {
    try {
      return await api.get<IndicatorRuleSet>(API_ENDPOINTS.V2_ENGINE_INDICATOR_RULES.BY_STRATEGY(strategyName));
    } catch {
      return null; // Not found
    }
  },

  // Save indicator rules for a strategy
  async save(rules: IndicatorRuleSet): Promise<IndicatorRuleSet> {
    return api.post<IndicatorRuleSet>(API_ENDPOINTS.V2_ENGINE_INDICATOR_RULES.BASE, rules);
  },

  // Delete indicator rules for a strategy
  async delete(strategyName: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ENGINE_INDICATOR_RULES.BY_STRATEGY(strategyName));
  },
};

// ==================== BREAKOUT WATCHES (Monitoring) ====================

export interface BreakoutWatchFilters {
  username?: string;
  broker?: string;
  strategy?: string;
  includeAll?: boolean;
}

export const breakoutWatchService = {
  /**
   * Get all active breakout watches (or filtered list)
   */
  async getWatches(filters?: BreakoutWatchFilters): Promise<BreakoutWatch[]> {
    let url: string = API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.LIST;
    const params: Record<string, string> = {};

    if (filters?.username && filters?.broker) {
      url = API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_USER_BROKER(filters.username, filters.broker);
    } else if (filters?.username) {
      url = API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_USER(filters.username);
    } else if (filters?.strategy) {
      url = API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_STRATEGY(filters.strategy);
    }

    if (filters?.includeAll) {
      params.all = 'true';
    }

    return api.get<BreakoutWatch[]>(url, Object.keys(params).length > 0 ? params : undefined);
  },

  /**
   * Get breakout watch summary statistics
   */
  async getSummary(): Promise<BreakoutWatchSummary> {
    return api.get<BreakoutWatchSummary>(API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.SUMMARY);
  },

  /**
   * Get a specific breakout watch by ID
   */
  async getById(id: number): Promise<BreakoutWatch> {
    return api.get<BreakoutWatch>(API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.DETAILS(id));
  },

  /**
   * Get breakout watches for a specific user
   */
  async getByUser(username: string): Promise<BreakoutWatch[]> {
    return api.get<BreakoutWatch[]>(API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_USER(username));
  },

  /**
   * Get breakout watches for a specific user and broker
   * @param includeTriggered if true, includes today's triggered watches
   */
  async getByUserBroker(username: string, broker: string, includeTriggered = false): Promise<BreakoutWatch[]> {
    const params = includeTriggered ? { includeTriggered: 'true' } : undefined;
    return api.get<BreakoutWatch[]>(
      API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_USER_BROKER(username, broker),
      params
    );
  },

  /**
   * Get breakout watches for a specific strategy
   */
  async getByStrategy(strategy: string): Promise<BreakoutWatch[]> {
    return api.get<BreakoutWatch[]>(API_ENDPOINTS.V2_ENGINE_BREAKOUT_WATCHES.BY_STRATEGY(strategy));
  },
};

// ==================== STRATEGY CATALOG (admin-console filter dropdowns) ====================

/**
 * Minimal SYSTEM-scope strategy catalog (public + private) for admin-console filter dropdowns and
 * pickers — subscriptions, reports, analytics. Management-gated (admin/supervisor), not tied to
 * STRATEGY_DEFINITIONS, so a supervisor can populate strategy filters without that permission.
 * Returns a minimal projection (name + display + lot/risk only), never the full definition.
 */
export const strategyCatalogService = {
  async getOptions(): Promise<StrategyDefinition[]> {
    return api.get<StrategyDefinition[]>(API_ENDPOINTS.V2_STRATEGY_CATALOG.BASE);
  },
};

// ==================== UNIFIED SERVICE EXPORT ====================

export const strategyEngineService = {
  engine: engineControlService,
  templates: strategyTemplateService,
  definitions: strategyDefinitionService,
  definitionTransfer: strategyDefinitionTransferService,
  subscriptions: userSubscriptionService,
  schedules: tranchScheduleService,
  signals: externalSignalService,
  states: strategyStateService,
  indicatorRules: indicatorRulesService,
  hedgeReplace: hedgeReplaceService,
  breakoutWatches: breakoutWatchService,
};
