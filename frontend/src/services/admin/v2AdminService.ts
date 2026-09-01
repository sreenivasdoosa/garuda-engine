/**
 * V2 Admin Service
 * Comprehensive admin API service aligned with V2 servlets
 */

import apiClient, { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { PaginatedResponse } from '@/types/pagination';
import type {
  User,
  CreateUserRequest,
  UpdateUserRequest,
  UserBrokerConfig,
  CreateUserBrokerRequest,
  UpdateUserBrokerRequest,
} from '@/types/user_mgmt';
import type { AuditLog, AuditLogFilter, FAQ, CreateFAQRequest, AdminAnalytics } from '@/types/system';
import type {
  Exchange,
  CreateExchangeRequest,
  Holiday,
  EventDay,
  BrokerExchangeConfig,
  CreateBrokerExchangeConfigRequest,
} from '@/types/exchange';
import type {
  BillingPlan,
  CreateBillingPlanRequest,
  BrokeragePlan,
  CreateBrokeragePlanRequest,
  BrokeragePlanRate,
  CreateBrokeragePlanRateRequest,
  StatutoryCharges,
  StatutoryChargesBrokerOverride,
  CreateStatutoryChargesRequest,
  AllocationModel,
  CreateAllocationModelRequest,
  AllocationModelStrategy,
  AllocationModelDeletionImpact,
} from '@/types/billing';
import type {
  TradeFilter,
  EODPnlReport,
  EODPnlFilter,
  EODPnlResponse,
  CapitalChangeHistory,
  BrokerApiStat,
  PaginatedTradesResponse,
} from '@/types/reports';
import type { BrokerLoginStatus } from '@/types/broker';
import type { Product } from '@/types/product';

// Broker login response types
export interface BrokerLoginResponse {
  status: 'login_successful' | 'redirect_required' | 'already_logged_in';
  message?: string;
  loginUrl?: string;
  redirectUrl?: string;
  broker?: string;
}

export interface BrokerLoginStatusResponse {
  username: string;
  broker: string;
  isLoggedIn: boolean;
  clientID?: string;
}

export interface BrokerLogoutResponse {
  isLoggedOut: boolean;
  message?: string;
}

export interface AgentHealthResponse {
  username: string;
  broker: string;
  xtremeAgentUrl: string | null;
  configured: boolean;
  healthy: boolean;
  message: string;
  responseTimeMs?: number;
  statusCode?: number;
}

// Holiday creation request type
interface CreateHolidayRequest {
  exchange: string;
  date: string;
  name?: string;
  description?: string;
  fullDay?: boolean;
}

// ==================== USER MANAGEMENT ====================

export const userManagementService = {
  // Server-side paginated users list (admin Users table). Pushes search / role /
  // status into the backend so the table can survive 1K-10K users.
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    role?: string;
    status?: string;
    enabledOnly?: boolean;
  }): Promise<PaginatedResponse<User>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.role && params.role !== 'all') query.role = params.role;
    if (params.status && params.status !== 'all') query.status = params.status;
    if (params.enabledOnly) query.enabledOnly = true;
    return api.get<PaginatedResponse<User>>(API_ENDPOINTS.V2_USERS.LIST, query);
  },

  // Remote user search for typeahead dropdowns (min 2 chars enforced by the
  // caller). Returns just the page slice of matching users.
  async searchUsers(search: string, limit = 20): Promise<User[]> {
    const res = await userManagementService.getPaginated({ page: 1, pageSize: limit, search });
    return res.data;
  },

  // Get all users. The endpoint is now always paginated, so this unwraps the
  // envelope and requests the max page. It is retained for lookups / grouping
  // that genuinely need the visible set; dropdowns should use searchUsers()
  // (remote search) instead of loading every user.
  async getUsers(params?: { enabledOnly?: boolean }): Promise<User[]> {
    const res = await api.get<PaginatedResponse<User>>(API_ENDPOINTS.V2_USERS.LIST, {
      ...params,
      page: 1,
      pageSize: 500,
    });
    return res.data;
  },

  // Get user by username
  async getUser(username: string): Promise<User> {
    return api.get<User>(API_ENDPOINTS.V2_USERS.DETAILS(username));
  },

  // Create user
  async createUser(data: CreateUserRequest): Promise<User> {
    return api.post<User>(API_ENDPOINTS.V2_USERS.BASE, data);
  },

  // Update user
  async updateUser(username: string, data: UpdateUserRequest): Promise<User> {
    return api.put<User>(API_ENDPOINTS.V2_USERS.DETAILS(username), data);
  },

  // Activate user (set status to ACTIVE)
  async activateUser(username: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USERS.ACTIVATE(username), {});
  },

  // Suspend user (set status to SUSPENDED)
  async suspendUser(username: string, reason?: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USERS.SUSPEND(username), { reason });
  },

  // Close user account (set status to CLOSED)
  async closeUser(username: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USERS.CLOSE(username), {});
  },

  // Delete user
  async deleteUser(username: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_USERS.DETAILS(username));
  },

  // Set password for user (admin only)
  async setPassword(username: string, password: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USERS.SET_PASSWORD(username), { password });
  },
};

// ==================== USER BROKER MANAGEMENT ====================

export const userBrokerService = {
  // Get user's brokers
  async getUserBrokers(username: string): Promise<UserBrokerConfig[]> {
    return api.get<UserBrokerConfig[]>(API_ENDPOINTS.V2_USER_BROKERS.LIST(username));
  },

  // Server-side paginated flat list of user-brokers for the admin table.
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    broker?: string;
    status?: string;
    // 'yes' | 'no' — server-side AUTO_LOGIN filter (admin User Brokers table).
    autoLogin?: string;
    // Live-state filters (terminal). Server intersects with engine state before paginating.
    onlineOnly?: boolean;
    activeOnly?: boolean;
    // Server-side sort (terminal capital ranking). Only 'capital' is honoured server-side.
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
  }): Promise<PaginatedResponse<UserBrokerConfig>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.broker && params.broker !== 'all') query.broker = params.broker;
    if (params.status && params.status !== 'all') query.status = params.status;
    if (params.autoLogin && params.autoLogin !== 'all') query.autoLogin = params.autoLogin;
    if (params.onlineOnly) query.onlineOnly = true;
    if (params.activeOnly) query.activeOnly = true;
    if (params.sortBy) query.sortBy = params.sortBy;
    if (params.sortOrder) query.sortOrder = params.sortOrder;
    return api.get<PaginatedResponse<UserBrokerConfig>>(API_ENDPOINTS.V2_USER_BROKERS.LIST_ALL, query);
  },

  // Get specific broker config
  async getUserBroker(username: string, broker: string): Promise<UserBrokerConfig> {
    return api.get<UserBrokerConfig>(API_ENDPOINTS.V2_USER_BROKERS.DETAILS(username, broker));
  },

  // Add broker to user
  async addBrokerToUser(username: string, data: CreateUserBrokerRequest): Promise<UserBrokerConfig> {
    // Server expects username in the request body
    return api.post<UserBrokerConfig>(API_ENDPOINTS.V2_USER_BROKERS.LIST(username), { ...data, username });
  },

  // Update user broker
  async updateUserBroker(username: string, broker: string, data: UpdateUserBrokerRequest): Promise<UserBrokerConfig> {
    return api.put<UserBrokerConfig>(API_ENDPOINTS.V2_USER_BROKERS.DETAILS(username, broker), data);
  },

  // Enable user broker
  async enableUserBroker(username: string, broker: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.ENABLE(username, broker), {});
  },

  // Disable user broker
  async disableUserBroker(username: string, broker: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.DISABLE(username, broker), {});
  },

  // Assign seat to user broker (legacy)
  async assignSeat(username: string, broker: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.ASSIGN_SEAT(username, broker), {});
  },

  // Remove seat from user broker (legacy, auto-disables)
  async removeSeat(username: string, broker: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.REMOVE_SEAT(username, broker), {});
  },

  // Assign license key to user broker
  async assignLicense(username: string, broker: string, licenseKey: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.ASSIGN_LICENSE(username, broker), { licenseKey });
  },

  // Remove license from user broker
  async removeLicense(username: string, broker: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_BROKERS.REMOVE_LICENSE(username, broker), {});
  },

  // Remove broker from user
  async removeBrokerFromUser(username: string, broker: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_USER_BROKERS.DETAILS(username, broker));
  },

  // Auto login to broker
  async autoLogin(username: string, broker: string): Promise<BrokerLoginResponse> {
    return api.post<BrokerLoginResponse>(API_ENDPOINTS.V2_USER_BROKERS.LOGIN_AUTO(username, broker), {});
  },

  // Get broker login status
  async getLoginStatus(username: string, broker: string): Promise<BrokerLoginStatusResponse> {
    return api.get<BrokerLoginStatusResponse>(API_ENDPOINTS.V2_USER_BROKERS.LOGIN_STATUS(username, broker));
  },

  // Logout from broker
  async logout(username: string, broker: string): Promise<BrokerLogoutResponse> {
    return api.post<BrokerLogoutResponse>(API_ENDPOINTS.V2_USER_BROKERS.LOGOUT(username, broker), {});
  },

  // Check xtreme agent health
  async checkAgentHealth(username: string, broker: string): Promise<AgentHealthResponse> {
    return api.get<AgentHealthResponse>(API_ENDPOINTS.V2_USER_BROKERS.AGENT_HEALTH(username, broker));
  },
};

// ==================== USER CAPITAL ====================

interface CapitalRecord {
  username: string;
  broker: string;
  dateStr: string;
  capital: number;
}

export const userCapitalService = {
  // Get capital records
  async getCapitalRecords(params: {
    username?: string;
    broker?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<CapitalRecord[]> {
    return api.get<CapitalRecord[]>(API_ENDPOINTS.V2_USER_CAPITAL.BASE, params);
  },

  // Get a page of capital records. Filters + ordering are applied SERVER-SIDE,
  // returning the { data, pagination } envelope (the table was unbounded —
  // user × broker × day).
  async getCapitalRecordsPaginated(params: {
    fromDate: string;
    toDate: string;
    username?: string;
    broker?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResponse<CapitalRecord>> {
    const query: Record<string, unknown> = {
      fromDate: params.fromDate,
      toDate: params.toDate,
      page: params.page,
      pageSize: params.pageSize,
    };
    if (params.username) query.username = params.username;
    if (params.broker) query.broker = params.broker;
    return api.get(API_ENDPOINTS.V2_USER_CAPITAL.BASE, query);
  },

  // Create/update capital record
  async setCapital(data: { username: string; broker: string; date: string; capital: number }): Promise<CapitalRecord> {
    return api.post<CapitalRecord>(API_ENDPOINTS.V2_USER_CAPITAL.BASE, data);
  },
};

// ==================== RMS CONFIG (Hierarchical system) ====================

export type RMSConfigLevel = 'GLOBAL' | 'EXCHANGE' | 'SYMBOL' | 'BROKER' | 'USER';
export type RMSSegmentType = 'EQUITY' | 'FUTURES' | 'OPTIONS';

export interface RMSConfig {
  id?: number;
  configLevel: RMSConfigLevel;
  exchange?: string | null;      // Required for EXCHANGE level and below
  symbol?: string | null;        // Required for SYMBOL level - FnO underlying (NIFTY, BANKNIFTY)
  broker?: string | null;        // Required for BROKER level and USER level
  username?: string | null;      // Required for USER level only
  segmentType?: RMSSegmentType | null;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;

  // Price Validation
  stalePriceSeconds?: number | null;
  earlyMarketGraceSeconds?: number | null;
  minVolumeToday?: number | null;
  minVolumeEarlyMarket?: number | null;
  minVolumeEarlyPeriodSeconds?: number | null;
  minOpenInterest?: number | null;
  maxBidAskSpreadPct?: number | null;
  maxBidAskSpreadAbsolute?: number | null;
  bidAskAbsoluteThresholdPrice?: number | null;
  minDepthQuantity?: number | null;
  minDepthLevels?: number | null;
  enableFreakPriceCheck?: boolean | null;
  freakCheckMinPrice?: number | null;

  // Order Validation
  maxOrderQty?: number | null;
  maxOrderQtyLots?: number | null;
  maxOrderValue?: number | null;
  maxPriceDeviationPct?: number | null;
  maxPriceDeviationAbs?: number | null;
  maxOrdersPerSecond?: number | null;  // Broker rate limit (default 10/sec)
  maxOrderOperationsPerSecond?: number | null;  // Combined place/modify/cancel rate limit
  maxOrdersPerMinute?: number | null;
  maxOrdersPerDay?: number | null;
  enableFreezeQtyCheck?: boolean | null;
  skipPriceValidationForExit?: boolean | null;

  // Position Limits
  maxOrdersPerSymbolPerDay?: number | null;
  maxTotalPositions?: number | null;
  /** Cap on concurrently open multi-leg combos, counted by COMBO_ID from the engine's own trades. */
  maxTotalCombos?: number | null;
  maxBuyQtyPerSymbolPerDay?: number | null;
  maxSellQtyPerSymbolPerDay?: number | null;
  maxBuyOrdersPerDay?: number | null;
  maxSellOrdersPerDay?: number | null;
  maxPositionQtyPerSymbol?: number | null;

  // Loss Protection
  maxDailyLossAmount?: number | null;
  maxDailyLossPct?: number | null;
  enableAutoKillOnLoss?: boolean | null;
  autoSquareOffOnBreach?: boolean | null;

  // Circuit Breakers
  maxRejectionRatePct?: number | null;
  maxVixLevel?: number | null;
  volatilityPauseMinutes?: number | null;
}

export interface RMSBreachLog {
  id: number;
  breachTime: string;
  username: string;
  broker: string;
  strategyName?: string;
  tradingSymbol: string;
  exchange: string;
  breachType: string;
  breachCategory: string;
  breachDetails: string;
  actionTaken: string;
  currentValue: string;
  limitValue: string;
  severity: number;
}

export interface RMSBreachFilters {
  breachTypes: string[];
  categories: string[];
  typesByCategory: Record<string, string[]>;
}

/**
 * Maps RMSConfig field names to the config levels where they are applicable.
 * Fields not present in the map are applicable at ALL levels.
 */
export type RMSFieldApplicability = Record<string, string[]>;

export interface RMSUserState {
  id: number;
  username: string;
  broker: string;
  tradingDate: string;
  deployedCapital: number;
  usedMargin: number;
  availableMargin: number;
  peakMarginUsed: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  peakPnl: number;
  drawdown: number;
  totalPositions: number;
  grossExposure: number;
  netExposure: number;
  ordersToday: number;
  rejectionsToday: number;
  consecutiveLosses: number;
  isKilled: boolean;
  killReason?: string;
  killTime?: string;
}

export type KillSwitchLevel = 'GLOBAL' | 'EXCHANGE' | 'BROKER' | 'SYMBOL' | 'USER';

// Trigger source that created a kill switch. MANUAL is operator-created; the
// rest are auto-triggers with a Layer-2 arm/disarm flag.
export type KillSwitchSource = 'MANUAL' | 'DAILY_LOSS' | 'REJECTION_RATE' | 'VOLATILITY';

export interface KillSwitchEntry {
  key: string;
  level: KillSwitchLevel;
  exchange?: string;
  broker?: string;
  symbol?: string;
  username?: string;
  reason?: string;
  active: boolean;              // ACTIVE = firing/blocking, false = INACTIVE (off, still listed)
  source: KillSwitchSource;
  createdAt?: string;
  updatedAt?: string;
}

export interface KillSwitchActivateRequest {
  level: KillSwitchLevel;
  exchange?: string;
  broker?: string;
  symbol?: string;
  username?: string;
  reason?: string;
}

export interface KillSwitchStatus {
  activeKillSwitches: KillSwitchEntry[];   // all instances — ACTIVE and INACTIVE
  killedUsers: RMSUserState[];
  typeStates: Partial<Record<KillSwitchSource, boolean>>;  // Layer-2 per-type arm flags
}

export interface RMSServiceStatus {
  enabled: boolean;
  activeKillSwitchCount: number;
}

export interface RMSDailyStat {
  username: string;
  broker: string;
  tradingSymbol: string;
  statDate: string;
  orderCount: number;
  buyOrderCount: number;
  sellOrderCount: number;
  buyQty: number;
  sellQty: number;
}

export interface RMSDailyStatsResponse {
  stats: RMSDailyStat[];
  totalOrders: number;
  totalBuyOrders: number;
  totalSellOrders: number;
  uniqueSymbols: number;
  date: string;
}

export interface EffectiveRMSConfigResponse {
  config: RMSConfig;
  sources: Record<string, string>;
}

export const rmsConfigService = {
  // Get all configs
  async getAll(): Promise<RMSConfig[]> {
    return api.get<RMSConfig[]>(API_ENDPOINTS.V2_RMS_CONFIG.LIST);
  },

  // Get config by ID
  async getById(id: number): Promise<RMSConfig> {
    return api.get<RMSConfig>(API_ENDPOINTS.V2_RMS_CONFIG.DETAILS(id));
  },

  // Get configs by level
  async getByLevel(level: RMSConfigLevel): Promise<RMSConfig[]> {
    return api.get<RMSConfig[]>(API_ENDPOINTS.V2_RMS_CONFIG.BY_LEVEL(level));
  },

  // Get configs by segment type
  async getBySegment(segment: RMSSegmentType): Promise<RMSConfig[]> {
    return api.get<RMSConfig[]>(API_ENDPOINTS.V2_RMS_CONFIG.BY_SEGMENT(segment));
  },

  // Create config
  async create(data: Omit<RMSConfig, 'id'>): Promise<RMSConfig> {
    return api.post<RMSConfig>(API_ENDPOINTS.V2_RMS_CONFIG.BASE, data);
  },

  // Update config
  async update(id: number, data: Partial<RMSConfig>): Promise<RMSConfig> {
    return api.put<RMSConfig>(API_ENDPOINTS.V2_RMS_CONFIG.DETAILS(id), data);
  },

  // Delete config
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_RMS_CONFIG.DETAILS(id));
  },

  // Get recent breaches (full array — legacy).
  async getBreaches(params?: { username?: string; type?: string; limit?: number; startDate?: string; endDate?: string }): Promise<RMSBreachLog[]> {
    return api.get<RMSBreachLog[]>(API_ENDPOINTS.V2_RMS_CONFIG.BREACHES, params);
  },

  // Get a page of breaches. search / severity / category move SERVER-SIDE (were
  // client-side over a capped set), and the { highSeverity, uniqueUsers } stat
  // cards are computed over the WHOLE filtered set, not the page.
  async getBreachesPaginated(params: {
    page: number;
    pageSize: number;
    username?: string;
    type?: string;
    startDate?: string;
    endDate?: string;
    search?: string;
    severity?: string;
    category?: string;
  }): Promise<PaginatedResponse<RMSBreachLog> & { summary: { highSeverity: number; uniqueUsers: number } }> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.username) query.username = params.username;
    if (params.type) query.type = params.type;
    if (params.startDate) query.startDate = params.startDate;
    if (params.endDate) query.endDate = params.endDate;
    if (params.search) query.search = params.search;
    if (params.severity) query.severity = params.severity;
    if (params.category) query.category = params.category;
    return api.get(API_ENDPOINTS.V2_RMS_CONFIG.BREACHES, query);
  },

  // Get today's breaches
  async getTodayBreaches(): Promise<RMSBreachLog[]> {
    return api.get<RMSBreachLog[]>(API_ENDPOINTS.V2_RMS_CONFIG.BREACHES_TODAY);
  },

  // Get breach filter options (types and categories from backend enum)
  async getBreachFilters(): Promise<RMSBreachFilters> {
    return api.get<RMSBreachFilters>(API_ENDPOINTS.V2_RMS_CONFIG.BREACH_FILTERS);
  },

  // Get field-level applicability (which fields are valid at which config levels)
  async getFieldApplicability(): Promise<RMSFieldApplicability> {
    return api.get<RMSFieldApplicability>(API_ENDPOINTS.V2_RMS_CONFIG.FIELD_APPLICABILITY);
  },

  // Get user states for today
  async getUserStates(): Promise<RMSUserState[]> {
    return api.get<RMSUserState[]>(API_ENDPOINTS.V2_RMS_CONFIG.USER_STATES);
  },

  // Get kill switch status
  async getKillSwitchStatus(): Promise<KillSwitchStatus> {
    return api.get<KillSwitchStatus>(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH);
  },

  // Activate kill switch (multi-level, JSON body)
  async activateKillSwitch(request: KillSwitchActivateRequest): Promise<{ level: string; activated: boolean; reason: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH, request);
  },

  // Activate kill switch for single user-broker (backward compat)
  async activateKillSwitchUser(username: string, broker: string, reason?: string): Promise<{ username: string; broker: string; activated: boolean; reason?: string }> {
    const params = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_USER(username, broker) + params, {});
  },

  // Deactivate kill switches (batch, by keys)
  async deactivateKillSwitches(keys: string[]): Promise<{ deactivated: string[] }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_DEACTIVATE, { keys });
  },

  // Deactivate kill switch for single user-broker (backward compat)
  async deactivateKillSwitch(username: string, broker: string): Promise<{ username: string; broker: string; activated: boolean }> {
    return api.delete(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_USER(username, broker));
  },

  // Remove kill switch instances entirely (batch) — deletes them; re-arms auto-triggers
  async removeKillSwitches(keys: string[]): Promise<{ removed: string[] }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_REMOVE, { keys });
  },

  // Remove every kill switch instance (ACTIVE and INACTIVE)
  async removeAllKillSwitches(): Promise<{ message: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_REMOVE_ALL, {});
  },

  // Arm/disarm an auto-trigger type (Layer 2). When disabling, alsoRemoveInstances
  // optionally deletes that type's existing kill-switch instances.
  async setKillSwitchType(
    source: KillSwitchSource,
    enabled: boolean,
    alsoRemoveInstances: boolean,
  ): Promise<{ source: string; enabled: boolean; instancesRemoved: boolean }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.KILL_SWITCH_TYPE, { source, enabled, alsoRemoveInstances });
  },

  // Stop broker
  async stopBroker(broker: string): Promise<{ broker: string; stopped: boolean }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.STOP_BROKER(broker), {});
  },

  // Unstop broker
  async unstopBroker(broker: string): Promise<{ broker: string; stopped: boolean }> {
    return api.delete(API_ENDPOINTS.V2_RMS_CONFIG.STOP_BROKER(broker));
  },

  // Get RMS service status
  async getStatus(): Promise<RMSServiceStatus> {
    return api.get<RMSServiceStatus>(API_ENDPOINTS.V2_RMS_CONFIG.STATUS);
  },

  // Enable RMS service
  async enable(): Promise<{ message: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.ENABLE, {});
  },

  // Disable RMS service
  async disable(): Promise<{ message: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.DISABLE, {});
  },

  // Reset daily state
  async resetDailyState(): Promise<{ message: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.RESET_DAILY, {});
  },

  // Clear config cache
  async clearCache(): Promise<{ message: string }> {
    return api.post(API_ENDPOINTS.V2_RMS_CONFIG.CLEAR_CACHE, {});
  },

  // Get daily stats
  async getDailyStats(params?: { date?: string; username?: string; broker?: string }): Promise<RMSDailyStatsResponse> {
    return api.get<RMSDailyStatsResponse>(API_ENDPOINTS.V2_RMS_CONFIG.DAILY_STATS, params);
  },

  // Get effective config with source tracking (for preview)
  async getEffective(params: {
    segmentType: string;
    exchange?: string;
    symbol?: string;
    broker?: string;
    username?: string;
  }): Promise<EffectiveRMSConfigResponse> {
    return api.get<EffectiveRMSConfigResponse>(API_ENDPOINTS.V2_RMS_CONFIG.EFFECTIVE, params);
  },

  // Export all GLOBAL/EXCHANGE/SYMBOL configs as xlsx
  async exportConfigs(): Promise<Blob> {
    const response = await apiClient.post(API_ENDPOINTS.V2_RMS_CONFIG.EXPORT, {}, {
      responseType: 'blob',
    });
    return response as unknown as Blob;
  },

  // Preview import from xlsx
  async importPreview(file: File): Promise<RMSConfigImportPreviewResult> {
    const formData = new FormData();
    formData.append('file', file);
    return apiClient.post(API_ENDPOINTS.V2_RMS_CONFIG.IMPORT_PREVIEW, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },

  // Apply import with conflict resolutions
  async importApply(
    file: File,
    resolutions: Record<string, 'OVERRIDE' | 'SKIP'>,
    defaultResolution: 'OVERRIDE' | 'SKIP' = 'SKIP'
  ): Promise<RMSConfigImportApplyResult> {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('resolutions', JSON.stringify(resolutions));
    formData.append('defaultResolution', defaultResolution);
    return apiClient.post(API_ENDPOINTS.V2_RMS_CONFIG.IMPORT_APPLY, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  },
};

export interface RMSConfigImportPreviewResult {
  newConfigs: string[];
  conflictingConfigs: string[];
  conflictingConfigIds: number[];
  totalConfigs: number;
  warnings: string[];
  errors: string[];
}

export interface RMSConfigImportApplyResult {
  imported: number;
  overridden: number;
  skipped: number;
  errors: string[];
}

// ==================== AUDIT LOGS ====================

export const auditLogService = {
  // Get a page of audit logs. The list endpoint is server-paginated and returns
  // the standard `{ data, pagination }` envelope; filters + free-text search are
  // applied SERVER-SIDE across the whole set, so the page and its totalCount are
  // exact (not capped at 100 or filtered after the fact on the client).
  async getPaginated(filter?: AuditLogFilter): Promise<PaginatedResponse<AuditLog>> {
    return api.get<PaginatedResponse<AuditLog>>(API_ENDPOINTS.V2_AUDIT_LOGS.LIST, filter);
  },

  // Get audit logs (unwraps the paginated envelope to the page's rows). Retained
  // for array callers; paginated UIs should use getPaginated() for the totalCount.
  async getLogs(filter?: AuditLogFilter): Promise<AuditLog[]> {
    const res = await api.get<PaginatedResponse<AuditLog>>(API_ENDPOINTS.V2_AUDIT_LOGS.LIST, filter);
    return res.data;
  },

  // Get all entity types
  async getEntityTypes(): Promise<string[]> {
    return api.get<string[]>(API_ENDPOINTS.V2_AUDIT_LOGS.ENTITY_TYPES);
  },

  // Get logs by entity
  async getLogsByEntity(entityType: string, entityId: string): Promise<AuditLog[]> {
    return api.get<AuditLog[]>(API_ENDPOINTS.V2_AUDIT_LOGS.BY_ENTITY(entityType, entityId));
  },

  // Get logs by user
  async getLogsByUser(username: string): Promise<AuditLog[]> {
    return api.get<AuditLog[]>(API_ENDPOINTS.V2_AUDIT_LOGS.BY_USER(username));
  },
};

// ==================== EXCHANGES ====================

export interface ExchangeMarketStatus {
  exchange: string;
  isActive: boolean;
  isMarketOpen: boolean;
}

export const exchangeService = {
  // Get all exchanges
  async getAll(): Promise<Exchange[]> {
    return api.get<Exchange[]>(API_ENDPOINTS.V2_EXCHANGES.LIST);
  },

  // Live per-exchange market status (authoritative server-side timing) — for gating
  // market-dependent UI actions (e.g. terminal square-off) on real state, not a client guess.
  async getMarketStatus(): Promise<ExchangeMarketStatus[]> {
    return api.get<ExchangeMarketStatus[]>(API_ENDPOINTS.V2_EXCHANGES.MARKET_STATUS);
  },

  // Get exchange by code
  async getByCode(code: string): Promise<Exchange> {
    return api.get<Exchange>(API_ENDPOINTS.V2_EXCHANGES.DETAILS(code));
  },

  // Create exchange
  async create(data: CreateExchangeRequest): Promise<Exchange> {
    return api.post<Exchange>(API_ENDPOINTS.V2_EXCHANGES.BASE, data);
  },

  // Update exchange
  async update(code: string, data: Partial<CreateExchangeRequest>): Promise<Exchange> {
    return api.put<Exchange>(API_ENDPOINTS.V2_EXCHANGES.DETAILS(code), data);
  },

  // Delete exchange
  async delete(code: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_EXCHANGES.DETAILS(code));
  },

  // Get holidays
  async getHolidays(code: string): Promise<Holiday[]> {
    return api.get<Holiday[]>(API_ENDPOINTS.V2_EXCHANGES.HOLIDAYS(code));
  },

  // Get event days
  async getEventDays(code: string): Promise<EventDay[]> {
    return api.get<EventDay[]>(API_ENDPOINTS.V2_EXCHANGES.EVENT_DAYS(code));
  },
};

// ==================== HOLIDAYS ====================

export const holidayService = {
  // Get holidays by exchange (returns array of Holiday objects with description)
  async getByExchange(exchange: string): Promise<Holiday[]> {
    return api.get<Holiday[]>(API_ENDPOINTS.V2_HOLIDAYS.BY_EXCHANGE(exchange));
  },

  // Add holiday
  async create(data: CreateHolidayRequest): Promise<Holiday> {
    return api.post<Holiday>(API_ENDPOINTS.V2_HOLIDAYS.BASE, data);
  },

  // Update holiday description
  async update(exchange: string, date: string, data: { description?: string }): Promise<Holiday> {
    return api.put<Holiday>(API_ENDPOINTS.V2_HOLIDAYS.DELETE(exchange, date), data);
  },

  // Delete holiday
  async delete(exchange: string, date: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_HOLIDAYS.DELETE(exchange, date));
  },
};

// ==================== MARKET DATA SYNC ====================

export interface MarketDataSyncStatus {
  running: boolean;
}

export interface MarketDataSyncTriggerResponse {
  message: string;
  triggeredBy: string;
}

export const marketDataSyncService = {
  // Get sync service status
  async getStatus(): Promise<MarketDataSyncStatus> {
    return api.get<MarketDataSyncStatus>(API_ENDPOINTS.V2_MARKET_DATA_SYNC.STATUS);
  },

  // Trigger sync
  async triggerSync(): Promise<MarketDataSyncTriggerResponse> {
    return api.post<MarketDataSyncTriggerResponse>(API_ENDPOINTS.V2_MARKET_DATA_SYNC.TRIGGER, {});
  },
};

// ==================== EVENT DAYS ====================

export interface CreateEventDayRequest {
  eventDate: string;
  eventName: string;
  capitalPercentage: number;
}

export interface UpdateEventDayRequest {
  eventName?: string;
  capitalPercentage?: number;
}

export const eventDayService = {
  // Get event days by exchange
  async getByExchange(exchange: string): Promise<EventDay[]> {
    return api.get<EventDay[]>(API_ENDPOINTS.V2_EVENT_DAYS.BY_EXCHANGE(exchange));
  },

  // Get specific event day
  async get(exchange: string, eventDate: string): Promise<EventDay> {
    return api.get<EventDay>(API_ENDPOINTS.V2_EVENT_DAYS.DETAILS(exchange, eventDate));
  },

  // Create event day
  async create(exchange: string, data: CreateEventDayRequest): Promise<EventDay> {
    return api.post<EventDay>(API_ENDPOINTS.V2_EVENT_DAYS.BY_EXCHANGE(exchange), data);
  },

  // Update event day
  async update(exchange: string, eventDate: string, data: UpdateEventDayRequest): Promise<EventDay> {
    return api.put<EventDay>(API_ENDPOINTS.V2_EVENT_DAYS.DETAILS(exchange, eventDate), data);
  },

  // Delete event day
  async delete(exchange: string, eventDate: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_EVENT_DAYS.DETAILS(exchange, eventDate));
  },
};

// ==================== SPECIAL TRADING DAYS (read-only) ====================

export interface SpecialTradingDay {
  exchange: string;
  tradingDate: string;
  tradingDayName: string;
  marketOpen?: string;   // optional, "HH:mm" format for partial holidays
  marketClose?: string;  // optional, "HH:mm" format for partial holidays
}

export interface MockTradingDay {
  exchange: string;
  tradingDate: string;
  sessionStart: string;  // "HH:mm:ss"
  sessionEnd: string;    // "HH:mm:ss"
  description?: string | null;
}

export const mockTradingDayService = {
  // Get all mock trading days (read-only; entries are managed in the
  // market-data admin UI -> Mock Trading Days)
  async getAll(): Promise<MockTradingDay[]> {
    return api.get<MockTradingDay[]>(API_ENDPOINTS.V2_MOCK_TRADING_DAYS.ALL);
  },

  // Get mock trading days for one exchange
  async getByExchange(exchange: string): Promise<MockTradingDay[]> {
    return api.get<MockTradingDay[]>(API_ENDPOINTS.V2_MOCK_TRADING_DAYS.BY_EXCHANGE(exchange));
  },
};

export const specialTradingDayService = {
  // Get all special trading days
  async getAll(): Promise<SpecialTradingDay[]> {
    return api.get<SpecialTradingDay[]>(API_ENDPOINTS.V2_SPECIAL_TRADING_DAYS.ALL);
  },

  // Get special trading days by exchange
  async getByExchange(exchange: string): Promise<SpecialTradingDay[]> {
    return api.get<SpecialTradingDay[]>(API_ENDPOINTS.V2_SPECIAL_TRADING_DAYS.BY_EXCHANGE(exchange));
  },

  // Create special trading day
  async create(data: SpecialTradingDay): Promise<SpecialTradingDay> {
    return api.post<SpecialTradingDay>(API_ENDPOINTS.V2_SPECIAL_TRADING_DAYS.ALL, data);
  },

  // Update special trading day
  async update(exchange: string, date: string, data: { tradingDayName?: string; marketOpen?: string; marketClose?: string }): Promise<SpecialTradingDay> {
    return api.put<SpecialTradingDay>(API_ENDPOINTS.V2_SPECIAL_TRADING_DAYS.DETAILS(exchange, date), data);
  },

  // Delete special trading day
  async delete(exchange: string, date: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_SPECIAL_TRADING_DAYS.DETAILS(exchange, date));
  },
};

// ==================== DATA PROVIDERS ====================

export interface DataProviderStatus {
  name: string;
  configured: boolean;
  loggedIn: boolean | null;
  active: boolean;
  manualLoginDone: boolean | null;
  loginType: 'sso' | 'api' | 'auto' | 'none';
}

export const dataProviderService = {
  async getStatus(): Promise<DataProviderStatus[]> {
    return api.get<DataProviderStatus[]>(API_ENDPOINTS.MARKET_DATA.PROVIDERS_STATUS);
  },
  async getZerodhaLoginUrl(): Promise<{ url: string }> {
    return api.get<{ url: string }>(API_ENDPOINTS.MARKET_DATA.PROVIDERS_ZERODHA_LOGIN_URL);
  },
  async loginXts(): Promise<{ success: boolean; message: string }> {
    return api.post<{ success: boolean; message: string }>(API_ENDPOINTS.MARKET_DATA.PROVIDERS_XTS_LOGIN, {});
  },
};

// ==================== BROKER EXCHANGE CONFIG ====================

export const brokerExchangeConfigService = {
  // Get all configs
  async getAll(): Promise<BrokerExchangeConfig[]> {
    return api.get<BrokerExchangeConfig[]>(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.LIST);
  },

  // Get by broker
  async getByBroker(brokerName: string): Promise<BrokerExchangeConfig[]> {
    return api.get<BrokerExchangeConfig[]>(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.BY_BROKER(brokerName));
  },

  // Get specific config
  async get(brokerName: string, exchangeCode: string): Promise<BrokerExchangeConfig> {
    return api.get<BrokerExchangeConfig>(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.DETAILS(brokerName, exchangeCode));
  },

  // Create config
  async create(data: CreateBrokerExchangeConfigRequest): Promise<BrokerExchangeConfig> {
    return api.post<BrokerExchangeConfig>(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.BASE, data);
  },

  // Update config
  async update(brokerName: string, exchangeCode: string, data: Partial<CreateBrokerExchangeConfigRequest>): Promise<BrokerExchangeConfig> {
    return api.put<BrokerExchangeConfig>(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.DETAILS(brokerName, exchangeCode), data);
  },

  // Delete config
  async delete(brokerName: string, exchangeCode: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BROKER_EXCHANGE_CONFIGS.DETAILS(brokerName, exchangeCode));
  },
};

// ==================== BILLING PLANS ====================

export const billingPlanService = {
  // Get all plans
  async getAll(): Promise<BillingPlan[]> {
    return api.get<BillingPlan[]>(API_ENDPOINTS.V2_BILLING_PLANS.LIST);
  },

  // Get plan by name
  async getByName(name: string): Promise<BillingPlan> {
    return api.get<BillingPlan>(API_ENDPOINTS.V2_BILLING_PLANS.DETAILS(name));
  },

  // Create plan
  async create(data: CreateBillingPlanRequest): Promise<BillingPlan> {
    return api.post<BillingPlan>(API_ENDPOINTS.V2_BILLING_PLANS.BASE, data);
  },

  // Update plan
  async update(name: string, data: Partial<CreateBillingPlanRequest>): Promise<BillingPlan> {
    return api.put<BillingPlan>(API_ENDPOINTS.V2_BILLING_PLANS.DETAILS(name), data);
  },

  // Delete plan
  async delete(name: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BILLING_PLANS.DETAILS(name));
  },
};

// ==================== BROKERAGE PLANS ====================

export const brokeragePlanService = {
  // Get all plans
  async getAll(): Promise<BrokeragePlan[]> {
    return api.get<BrokeragePlan[]>(API_ENDPOINTS.V2_BROKERAGE_PLANS.LIST);
  },

  // Get plan by name
  async getByName(name: string): Promise<BrokeragePlan> {
    return api.get<BrokeragePlan>(API_ENDPOINTS.V2_BROKERAGE_PLANS.DETAILS(name));
  },

  // Create plan
  async create(data: CreateBrokeragePlanRequest): Promise<BrokeragePlan> {
    return api.post<BrokeragePlan>(API_ENDPOINTS.V2_BROKERAGE_PLANS.BASE, data);
  },

  // Update plan
  async update(name: string, data: Partial<CreateBrokeragePlanRequest>): Promise<BrokeragePlan> {
    return api.put<BrokeragePlan>(API_ENDPOINTS.V2_BROKERAGE_PLANS.DETAILS(name), data);
  },

  // Delete plan
  async delete(name: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BROKERAGE_PLANS.DETAILS(name));
  },
};

// ==================== BROKERAGE PLAN RATES ====================

export const brokeragePlanRateService = {
  // Get all rates
  async getAll(): Promise<BrokeragePlanRate[]> {
    return api.get<BrokeragePlanRate[]>(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.LIST);
  },

  // Get rates for a specific plan
  async getByPlan(planName: string): Promise<BrokeragePlanRate[]> {
    return api.get<BrokeragePlanRate[]>(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.BY_PLAN(planName));
  },

  // Get specific rate
  async get(planName: string, segment: string, product: string): Promise<BrokeragePlanRate> {
    return api.get<BrokeragePlanRate>(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.DETAILS(planName, segment, product));
  },

  // Create new rate
  async create(data: CreateBrokeragePlanRateRequest): Promise<BrokeragePlanRate> {
    return api.post<BrokeragePlanRate>(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.BASE, data);
  },

  // Update rate
  async update(planName: string, segment: string, product: string, data: Partial<CreateBrokeragePlanRateRequest>): Promise<BrokeragePlanRate> {
    return api.put<BrokeragePlanRate>(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.DETAILS(planName, segment, product), data);
  },

  // Delete rate
  async delete(planName: string, segment: string, product: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BROKERAGE_PLAN_RATES.DETAILS(planName, segment, product));
  },
};

// ==================== STATUTORY CHARGES ====================

export const statutoryChargesService = {
  // Get all statutory charges
  async getAll(): Promise<StatutoryCharges[]> {
    return api.get<StatutoryCharges[]>(API_ENDPOINTS.V2_STATUTORY_CHARGES.LIST);
  },

  // Get specific charge entry
  async get(exchange: string, segment: string, product: string): Promise<StatutoryCharges> {
    return api.get<StatutoryCharges>(API_ENDPOINTS.V2_STATUTORY_CHARGES.DETAILS(exchange, segment, product));
  },

  // Create new charge entry
  async create(data: CreateStatutoryChargesRequest): Promise<StatutoryCharges> {
    return api.post<StatutoryCharges>(API_ENDPOINTS.V2_STATUTORY_CHARGES.BASE, data);
  },

  // Update charge entry
  async update(exchange: string, segment: string, product: string, data: Partial<CreateStatutoryChargesRequest>): Promise<StatutoryCharges> {
    return api.put<StatutoryCharges>(API_ENDPOINTS.V2_STATUTORY_CHARGES.DETAILS(exchange, segment, product), data);
  },

  // Delete charge entry
  async delete(exchange: string, segment: string, product: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_STATUTORY_CHARGES.DETAILS(exchange, segment, product));
  },

  // ---- Per-broker sparse overrides (null field = inherit the default) ----
  async getOverrides(): Promise<StatutoryChargesBrokerOverride[]> {
    return api.get<StatutoryChargesBrokerOverride[]>(API_ENDPOINTS.V2_STATUTORY_CHARGES.OVERRIDES);
  },

  async upsertOverride(data: StatutoryChargesBrokerOverride): Promise<StatutoryChargesBrokerOverride> {
    return api.put<StatutoryChargesBrokerOverride>(API_ENDPOINTS.V2_STATUTORY_CHARGES.OVERRIDES, data);
  },

  async deleteOverride(broker: string, exchange: string, segment: string, product: string): Promise<void> {
    return api.delete(API_ENDPOINTS.V2_STATUTORY_CHARGES.OVERRIDE_DETAILS(broker, exchange, segment, product));
  },
};

// ==================== ALLOCATION MODELS ====================

export const allocationModelService = {
  // Get all models
  async getAll(): Promise<AllocationModel[]> {
    return api.get<AllocationModel[]>(API_ENDPOINTS.V2_ALLOCATION_MODELS.LIST);
  },

  // Get model by name
  async getByName(name: string): Promise<AllocationModel> {
    return api.get<AllocationModel>(API_ENDPOINTS.V2_ALLOCATION_MODELS.DETAILS(name));
  },

  // Get model strategies
  async getStrategies(name: string): Promise<AllocationModelStrategy[]> {
    return api.get<AllocationModelStrategy[]>(API_ENDPOINTS.V2_ALLOCATION_MODELS.STRATEGIES(name));
  },

  // Create model
  async create(data: CreateAllocationModelRequest): Promise<AllocationModel> {
    return api.post<AllocationModel>(API_ENDPOINTS.V2_ALLOCATION_MODELS.BASE, data);
  },

  // Update model
  async update(name: string, data: Partial<CreateAllocationModelRequest>): Promise<AllocationModel> {
    return api.put<AllocationModel>(API_ENDPOINTS.V2_ALLOCATION_MODELS.DETAILS(name), data);
  },

  // Delete model
  async delete(name: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ALLOCATION_MODELS.DETAILS(name));
  },

  // Rename model — re-points all references atomically on the server
  async rename(name: string, newName: string): Promise<AllocationModel> {
    return api.post<AllocationModel>(API_ENDPOINTS.V2_ALLOCATION_MODELS.RENAME(name), { newName });
  },

  // Get deletion impact preview
  async getDeletionImpact(name: string): Promise<AllocationModelDeletionImpact> {
    return api.get<AllocationModelDeletionImpact>(API_ENDPOINTS.V2_ALLOCATION_MODELS.DELETION_IMPACT(name));
  },

  // Add strategy to model
  async addStrategy(name: string, data: Omit<AllocationModelStrategy, 'allocationModel'>): Promise<AllocationModelStrategy> {
    return api.post<AllocationModelStrategy>(API_ENDPOINTS.V2_ALLOCATION_MODELS.STRATEGIES(name), data);
  },

  // Update strategy mapping
  async updateStrategy(name: string, strategy: string, data: Partial<AllocationModelStrategy>): Promise<AllocationModelStrategy> {
    return api.put<AllocationModelStrategy>(API_ENDPOINTS.V2_ALLOCATION_MODELS.STRATEGY_DETAILS(name, strategy), data);
  },

  // Remove strategy from model
  async removeStrategy(name: string, strategy: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_ALLOCATION_MODELS.STRATEGY_DETAILS(name, strategy));
  },

  // Sync all associated user+brokers' subscriptions to this model (scaled by each
  // user's capital). Server-side equivalent of the "apply to strategies" bulk edit.
  async syncUserAllocations(name: string): Promise<AllocationSyncResult> {
    return api.post<AllocationSyncResult>(API_ENDPOINTS.V2_ALLOCATION_MODELS.SYNC_USER_ALLOCATIONS(name), {});
  },
};

export interface AllocationSyncResult {
  modelName: string;
  userBrokersAssociated: number;
  usersUpdated: number;
  subscriptionsAdded: number;
  subscriptionsUpdated: number;
  subscriptionsDeleted: number;
  errors: string[];
  message: string;
}

// ==================== FAQ ====================

export const faqService = {
  // Get all FAQs (optionally filtered by category - currently returns all)
  async getAll(category?: string): Promise<FAQ[]> {
    const params = category ? { category } : undefined;
    return api.get<FAQ[]>(API_ENDPOINTS.V2_FAQS.LIST, params);
  },

  // Get specific FAQ by SNO
  async getBySno(sno: number): Promise<FAQ> {
    return api.get<FAQ>(API_ENDPOINTS.V2_FAQS.DETAILS(sno));
  },

  // Search FAQs
  async search(term: string): Promise<FAQ[]> {
    return api.get<FAQ[]>(API_ENDPOINTS.V2_FAQS.SEARCH(term));
  },

  // Create FAQ
  async create(data: CreateFAQRequest): Promise<FAQ> {
    return api.post<FAQ>(API_ENDPOINTS.V2_FAQS.BASE, data);
  },

  // Update FAQ
  async update(sno: number, data: CreateFAQRequest): Promise<FAQ> {
    return api.put<FAQ>(API_ENDPOINTS.V2_FAQS.DETAILS(sno), data);
  },

  // Delete FAQ
  async delete(sno: number): Promise<void> {
    return api.delete(API_ENDPOINTS.V2_FAQS.DETAILS(sno));
  },
};

// ==================== TRADES ====================

export interface RecomputeChargeFlag {
  username: string;
  broker: string;
  tradingSymbol: string;
  product: string;
  date: string;
  filledQuantity: number;
  quantityPerLot: number;
  reason: 'LOT_SIZE_MISSING' | 'FRACTIONAL_LOTS';
}

export interface RecomputeUserSummary {
  username: string;
  tradesChanged: number;
  oldCharges: number;
  newCharges: number;
  oldNetPnl: number;
  newNetPnl: number;
}

export interface RecomputeChargesResult {
  dryRun: boolean;
  fromDate: string;
  toDate: string;
  usersProcessed: number;
  tradesScanned: number;
  tradesChanged: number;
  lotSizeMissingCount: number;
  fractionalLotCount: number;
  oldChargesTotal: number;
  newChargesTotal: number;
  oldBrokerageTotal: number;
  newBrokerageTotal: number;
  oldGstTotal: number;
  newGstTotal: number;
  oldNetPnlTotal: number;
  newNetPnlTotal: number;
  eodRecordsAffected: number;
  eodChargesDelta: number;
  eodNetPnlDelta: number;
  perUser: RecomputeUserSummary[];
  flags: RecomputeChargeFlag[];
}

export interface RecomputeStartResponse {
  started: boolean;
  jobId: string;
  dryRun: boolean;
  statusUrl: string;
}

export interface RecomputeJob {
  jobId: string;
  state: 'RUNNING' | 'COMPLETED' | 'FAILED';
  dryRun: boolean;
  fromDate: string;
  toDate: string;
  userScope: number | null;
  startedAtMillis: number;
  finishedAtMillis: number;
  error?: string;
  result: RecomputeChargesResult;
}

export interface RecomputeStatus {
  running: boolean;
  job: RecomputeJob | null;
}

// ---- Positional daily-MTM recompute (broker-basis) ----
export interface PositionalMtmUserSummary {
  username: string;
  tradesLive: number;
  sliceDays: number;
  gross: number;
  charges: number;
  net: number;
  zeroGross: number; // broker premium-flow (mark-to-zero) preview
  zeroNet: number;
}

export interface PositionalMtmRecomputeResult {
  dryRun: boolean;
  fromDate: string;
  toDate: string;
  usersProcessed: number;
  tradesScanned: number;
  sliceDaysComputed: number;
  eodRecordsAffected: number;
  missingCloseCount: number;
  grossTotal: number;
  chargesTotal: number;
  netTotal: number;
  zeroGrossTotal: number; // broker premium-flow (mark-to-zero) preview totals
  zeroNetTotal: number;
  perUser: PositionalMtmUserSummary[];
  missingCloses: string[]; // "EXCHANGE:SYMBOL@date" to backfill (capped)
}

export interface PositionalMtmRecomputeJob {
  jobId: string;
  state: 'RUNNING' | 'COMPLETED' | 'FAILED';
  dryRun: boolean;
  fromDate: string;
  toDate: string;
  userScope: number | null;
  startedAtMillis: number;
  finishedAtMillis: number;
  error?: string;
  result: PositionalMtmRecomputeResult;
}

export interface PositionalMtmRecomputeStatus {
  running: boolean;
  job: PositionalMtmRecomputeJob | null;
}

export const tradeService = {
  // Get trades with pagination. Since V306 all products share one TRADES table, so the path segment
  // is a plain PRODUCT row filter: intraday | positional | cashbuy | mtf | all (anything else → 400).
  async getTrades(filter?: TradeFilter): Promise<PaginatedTradesResponse> {
    const type = filter?.tradeType?.toLowerCase() || 'intraday';
    return api.get<PaginatedTradesResponse>(API_ENDPOINTS.V2_TRADES.BY_TYPE(type), filter);
  },

  // Sysadmin: start a recompute of brokerage/GST/charges/net-P&L for COMPLETED intraday+positional
  // trades in a date range, using each user-broker's assigned plan + the lot size stored on the trade.
  // dryRun = preview deltas (no writes); real run persists + regenerates EOD reports. usernames =
  // null/empty → all users. Runs in the BACKGROUND (one at a time) — poll getRecomputeStatus().
  // Throws (409) if a recompute is already running.
  async recomputeCharges(params: {
    usernames: string[] | null;
    fromDate: string;
    toDate: string;
    dryRun: boolean;
  }): Promise<RecomputeStartResponse> {
    return api.post<RecomputeStartResponse>(API_ENDPOINTS.V2_TRADES.RECOMPUTE_CHARGES, params);
  },

  // Current/last recompute job — result live-updates while RUNNING, final on COMPLETED.
  async getRecomputeStatus(): Promise<RecomputeStatus> {
    return api.get<RecomputeStatus>(API_ENDPOINTS.V2_TRADES.RECOMPUTE_CHARGES_STATUS);
  },
};

// ==================== POSITIONAL DAILY-MTM RECOMPUTE ====================

export const positionalMtmService = {
  // Sysadmin: rebuild the broker-basis positional daily-MTM report over a date range from stored
  // TRADES rows filtered to PRODUCT = POSITIONAL + captured closes. dryRun = preview (no writes) + missing-close list; real run
  // writes granular + aggregated rows. usernames null/empty → all. Background (one at a time); poll
  // getStatus(). Throws (409) if one is already running.
  async recompute(params: {
    usernames: string[] | null;
    fromDate: string;
    toDate: string;
    dryRun: boolean;
  }): Promise<RecomputeStartResponse> {
    return api.post<RecomputeStartResponse>(API_ENDPOINTS.V2_POSITIONAL_MTM.RECOMPUTE, params);
  },

  async getStatus(): Promise<PositionalMtmRecomputeStatus> {
    return api.get<PositionalMtmRecomputeStatus>(API_ENDPOINTS.V2_POSITIONAL_MTM.RECOMPUTE_STATUS);
  },
};

// ==================== MANUAL EOD JOB RUN ====================

export interface EodStepResult {
  step: string;
  ok: boolean;
  error?: string | null;
  millis: number;
}

export interface EodRunResult {
  exchange: string;
  dateStr: string;
  allOk: boolean;
  steps: EodStepResult[];
}

export interface EodRunJob {
  jobId: string;
  exchange: string;
  dateStr: string;
  state: 'RUNNING' | 'COMPLETED' | 'FAILED';
  startedAtMillis: number;
  finishedAtMillis: number;
  error?: string | null;
  result?: EodRunResult | null;
}

export interface EodRunStatus {
  running: boolean;
  job: EodRunJob | null;
}

export interface EodExchangeEligibility {
  exchange: string;
  eligible: boolean;
  running: boolean;
  reportTime: string; // configured post-market EOD time, HH:mm
  reason?: string | null;
}

export interface EodRunStartResponse {
  started: boolean;
  exchange: string;
  jobId: string;
  message: string;
  statusUrl: string;
}

export const eodJobRunService = {
  // Sysadmin: run the same post-market EOD sequence the auto worker runs for one exchange. The server
  // refuses (409) if it's before the exchange's configured post-market time or a run is already in
  // progress for it; 400 for an unknown exchange. Poll getStatus(exchange).
  async run(exchange: string): Promise<EodRunStartResponse> {
    return api.post<EodRunStartResponse>(API_ENDPOINTS.V2_EOD_JOB_RUN.RUN, { exchange });
  },

  async getStatus(exchange: string): Promise<EodRunStatus> {
    return api.get<EodRunStatus>(`${API_ENDPOINTS.V2_EOD_JOB_RUN.STATUS}?exchange=${encodeURIComponent(exchange)}`);
  },

  async getExchanges(): Promise<EodExchangeEligibility[]> {
    return api.get<EodExchangeEligibility[]>(API_ENDPOINTS.V2_EOD_JOB_RUN.EXCHANGES);
  },
};

// ==================== EOD PNL REPORTS ====================

export const eodPnlService = {
  // Get EOD PnL reports - returns either array (legacy) or object with records and summary
  async getReports(filter?: EODPnlFilter): Promise<EODPnlReport[] | EODPnlResponse> {
    return api.get<EODPnlReport[] | EODPnlResponse>(API_ENDPOINTS.V2_EOD_PNL.BASE, filter);
  },

  // Distinct (strategyName, product) present in the caller's scoped EOD reports — for the reports
  // strategy filter, unioned with the active catalog so disabled/removed strategies stay filterable.
  async getReportStrategies(): Promise<{ strategyName: string; product: string | null }[]> {
    return api.get<{ strategyName: string; product: string | null }[]>(API_ENDPOINTS.V2_EOD_PNL.STRATEGIES);
  },
};

// ==================== CAPITAL CHANGE HISTORY ====================

export const capitalHistoryService = {
  // Get capital change history
  async getHistory(params: {
    username?: string;
    broker?: string;
    strategy?: string;
    startDate?: string;
    endDate?: string;
    limit?: number;
  }): Promise<CapitalChangeHistory[]> {
    return api.get<CapitalChangeHistory[]>(API_ENDPOINTS.V2_CAPITAL_HISTORY.BASE, params);
  },

  // Get a page of capital-change history. Sending page/pageSize makes the endpoint
  // return the `{ data, pagination }` envelope; the optional broker filter and the
  // free-text search are applied SERVER-SIDE across the whole history (the old
  // path capped at 500 rows and searched on the client over just that slice).
  async getPaginated(params: {
    username: string;
    broker?: string;
    search?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResponse<CapitalChangeHistory>> {
    const query: Record<string, unknown> = {
      username: params.username,
      page: params.page,
      pageSize: params.pageSize,
    };
    if (params.broker) query.broker = params.broker;
    if (params.search) query.search = params.search;
    return api.get<PaginatedResponse<CapitalChangeHistory>>(API_ENDPOINTS.V2_CAPITAL_HISTORY.BASE, query);
  },
};

// ==================== USER MARGINS ====================

// Margin record interface matching API response
interface MarginRecord {
  username: string;
  broker: string;
  exchangeCode?: string;
  date: string;
  peakMargin: number;
  totalMargin: number;
}

export const userMarginService = {
  // Get user margins by date range
  async getMargins(params: {
    username?: string;
    fromDate?: string;
    toDate?: string;
    date?: string; // Legacy single date parameter
  }): Promise<MarginRecord[]> {
    return api.get<MarginRecord[]>(API_ENDPOINTS.V2_USER_MARGINS.BASE, params);
  },

  // Get a page of margin records. Filters + ordering + the authorized-user scope
  // are applied SERVER-SIDE, returning the { data, pagination } envelope (the
  // table was unbounded — user × broker × day).
  async getMarginsPaginated(params: {
    fromDate: string;
    toDate: string;
    username?: string;
    page: number;
    pageSize: number;
  }): Promise<PaginatedResponse<MarginRecord>> {
    const query: Record<string, unknown> = {
      fromDate: params.fromDate,
      toDate: params.toDate,
      page: params.page,
      pageSize: params.pageSize,
    };
    if (params.username) query.username = params.username;
    return api.get(API_ENDPOINTS.V2_USER_MARGINS.BASE, query);
  },
};

// ==================== BROKER LOGIN STATUS ====================

export const brokerLoginStatusService = {
  // Get login status (tokens are masked by default)
  async getStatus(username?: string): Promise<BrokerLoginStatus[]> {
    const params = username ? { username } : undefined;
    return api.get<BrokerLoginStatus[]>(API_ENDPOINTS.V2_USER_BROKER_LOGIN_STATUS.BASE, params);
  },

  // Server-side paginated + filtered login status for the admin tab. search/broker/status/todayOnly
  // are all applied on the server; 'all' status is sent as no filter.
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    broker?: string;
    status?: string; // success | failed | shared (all => omitted)
    todayOnly?: boolean;
  }): Promise<PaginatedResponse<BrokerLoginStatus>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.broker && params.broker !== 'all') query.broker = params.broker;
    if (params.status && params.status !== 'all') query.status = params.status;
    if (params.todayOnly) query.todayOnly = true;
    return api.get<PaginatedResponse<BrokerLoginStatus>>(API_ENDPOINTS.V2_USER_BROKER_LOGIN_STATUS.BASE, query);
  },

  // Get full login status for specific user-broker with unmasked tokens
  async getStatusWithTokens(username: string, broker: string): Promise<BrokerLoginStatus> {
    return api.get<BrokerLoginStatus>(API_ENDPOINTS.V2_USER_BROKER_LOGIN_STATUS.BASE, {
      username,
      broker,
      includeTokens: 'true',
    });
  },

  // Delete login status for specific user-broker
  async deleteStatus(username: string, broker: string): Promise<void> {
    return api.delete(`${API_ENDPOINTS.V2_USER_BROKER_LOGIN_STATUS.BASE}?username=${encodeURIComponent(username)}&broker=${encodeURIComponent(broker)}`);
  },
};

export interface BrokerSocketStatus {
  username: string;
  broker: string;
  clientID?: string;
  // CONNECTED / CONNECTING / DISCONNECTED / NOT_CONNECTED / DISABLED / SHARED / UNKNOWN
  status: string;
  connected: boolean;
  client?: string;   // socket impl: XTSSocket (1.0.2) / XTSSocketV2 (2.x) / NorenSocket / ...
  message?: string;
}

export const brokerSocketStatusService = {
  // Live per-user-broker WebSocket (order/position socket) connection status.
  async getStatus(username?: string): Promise<BrokerSocketStatus[]> {
    const params = username ? { username } : undefined;
    return api.get<BrokerSocketStatus[]>(API_ENDPOINTS.V2_USER_BROKER_SOCKET_STATUS.BASE, params);
  },

  // Server-side paginated + filtered socket status for the admin tab. search/broker/status are all
  // applied on the server (status bucket: connected | problem | disabled; all => omitted).
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    broker?: string;
    status?: string;
  }): Promise<PaginatedResponse<BrokerSocketStatus>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.broker && params.broker !== 'all') query.broker = params.broker;
    if (params.status && params.status !== 'all') query.status = params.status;
    return api.get<PaginatedResponse<BrokerSocketStatus>>(API_ENDPOINTS.V2_USER_BROKER_SOCKET_STATUS.BASE, query);
  },
};

// ==================== BROKER AGENTS (Xtreme Agent Health tab) ====================

export interface BrokerAgentInfo {
  username: string;
  broker: string;
  clientID?: string;
  xtremeAgentUrl?: string | null;
}

export const brokerAgentsService = {
  // Server-side paginated + filtered agent list (active user + enabled user-broker). search/broker
  // are applied on the server; the live health ping + healthy/unhealthy filter stay client-side over
  // the visible page (the server does not ping agents).
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    broker?: string;
  }): Promise<PaginatedResponse<BrokerAgentInfo>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.broker && params.broker !== 'all') query.broker = params.broker;
    return api.get<PaginatedResponse<BrokerAgentInfo>>(API_ENDPOINTS.V2_USER_BROKER_AGENTS.BASE, query);
  },
};

// ==================== BROKER API STATS ====================

export const brokerApiStatsService = {
  // Get raw API stats (individual records)
  // broker can be 'all' or empty to get stats for all brokers
  async getStats(params: { broker?: string; date: string }): Promise<BrokerApiStat[]> {
    return api.get<BrokerApiStat[]>(API_ENDPOINTS.V2_BROKER_API_STATS.BASE, params);
  },
};

// ==================== BROKERS (V2) ====================

export const v2BrokerService = {
  // Get supported broker types
  async getBrokerTypes(): Promise<import('@/components/brokers/Broker').BrokerTypeInfo[]> {
    return api.get(`${API_ENDPOINTS.V2_BROKERS.BASE}/types`);
  },

  // Get all brokers
  async getAll(): Promise<import('@/types/broker').Broker[]> {
    return api.get(API_ENDPOINTS.V2_BROKERS.LIST);
  },

  // Get broker by name
  async getByName(name: string): Promise<import('@/types/broker').Broker> {
    return api.get(API_ENDPOINTS.V2_BROKERS.DETAILS(name));
  },

  // Create broker
  async create(data: import('@/types/broker').CreateBrokerRequest): Promise<import('@/types/broker').Broker> {
    return api.post(API_ENDPOINTS.V2_BROKERS.BASE, data);
  },

  // Update broker
  async update(name: string, data: import('@/types/broker').UpdateBrokerRequest): Promise<import('@/types/broker').Broker> {
    return api.put(API_ENDPOINTS.V2_BROKERS.DETAILS(name), data);
  },

  // Stop broker
  async stop(name: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_BROKERS.STOP(name), {});
  },

  // Unstop broker
  async unstop(name: string): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.V2_BROKERS.UNSTOP(name), {});
  },

  // Delete broker
  async delete(name: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BROKERS.DETAILS(name));
  },
};

// ==================== USER EVENT DAY ACTIONS ====================

export interface UserEventDayAction {
  username: string;
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

export const userEventDayActionService = {
  // Get all user event day actions
  async getAll(): Promise<UserEventDayAction[]> {
    return api.get<UserEventDayAction[]>(API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.ALL);
  },

  // Get user event day actions for a specific user
  async getByUser(username: string): Promise<UserEventDayAction[]> {
    return api.get<UserEventDayAction[]>(API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username));
  },

  // Get user event day actions by exchange
  async getByUserAndExchange(username: string, exchange: string): Promise<UserEventDayAction[]> {
    return api.get<UserEventDayAction[]>(`${API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username)}?exchange=${exchange}`);
  },

  // Get specific user event day action
  async get(username: string, eventDate: string, exchange: string): Promise<UserEventDayAction> {
    return api.get<UserEventDayAction>(`${API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  // Create user event day action
  async create(username: string, data: { eventDate: string; exchangeCode: string; capitalPercentage: number }): Promise<UserEventDayAction> {
    return api.post<UserEventDayAction>(API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username), data);
  },

  // Update user event day action
  async update(username: string, eventDate: string, exchange: string, data: { capitalPercentage: number }): Promise<UserEventDayAction> {
    return api.put<UserEventDayAction>(`${API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username)}?eventDate=${eventDate}&exchange=${exchange}`, data);
  },

  // Delete user event day action
  async delete(username: string, eventDate: string, exchange: string): Promise<{ success: boolean }> {
    return api.delete(`${API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  // Delete all user event day actions
  async deleteAll(username: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_USER_EVENT_DAY_ACTIONS.BASE(username));
  },
};

// ==================== STRATEGY EVENT DAY ACTIONS ====================

export interface StrategyEventDayAction {
  strategyName: string;
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

export const strategyEventDayActionService = {
  // Get all strategy event day actions
  async getAll(): Promise<StrategyEventDayAction[]> {
    return api.get<StrategyEventDayAction[]>(API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.ALL);
  },

  // Get strategy event day actions for a specific strategy
  async getByStrategy(strategyName: string): Promise<StrategyEventDayAction[]> {
    return api.get<StrategyEventDayAction[]>(API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName));
  },

  // Get strategy event day actions by exchange
  async getByStrategyAndExchange(strategyName: string, exchange: string): Promise<StrategyEventDayAction[]> {
    return api.get<StrategyEventDayAction[]>(`${API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName)}?exchange=${exchange}`);
  },

  // Get specific strategy event day action
  async get(strategyName: string, eventDate: string, exchange: string): Promise<StrategyEventDayAction> {
    return api.get<StrategyEventDayAction>(`${API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  // Create strategy event day action
  async create(strategyName: string, data: { eventDate: string; exchangeCode: string; capitalPercentage: number }): Promise<StrategyEventDayAction> {
    return api.post<StrategyEventDayAction>(API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName), data);
  },

  // Update strategy event day action
  async update(strategyName: string, eventDate: string, exchange: string, data: { capitalPercentage: number }): Promise<StrategyEventDayAction> {
    return api.put<StrategyEventDayAction>(`${API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName)}?eventDate=${eventDate}&exchange=${exchange}`, data);
  },

  // Delete strategy event day action
  async delete(strategyName: string, eventDate: string, exchange: string): Promise<{ success: boolean }> {
    return api.delete(`${API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  // Delete all strategy event day actions
  async deleteAll(strategyName: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_STRATEGY_EVENT_DAY_ACTIONS.BASE(strategyName));
  },
};

// ==================== PRODUCT EVENT DAY ACTIONS ====================

export interface ProductEventDayAction {
  // Any backend Product — the hand-written union here used to omit MTF.
  product: Product;
  exchangeCode: string;
  eventDate: string;
  capitalPercentage: number;
}

export const productEventDayActionService = {
  async getAll(): Promise<ProductEventDayAction[]> {
    return api.get<ProductEventDayAction[]>(API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.ALL);
  },

  async getByProduct(product: string): Promise<ProductEventDayAction[]> {
    return api.get<ProductEventDayAction[]>(API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product));
  },

  async getByProductAndExchange(product: string, exchange: string): Promise<ProductEventDayAction[]> {
    return api.get<ProductEventDayAction[]>(`${API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product)}?exchange=${exchange}`);
  },

  async get(product: string, eventDate: string, exchange: string): Promise<ProductEventDayAction> {
    return api.get<ProductEventDayAction>(`${API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  async create(product: string, data: { eventDate: string; exchangeCode: string; capitalPercentage: number }): Promise<ProductEventDayAction> {
    return api.post<ProductEventDayAction>(API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product), data);
  },

  async update(product: string, eventDate: string, exchange: string, data: { capitalPercentage: number }): Promise<ProductEventDayAction> {
    return api.put<ProductEventDayAction>(`${API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product)}?eventDate=${eventDate}&exchange=${exchange}`, data);
  },

  async delete(product: string, eventDate: string, exchange: string): Promise<{ success: boolean }> {
    return api.delete(`${API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product)}?eventDate=${eventDate}&exchange=${exchange}`);
  },

  async deleteAll(product: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_PRODUCT_EVENT_DAY_ACTIONS.BASE(product));
  },
};

// ==================== USER BILLS ====================

export interface UserBill {
  username: string;
  billingNumber: number;
  clientManager: string;
  billingPlan: string;
  billingPeriodDays: number;
  billingStartDate: number; // timestamp
  billingEndDate: number; // timestamp
  averageCapital: number;
  netProfitLossIntraday: number;
  netProfitLossPositional: number;
  netProfitLoss: number;
  previousLoss: number;
  unAccountedPnl: number;
  netProfitLossAfterAdjustments: number;
  fixedCost: number;
  variableCost: number;
  totalCost: number;
  isPaid: boolean;
  isApproved: boolean;
  paymentDueDate: number; // timestamp
  financialYear: string;
  fyBillingNumber: number;
  invoiceNumber: string;
  GST: number;
  totalCostWithGST: number;
  paidAmount: number;
  tds: number;
  otherDeductions: number;
  isWrittenOff: boolean;
}

export const userBillsService = {
  // Get all bills by date range, optionally filtered by username (full array — legacy).
  async getBills(params: { username?: string; fromDate: string; toDate: string }): Promise<UserBill[]> {
    return api.get<UserBill[]>(API_ENDPOINTS.V2_USER_BILLS.BASE, params);
  },

  // Get a page of bills. The status filter and the authorized-user scope are applied
  // SERVER-SIDE, and the { total, paid, unpaid, overdue } summary is computed over the
  // WHOLE filtered set (not the page) — so the cards stay accurate while paginating.
  async getBillsPaginated(params: {
    fromDate: string;
    toDate: string;
    username?: string;
    status?: 'ALL' | 'PAID' | 'UNPAID' | 'OVERDUE';
    page: number;
    pageSize: number;
  }): Promise<PaginatedResponse<UserBill> & { summary: { total: number; paid: number; unpaid: number; overdue: number } }> {
    const query: Record<string, unknown> = {
      fromDate: params.fromDate,
      toDate: params.toDate,
      page: params.page,
      pageSize: params.pageSize,
    };
    if (params.username) query.username = params.username;
    if (params.status && params.status !== 'ALL') query.status = params.status;
    return api.get(API_ENDPOINTS.V2_USER_BILLS.BASE, query);
  },

  // Get user bills (legacy)
  async getByUser(username: string): Promise<UserBill[]> {
    return api.get<UserBill[]>(API_ENDPOINTS.V2_USER_BILLS.BY_USER(username));
  },

  // Get bill details
  async getBill(username: string, billId: string): Promise<UserBill> {
    return api.get<UserBill>(`${API_ENDPOINTS.V2_USER_BILLS.BY_USER(username)}/${billId}`);
  },

  // Mark bill as paid
  async markPaid(username: string, billId: string, amount: number): Promise<UserBill> {
    return api.put<UserBill>(`${API_ENDPOINTS.V2_USER_BILLS.BY_USER(username)}/${billId}/pay`, { amount });
  },

  // Sysadmin-only. Reconcile bills from a date forward to today: recompute existing
  // bills in place (preserving invoice numbers + payment status) and create any
  // missing bills, keeping loss carry-forward intact. regenerateEodReports=true
  // rebuilds EOD reports from raw trades first (authoritative, slow); false reuses
  // the daily-maintained reports (fast). Runs in the background; returns once started.
  async reconcile(params: { fromDate: string; regenerateEodReports: boolean }): Promise<{ started: boolean; fromDate: string; regenerateEodReports: boolean }> {
    return api.post(API_ENDPOINTS.V2_USER_BILLS.RECONCILE, params);
  },
};

// ==================== BROKER STRATEGY CONFIG ====================

export interface BrokerStrategyConfig {
  broker: string;
  strategyName: string;
  productType: string; // MIS, NRML, CO, BO, CNC
  intradaySquareOffMinutesBeforeClose: number;
  positionalSquareOffMinutesBeforeClose: number;
}

export interface CreateBrokerStrategyConfigRequest {
  broker: string;
  strategyName: string;
  orderType: string; // MIS, NRML, CO, BO, CNC
  intradaySquareOffMinutesBeforeClose: number;
  positionalSquareOffMinutesBeforeClose: number;
}

export const brokerStrategyConfigService = {
  // Get all configs
  async getAll(): Promise<BrokerStrategyConfig[]> {
    return api.get<BrokerStrategyConfig[]>(API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.BASE);
  },

  // Get configs by broker
  async getByBroker(broker: string): Promise<BrokerStrategyConfig[]> {
    return api.get<BrokerStrategyConfig[]>(`${API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.BASE}/${broker}`);
  },

  // Get config by broker and strategy
  async get(broker: string, strategy: string): Promise<BrokerStrategyConfig> {
    return api.get<BrokerStrategyConfig>(API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.DETAILS(broker, strategy));
  },

  // Create config
  async create(data: CreateBrokerStrategyConfigRequest): Promise<BrokerStrategyConfig> {
    return api.post<BrokerStrategyConfig>(API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.BASE, data);
  },

  // Update config
  async update(broker: string, strategy: string, data: Partial<CreateBrokerStrategyConfigRequest>): Promise<BrokerStrategyConfig> {
    return api.put<BrokerStrategyConfig>(API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.DETAILS(broker, strategy), data);
  },

  // Delete config
  async delete(broker: string, strategy: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_BROKER_STRATEGY_CONFIGS.DETAILS(broker, strategy));
  },
};

// ==================== STRATEGY DAYS ALLOCATION ====================

export interface StrategyDaysAllocationConfig {
  strategyName: string;
  allocationModel: string;
  mondayAllocation: number;
  tuesdayAllocation: number;
  wednesdayAllocation: number;
  thursdayAllocation: number;
  fridayAllocation: number;
  expiryDayAllocation: number;
  dt1DayAllocation: number;  // DT1 day allocation (days to expiry = 1)
  dt2DayAllocation: number;  // DT2 day allocation (days to expiry = 2)
}

export const strategyDaysAllocationService = {
  // Get all configs
  async getAll(): Promise<StrategyDaysAllocationConfig[]> {
    return api.get<StrategyDaysAllocationConfig[]>(API_ENDPOINTS.V2_STRATEGY_DAYS_ALLOCATION.BASE);
  },

  // Get config by strategy and allocation model
  async get(strategyName: string, allocationModel: string): Promise<StrategyDaysAllocationConfig> {
    return api.get<StrategyDaysAllocationConfig>(API_ENDPOINTS.V2_STRATEGY_DAYS_ALLOCATION.DETAILS(strategyName, allocationModel));
  },

  // Create/Update config
  async save(data: StrategyDaysAllocationConfig): Promise<StrategyDaysAllocationConfig> {
    return api.post<StrategyDaysAllocationConfig>(API_ENDPOINTS.V2_STRATEGY_DAYS_ALLOCATION.BASE, data);
  },

  // Delete config
  async delete(strategyName: string, allocationModel: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_STRATEGY_DAYS_ALLOCATION.DETAILS(strategyName, allocationModel));
  },
};

// ==================== UNACCOUNTED PNL ====================

export interface UnAccountedPnl {
  username: string;
  broker: string;
  strategy: string;
  date: string;
  amount: number;
  reason: string;
  resolved: boolean;
  resolvedAt?: string;
  resolvedBy?: string;
}

export const unAccountedPnlService = {
  // Get all unaccounted PnL records
  async getAll(params?: { username?: string; broker?: string; fromDate?: string; toDate?: string; resolved?: boolean }): Promise<UnAccountedPnl[]> {
    return api.get<UnAccountedPnl[]>(API_ENDPOINTS.V2_UNACCOUNTED_PNL.BASE, params);
  },

  // Resolve unaccounted PnL
  async resolve(username: string, broker: string, strategy: string, date: string): Promise<UnAccountedPnl> {
    return api.put<UnAccountedPnl>(`${API_ENDPOINTS.V2_UNACCOUNTED_PNL.BASE}/${username}/${broker}/${strategy}/${date}/resolve`, {});
  },
};

// ==================== ANALYTICS ====================

export const analyticsService = {
  // Get admin analytics
  async getAnalytics(params?: { fromDate?: string; toDate?: string }): Promise<AdminAnalytics> {
    // This might need a custom endpoint or aggregate from multiple sources
    return api.get('/api/v2/analytics', params);
  },
};

// ==================== SYSTEM CONFIG ====================

export interface SystemConfigEntry {
  property: string;
  value: string | null;
}

export interface CreateSystemConfigRequest {
  property: string;
  value: string;
}

export interface UpdateSystemConfigRequest {
  value: string;
}

export const systemConfigService = {
  // Get all system configs
  async getAll(): Promise<SystemConfigEntry[]> {
    return api.get<SystemConfigEntry[]>(API_ENDPOINTS.V2_SYSTEM_CONFIG.LIST);
  },

  // Get specific config by property
  async getByProperty(property: string): Promise<SystemConfigEntry> {
    return api.get<SystemConfigEntry>(API_ENDPOINTS.V2_SYSTEM_CONFIG.DETAILS(property));
  },

  // Create new config
  async create(data: CreateSystemConfigRequest): Promise<SystemConfigEntry> {
    return api.post<SystemConfigEntry>(API_ENDPOINTS.V2_SYSTEM_CONFIG.BASE, data);
  },

  // Update existing config
  async update(property: string, data: UpdateSystemConfigRequest): Promise<SystemConfigEntry> {
    return api.put<SystemConfigEntry>(API_ENDPOINTS.V2_SYSTEM_CONFIG.DETAILS(property), data);
  },

  // Delete config
  async delete(property: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_SYSTEM_CONFIG.DETAILS(property));
  },
};

// ==================== STRATEGY CONFIG TREE ====================

import type {
  StrategyConfigTree,
  CreateStrategyConfigTreeRequest,
  UpdateStrategyConfigTreeRequest,
  EffectiveConfig,
  DayConditionInfo,
} from '@/types/strategy-config-tree';
import type {
  Symbol as SymbolType,
  CreateSymbolRequest,
  UpdateSymbolRequest,
  SymbolBrokerConfig,
  CreateSymbolBrokerConfigRequest,
  UpdateSymbolBrokerConfigRequest,
} from '@/types/symbol';

export const strategyConfigTreeService = {
  // Get all configs (full list — kept for callers that genuinely need it; the
  // admin table should use getPaginated to avoid shipping the whole tree).
  async getAll(): Promise<StrategyConfigTree[]> {
    return api.get<StrategyConfigTree[]>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.LIST);
  },

  // Get a page of the admin config list. Search / strategy / priority filters and
  // ordering are applied SERVER-SIDE, returning the { data, pagination } envelope.
  async getPaginated(params: {
    page: number;
    pageSize: number;
    search?: string;
    strategyName?: string;
    priority?: number;
  }): Promise<PaginatedResponse<StrategyConfigTree>> {
    const query: Record<string, unknown> = { page: params.page, pageSize: params.pageSize };
    if (params.search) query.search = params.search;
    if (params.strategyName) query.strategyName = params.strategyName;
    if (params.priority != null) query.priority = params.priority;
    return api.get<PaginatedResponse<StrategyConfigTree>>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.LIST, query);
  },

  // Base (scope-less) configs — one row per strategy that has a base config.
  // Backs the "Clone From" picker without loading the whole tree.
  async getBaseConfigs(): Promise<StrategyConfigTree[]> {
    return api.get<StrategyConfigTree[]>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.BASE_CONFIGS);
  },

  // Distinct strategy names present in the config tree — for the filter dropdown.
  async getStrategyNames(): Promise<string[]> {
    return api.get<string[]>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.STRATEGY_NAMES);
  },

  // Live duplicate-scope check for the create form. The POST still 409s on a real
  // conflict — this is just the inline UX hint.
  async checkExists(params: {
    strategyName: string;
    username?: string | null;
    broker?: string | null;
    tranchNumber?: number | null;
    dayCondition?: string | null;
  }): Promise<boolean> {
    const query: Record<string, unknown> = { strategyName: params.strategyName };
    if (params.username) query.username = params.username;
    if (params.broker) query.broker = params.broker;
    if (params.tranchNumber != null) query.tranchNumber = params.tranchNumber;
    if (params.dayCondition) query.dayCondition = params.dayCondition;
    const res = await api.get<{ exists: boolean }>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.EXISTS, query);
    return res.exists;
  },

  // Get config by ID
  async getById(id: number): Promise<StrategyConfigTree> {
    return api.get<StrategyConfigTree>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.DETAILS(id));
  },

  // Get all configs for a strategy
  async getByStrategy(strategyName: string): Promise<StrategyConfigTree[]> {
    return api.get<StrategyConfigTree[]>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.BY_STRATEGY(strategyName));
  },

  // Get effective config (merged from all applicable configs)
  async getEffective(params: {
    username: string;
    broker: string;
    strategyName: string;
    tranchNumber?: number;
    dayCondition?: string;
  }): Promise<EffectiveConfig> {
    return api.get<EffectiveConfig>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.EFFECTIVE, params);
  },

  // Get day conditions for dropdown
  async getDayConditions(): Promise<DayConditionInfo[]> {
    return api.get<DayConditionInfo[]>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.DAY_CONDITIONS);
  },

  // Create new config
  async create(data: CreateStrategyConfigTreeRequest): Promise<StrategyConfigTree> {
    return api.post<StrategyConfigTree>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.BASE, data);
  },

  // Update config
  async update(id: number, data: UpdateStrategyConfigTreeRequest): Promise<StrategyConfigTree> {
    return api.put<StrategyConfigTree>(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.DETAILS(id), data);
  },

  // Delete config
  async delete(id: number): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_STRATEGY_CONFIG_TREE.DETAILS(id));
  },
};

// ==================== STRATEGY POLICIES ====================

import type {
  OrderFillEscalationPolicy,
  CreateOrderFillPolicyRequest,
  TrailingSLPolicy,
  CreateTrailingSLPolicyRequest,
  SLTargetPolicy,
  CreateSLTargetPolicyRequest,
  StrikeSelectionPolicy,
  CreateStrikePolicyRequest,
  ExitPolicy,
  CreateExitPolicyRequest,
  AllPoliciesSummary,
} from '@/types/strategy-policies';

export const strategyPolicyService = {
  // Get all policies summary
  async getAll(): Promise<AllPoliciesSummary> {
    return api.get<AllPoliciesSummary>(API_ENDPOINTS.V2_STRATEGY_POLICIES.ALL);
  },

  // Order Fill Escalation Policies
  orderFill: {
    async getAll(): Promise<OrderFillEscalationPolicy[]> {
      return api.get<OrderFillEscalationPolicy[]>(API_ENDPOINTS.V2_STRATEGY_POLICIES.ORDER_FILL.LIST);
    },
    async getById(id: number): Promise<OrderFillEscalationPolicy> {
      return api.get<OrderFillEscalationPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.ORDER_FILL.DETAILS(id));
    },
    async create(data: CreateOrderFillPolicyRequest): Promise<OrderFillEscalationPolicy> {
      return api.post<OrderFillEscalationPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.ORDER_FILL.LIST, data);
    },
    async update(id: number, data: Partial<CreateOrderFillPolicyRequest>): Promise<OrderFillEscalationPolicy> {
      return api.put<OrderFillEscalationPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.ORDER_FILL.DETAILS(id), data);
    },
    async delete(id: number): Promise<{ deleted: boolean; id: number }> {
      return api.delete(API_ENDPOINTS.V2_STRATEGY_POLICIES.ORDER_FILL.DETAILS(id));
    },
  },

  // Trailing SL Policies
  trailingSL: {
    async getAll(): Promise<TrailingSLPolicy[]> {
      return api.get<TrailingSLPolicy[]>(API_ENDPOINTS.V2_STRATEGY_POLICIES.TRAILING_SL.LIST);
    },
    async getById(id: number): Promise<TrailingSLPolicy> {
      return api.get<TrailingSLPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.TRAILING_SL.DETAILS(id));
    },
    async create(data: CreateTrailingSLPolicyRequest): Promise<TrailingSLPolicy> {
      return api.post<TrailingSLPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.TRAILING_SL.LIST, data);
    },
    async update(id: number, data: Partial<CreateTrailingSLPolicyRequest>): Promise<TrailingSLPolicy> {
      return api.put<TrailingSLPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.TRAILING_SL.DETAILS(id), data);
    },
    async delete(id: number): Promise<{ deleted: boolean; id: number }> {
      return api.delete(API_ENDPOINTS.V2_STRATEGY_POLICIES.TRAILING_SL.DETAILS(id));
    },
  },

  // SL Target Policies
  slTarget: {
    async getAll(): Promise<SLTargetPolicy[]> {
      return api.get<SLTargetPolicy[]>(API_ENDPOINTS.V2_STRATEGY_POLICIES.SL_TARGET.LIST);
    },
    async getById(id: number): Promise<SLTargetPolicy> {
      return api.get<SLTargetPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.SL_TARGET.DETAILS(id));
    },
    async create(data: CreateSLTargetPolicyRequest): Promise<SLTargetPolicy> {
      return api.post<SLTargetPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.SL_TARGET.LIST, data);
    },
    async update(id: number, data: Partial<CreateSLTargetPolicyRequest>): Promise<SLTargetPolicy> {
      return api.put<SLTargetPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.SL_TARGET.DETAILS(id), data);
    },
    async delete(id: number): Promise<{ deleted: boolean; id: number }> {
      return api.delete(API_ENDPOINTS.V2_STRATEGY_POLICIES.SL_TARGET.DETAILS(id));
    },
  },

  // Strike Selection Policies
  strike: {
    async getAll(): Promise<StrikeSelectionPolicy[]> {
      return api.get<StrikeSelectionPolicy[]>(API_ENDPOINTS.V2_STRATEGY_POLICIES.STRIKE.LIST);
    },
    async getById(id: number): Promise<StrikeSelectionPolicy> {
      return api.get<StrikeSelectionPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.STRIKE.DETAILS(id));
    },
    async create(data: CreateStrikePolicyRequest): Promise<StrikeSelectionPolicy> {
      return api.post<StrikeSelectionPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.STRIKE.LIST, data);
    },
    async update(id: number, data: Partial<CreateStrikePolicyRequest>): Promise<StrikeSelectionPolicy> {
      return api.put<StrikeSelectionPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.STRIKE.DETAILS(id), data);
    },
    async delete(id: number): Promise<{ deleted: boolean; id: number }> {
      return api.delete(API_ENDPOINTS.V2_STRATEGY_POLICIES.STRIKE.DETAILS(id));
    },
  },

  // Exit Policies
  exit: {
    async getAll(): Promise<ExitPolicy[]> {
      return api.get<ExitPolicy[]>(API_ENDPOINTS.V2_STRATEGY_POLICIES.EXIT.LIST);
    },
    async getById(id: number): Promise<ExitPolicy> {
      return api.get<ExitPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.EXIT.DETAILS(id));
    },
    async create(data: CreateExitPolicyRequest): Promise<ExitPolicy> {
      return api.post<ExitPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.EXIT.LIST, data);
    },
    async update(id: number, data: Partial<CreateExitPolicyRequest>): Promise<ExitPolicy> {
      return api.put<ExitPolicy>(API_ENDPOINTS.V2_STRATEGY_POLICIES.EXIT.DETAILS(id), data);
    },
    async delete(id: number): Promise<{ deleted: boolean; id: number }> {
      return api.delete(API_ENDPOINTS.V2_STRATEGY_POLICIES.EXIT.DETAILS(id));
    },
  },
};

// ==================== SYMBOLS ====================

export const symbolService = {
  // Get all symbols
  async getAll(params?: { exchange?: string; segment?: string; instrumentType?: string }): Promise<SymbolType[]> {
    return api.get<SymbolType[]>(API_ENDPOINTS.V2_SYMBOLS.LIST, params);
  },

  // Get symbol by symbol name
  async getBySymbol(symbol: string): Promise<SymbolType> {
    return api.get<SymbolType>(API_ENDPOINTS.V2_SYMBOLS.DETAILS(symbol));
  },

  // Get symbols by exchange
  async getByExchange(exchange: string): Promise<SymbolType[]> {
    return api.get<SymbolType[]>(API_ENDPOINTS.V2_SYMBOLS.LIST, { exchange });
  },

  // Create symbol
  async create(data: CreateSymbolRequest): Promise<SymbolType> {
    return api.post<SymbolType>(API_ENDPOINTS.V2_SYMBOLS.BASE, data);
  },

  // Update symbol
  async update(symbol: string, data: UpdateSymbolRequest): Promise<SymbolType> {
    return api.put<SymbolType>(API_ENDPOINTS.V2_SYMBOLS.DETAILS(symbol), data);
  },

  // Delete symbol
  async delete(tradingSymbol: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_SYMBOLS.DETAILS(tradingSymbol));
  },

  // Get symbol broker configs
  async getBrokerConfigs(tradingSymbol: string): Promise<SymbolBrokerConfig[]> {
    return api.get<SymbolBrokerConfig[]>(API_ENDPOINTS.V2_SYMBOLS.BROKERS(tradingSymbol));
  },
};

// ==================== SYMBOL BROKER CONFIGS ====================

export const symbolBrokerConfigService = {
  // Get all symbol broker configs
  async getAll(params?: { symbol?: string; broker?: string; exchange?: string }): Promise<SymbolBrokerConfig[]> {
    return api.get<SymbolBrokerConfig[]>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.LIST, params);
  },

  // Get configs for a specific symbol
  async getBySymbol(tradingSymbol: string): Promise<SymbolBrokerConfig[]> {
    return api.get<SymbolBrokerConfig[]>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.BY_SYMBOL(tradingSymbol));
  },

  // Get configs for a specific broker
  async getByBroker(broker: string): Promise<SymbolBrokerConfig[]> {
    return api.get<SymbolBrokerConfig[]>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.LIST, { broker });
  },

  // Get specific config
  async get(tradingSymbol: string, broker: string): Promise<SymbolBrokerConfig> {
    return api.get<SymbolBrokerConfig>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.DETAILS(tradingSymbol, broker));
  },

  // Create config
  async create(data: CreateSymbolBrokerConfigRequest): Promise<SymbolBrokerConfig> {
    return api.post<SymbolBrokerConfig>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.BASE, data);
  },

  // Update config
  async update(tradingSymbol: string, broker: string, data: UpdateSymbolBrokerConfigRequest): Promise<SymbolBrokerConfig> {
    return api.put<SymbolBrokerConfig>(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.DETAILS(tradingSymbol, broker), data);
  },

  // Delete config
  async delete(tradingSymbol: string, broker: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.V2_SYMBOL_BROKER_CONFIGS.DETAILS(tradingSymbol, broker));
  },
};

// ==================== BROKER INSTRUMENTS ====================

import type {
  BrokerInstrumentsStats,
  InstrumentSearchResult,
  InstrumentLookupResult,
  ExpiryListResult,
  InstrumentSearchParams,
  InstrumentLookupParams,
  ExpiriesParams,
} from '@/types/broker-instruments';

export const brokerInstrumentsService = {
  // Get all broker instrument stats
  async getAllStats(): Promise<BrokerInstrumentsStats[]> {
    return api.get<BrokerInstrumentsStats[]>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.LIST);
  },

  // Get specific broker stats
  async getBrokerStats(broker: string): Promise<BrokerInstrumentsStats> {
    return api.get<BrokerInstrumentsStats>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.DETAILS(broker));
  },

  // Search instruments
  async searchInstruments(broker: string, params: InstrumentSearchParams): Promise<InstrumentSearchResult[]> {
    return api.get<InstrumentSearchResult[]>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.SEARCH(broker), params);
  },

  // Lookup specific instrument
  async lookupInstrument(broker: string, params: InstrumentLookupParams): Promise<InstrumentLookupResult> {
    return api.get<InstrumentLookupResult>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.LOOKUP(broker), params);
  },

  // Get available expiries
  async getExpiries(broker: string, params: ExpiriesParams): Promise<ExpiryListResult> {
    return api.get<ExpiryListResult>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.EXPIRIES(broker), params);
  },

  // Force download instruments
  async downloadInstruments(broker: string): Promise<BrokerInstrumentsStats> {
    return api.post<BrokerInstrumentsStats>(API_ENDPOINTS.V2_BROKER_INSTRUMENTS.DOWNLOAD(broker), {});
  },
};

// ==================== CACHE MANAGEMENT ====================

export interface CacheInfo {
  name: string;
  size: number;
  strategy: 'EAGER' | 'LAZY';
  initialized: boolean;
}

export interface CacheStats {
  coreCacheInitialized: boolean;
  caches: CacheInfo[];
}

export interface CacheClearResult {
  message: string;
  name?: string;
  size?: number;
}

export const cacheService = {
  // Get cache statistics
  async getStats(): Promise<CacheStats> {
    return api.get<CacheStats>(API_ENDPOINTS.V2_CACHE.STATS);
  },

  // Clear auth roles cache
  async clearRoles(): Promise<CacheClearResult> {
    return api.delete<CacheClearResult>(API_ENDPOINTS.V2_CACHE.CLEAR_ROLES);
  },

  // Refresh all core entity caches (CacheManager)
  async clearCore(): Promise<CacheClearResult> {
    return api.delete<CacheClearResult>(API_ENDPOINTS.V2_CACHE.CLEAR_CORE);
  },

  // Refresh a specific core entity cache by name
  async clearCoreByName(name: string): Promise<CacheClearResult> {
    return api.delete<CacheClearResult>(API_ENDPOINTS.V2_CACHE.CLEAR_CORE_BY_NAME(name));
  },

  // Re-discover the AI assistant's DB schema context (after ai_reader grant changes)
  async refreshAiSchema(): Promise<CacheClearResult> {
    return api.delete<CacheClearResult>(API_ENDPOINTS.V2_CACHE.REFRESH_AI_SCHEMA);
  },

  // Clear all caches (roles + core + AI schema)
  async clearAll(): Promise<CacheClearResult> {
    return api.delete<CacheClearResult>(API_ENDPOINTS.V2_CACHE.CLEAR_ALL);
  },
};

// ==================== SYSTEM STATUS (read-only dashboard) ====================

export interface SystemStatusRuntime {
  version: string;
  gitHash?: string;
  buildTime?: string;
  mode: string;
  uptimeSeconds: number;
  heapUsedMb: number;
  heapMaxMb: number;
  availableProcessors: number;
  threadCount?: number;
  daemonThreadCount?: number;
  peakThreadCount?: number;
  totalStartedThreadCount?: number;
  systemLoadAverage?: number | null;
  processCpuLoadPct?: number | null;
  systemCpuLoadPct?: number | null;
  totalPhysicalMemoryMb?: number;
  freePhysicalMemoryMb?: number;
  systemMemoryTotalMb?: number;
  systemMemoryAvailableMb?: number;
  systemMemoryUsedMb?: number;
  openFileDescriptors?: number;
  maxFileDescriptors?: number;
  processRssMb?: number;
  openSocketCount?: number;
  error?: string;
}

export interface SystemStatusProcessor {
  name: string;
  running: boolean;
  userBrokerCount: number;
  activeUserBrokers: number;
  activeTrades: number;
}

export interface SystemStatusSizing {
  cores?: number;
  enginePools?: {
    tick?: number;
    scheduled?: number;
    signal?: number;
    hedge?: number;
    misc?: number;
    scheduler?: number;
  };
  dbBoundParallelism?: number;
  dbMaxConnections?: number;
  squareOffWorkerThreads?: number;
  tradeProcessors?: {
    count?: number;
    ioFactor?: number;
    perProcessorCapacity?: number;
  };
  error?: string;
}

export interface SystemStatusTradeProcessors {
  initialized: boolean;
  count: number;
  userBrokersPerProcessor: number;
  totalUserBrokers?: number;
  distinctUsers?: number;
  activeUserBrokers?: number;
  frozenUserBrokers?: number;
  processors: SystemStatusProcessor[];
  error?: string;
}

// System-wide trade counts for the "Today Trades" health badge.
export interface SystemStatusTodayTrades {
  active: number;     // non-terminal (open + active) across all user-brokers
  completed: number;  // completed today (by end time), incl. evicted rows — true day total
  total: number;      // active + completed
  error?: string;
}

export interface SystemStatusTicker {
  connected: boolean;
  name: string | null;
  registeredSymbols: number;
  lastTickAt: string | null;
  marketOpen: boolean;
  state: 'UP' | 'DOWN' | 'INACTIVE';
  error?: string;
}

export interface SystemStatusEngine {
  exchange: string;
  running: boolean;
  dryRun: boolean;
  activeSubscriptions: number;
  scheduledTranches: number;
  executedTranches: number;
}

export interface SystemStatusStrategyDefinitions {
  total: number;
  active: number;
  windDown: number;
  inactive: number;
  signalEnabled: number;
  scheduledEnabled: number;
  tickEnabled: number;
  periodicEnabled: number;
  mock: number;
}

export interface SystemStatusStrategyEngine {
  engines: SystemStatusEngine[];
  definitions: SystemStatusStrategyDefinitions;
  error?: string;
}

export interface SystemStatusSubscriptions {
  total: number;
  active: number;
  inactive: number;
  paper: number;
  live: number;
  error?: string;
}

export interface SystemStatusUserBrokers {
  configured: number;
  withLoginStatus: number;
  loggedIn: number;
  failed: number;
  loggedOut: number;
  error?: string;
}

export interface SystemStatusBrokerRow {
  name: string;
  enabled: boolean;
  serverRunning: boolean | null;
  loggedInUsers: number;
}

export interface SystemStatusBrokers {
  total: number;
  enabled: number;
  disabled: number;
  perBroker: SystemStatusBrokerRow[];
  error?: string;
}

export interface SystemStatusExchangeRow {
  exchange: string;
  active: boolean;
  segment: string | null;
  marketOpen: string | null;
  marketClose: string | null;
  openNow?: boolean;
  holidayToday?: boolean;
  error?: string;
}

export interface SystemStatusExchanges {
  active: string[];
  anyMarketOpen: boolean;
  perExchange: SystemStatusExchangeRow[];
  error?: string;
}

export interface SystemStatusRms {
  runtimeEnabled: boolean;
  configEnabled: boolean;
  effectiveEnabled: boolean;
  activeKillSwitches: number;
  killSwitchTypes: Record<string, boolean>;
  breachesToday: number | null;
  breachesError?: string;
  error?: string;
}

export interface SystemStatusLicenses {
  assignedCount?: number;
  activeCount?: number;
  cacheValid?: boolean;
  lastHeartbeat?: string;
  serverConfigured?: boolean;
  error?: string;
  [key: string]: unknown;
}

export interface SystemStatusHttpServer {
  available: boolean;
  port: number;
  currentConnections: number;
  peakConnections: number;
  totalConnections: number;
  threads: number;
  busyThreads: number;
  idleThreads: number;
  maxThreads: number;
  minThreads: number;
  queueSize: number;
  error?: string;
}

// Live WebSocket serving stats (admin System Status). WS connections are NOT counted by the
// HTTP connector above; this is the real parallel-client view. peakSockets is the high-water
// mark of concurrent sockets since restart. closeCodes maps WS close code -> count (why sockets
// dropped: 4001 market-close, 1001/1006 abnormal, …).
export interface SystemStatusWebSocket {
  currentSockets: number;
  peakSockets: number;
  connectedSockets: number;
  supervisorSockets: number;
  portalSockets: number;
  totalConnects: number;
  totalDisconnects: number;
  portalSubscribers: number;
  scopedUsers: number;
  totalErrors: number;
  lastError?: string | null;
  closeCodes?: Record<string, number>;
  backpressure?: { maxOutboundDepth: number; droppedOutboundTotal: number };
  error?: string;
}

// One critical-path queue's instantaneous depth (admin System Status).
// capacity/utilizationPct are omitted by the backend for unbounded queues.
// activeCount/poolSize are present only for thread-pool-backed queues.
export interface SystemStatusQueue {
  name: string;
  group: string;
  size: number;
  capacity?: number;
  utilizationPct?: number;
  note?: string;
  activeCount?: number;
  poolSize?: number;
  droppedTotal?: number;
}

// One broker's resident working-set + order-book freshness aggregate (admin
// System Status "Per-Broker Distribution" panel). orderBookOldestFetchAgeSec is
// null when no order book has ever been successfully fetched for the broker.
export interface SystemStatusBrokerDist {
  broker: string;
  userBrokers: number;
  residentTrades: number;
  activeTrades: number;
  residentSignals: number;
  orderBookStaleCount: number;
  orderBookOldestFetchAgeSec: number | null;
  laggard: boolean;
}

// Cumulative active-in-memory eviction counts since the counting window began (app restart, reset
// to 0 at the morning day-init). Trades and trade-signals counted separately.
export interface SystemStatusEviction {
  evictedTrades: number;
  evictedTradeSignals: number;
  since: string; // window-start date (yyyy-MM-dd) or "app restart"
  note?: string;
  error?: string;
}

// Live-trade day-rollover archive (Administration → Data Retention). Last-run result of the
// LiveTradeArchiveJob + current archive-table row counts. See LIVE_TRADES_RETENTION_DESIGN.md.
export interface SystemStatusArchive {
  state: string; // IDLE | RUNNING | DONE | FAILED | CANCELLED
  trigger?: string | null; // DAY_INIT | MANUAL | null (never run)
  lastStartedAt?: string | null;
  lastFinishedAt?: string | null;
  lastTradesArchived: number;
  lastSignalsArchived: number;
  lastTradesPurged: number;
  lastSignalsPurged: number;
  lastError?: string | null;
  enabled: boolean;
  retentionDays: number;
  archivedTradesTotal: number;
  archivedSignalsTotal: number;
  error?: string;
}

export interface SystemStatus {
  generatedAt: string;
  runtime: SystemStatusRuntime;
  sizing?: SystemStatusSizing;
  /** Live threads grouped by normalised name prefix, largest first. */
  threadsByPrefix?: Record<string, number>;
  httpServer?: SystemStatusHttpServer;
  websocket?: SystemStatusWebSocket;
  tradeProcessors: SystemStatusTradeProcessors;
  todayTrades?: SystemStatusTodayTrades;
  ticker: SystemStatusTicker;
  strategyEngine: SystemStatusStrategyEngine;
  subscriptions: SystemStatusSubscriptions;
  userBrokers: SystemStatusUserBrokers;
  brokers: SystemStatusBrokers;
  exchanges: SystemStatusExchanges;
  rms: SystemStatusRms;
  licenses: SystemStatusLicenses;
  queues?: SystemStatusQueue[];
  eviction?: SystemStatusEviction;
  archive?: SystemStatusArchive;
  brokerDistribution?: SystemStatusBrokerDist[];
}

export interface SystemStatusProbeResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
  lastPrice?: number;
  candles?: number;
  interval?: string;
}

export interface SystemStatusHealthCheck {
  symbol: string;
  providerMode: string;
  quote: SystemStatusProbeResult;
  history: SystemStatusProbeResult;
}

export interface InitTimelineEvent {
  timestamp: string;
  message: string;
}

export interface InitTimeline {
  appStartup: InitTimelineEvent[];
  dailyInit: InitTimelineEvent[];
}

export const systemStatusService = {
  // Full status snapshot
  async getStatus(): Promise<SystemStatus> {
    return api.get<SystemStatus>(API_ENDPOINTS.V2_SYSTEM_STATUS.STATUS);
  },

  // On-demand NIFTY 50 quote + history probe
  async runHealthCheck(): Promise<SystemStatusHealthCheck> {
    return api.get<SystemStatusHealthCheck>(API_ENDPOINTS.V2_SYSTEM_STATUS.HEALTH_CHECK);
  },

  // In-memory startup / daily-init task timeline (newest-first)
  async getInitTimeline(): Promise<InitTimeline> {
    return api.get<InitTimeline>(API_ENDPOINTS.V2_SYSTEM_STATUS.INIT_TIMELINE);
  },
};

// ==================== DATA RETENTION (Administration → Data Retention) ====================

// Live-trade archive job status (GET /api/v2/data-retention/live-trade-archive). The single global
// LiveTradeArchiveJob — status is in-memory only (lost on restart, safe to re-run). See
// LIVE_TRADES_RETENTION_DESIGN.md.
export interface LiveTradeArchiveStatus {
  state: 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED';
  trigger?: 'DAY_INIT' | 'MANUAL' | null;
  jobId: number;
  startedAtMs: number;
  finishedAtMs: number;
  tradesArchived: number;
  signalsArchived: number;
  tradesPurged: number;
  signalsPurged: number;
  error?: string | null;
  enabled: boolean;
  retentionDays: number;
}

// POST response when starting the job.
export interface StartLiveTradeArchiveResponse {
  started: boolean;
  jobId: number;
  reason?: string | null;
  status: LiveTradeArchiveStatus;
}

export const dataRetentionService = {
  // Current live-trade archive job status (poll while RUNNING).
  async getArchiveStatus(): Promise<LiveTradeArchiveStatus> {
    return api.get<LiveTradeArchiveStatus>(API_ENDPOINTS.V2_DATA_RETENTION.LIVE_TRADE_ARCHIVE);
  },

  // Start the live-trade archive rollover (refused with 409 if a job is already in progress).
  async startArchive(): Promise<StartLiveTradeArchiveResponse> {
    return api.post<StartLiveTradeArchiveResponse>(API_ENDPOINTS.V2_DATA_RETENTION.LIVE_TRADE_ARCHIVE);
  },
};

// ==================== MOCK CLEANUP (Administration → Mock Cleanup) ====================

export interface MockTradeRow {
  tradeId: string;
  username: string;
  broker: string;
  strategyName: string;
  tradeGroup: string;
  exchange: string;
  tradingSymbol: string;
  product: string | null;
  state: string | null;
  entry: number;
  quantity: number;
  filledQuantity: number;
  tranch: number;
  signalId: string | null;
  startTimestamp: string | null;
}

export interface MockCleanupList {
  trades: MockTradeRow[];
  count: number;
  mockSessionActive: boolean;
}

export interface MockCleanupResult {
  tradesDeleted: number;
  signalsDeleted: number;
}

export interface MockTerminalizeResult {
  completed: number;
  cancelled: number;
  total: number;
}

export const mockCleanupService = {
  // List all ACTIVE/OPEN mock trades from LIVE_TRADES (needs TRADES View).
  async listMockTrades(): Promise<MockCleanupList> {
    return api.get<MockCleanupList>(API_ENDPOINTS.V2_MOCK_CLEANUP.BASE);
  },

  // Delete ALL mock trades + signals from LIVE_TRADES* (needs TRADES Manage; 409 while a mock session is active).
  async clean(): Promise<MockCleanupResult> {
    return api.delete<MockCleanupResult>(API_ENDPOINTS.V2_MOCK_CLEANUP.BASE);
  },

  // Set ACTIVE/OPEN mock trades terminal by SYSTEM (ACTIVE→COMPLETED, OPEN→CANCELLED) + evict, instead of
  // hard-deleting (needs TRADES Manage; 409 while a mock session is active).
  async terminalize(): Promise<MockTerminalizeResult> {
    return api.post<MockTerminalizeResult>(API_ENDPOINTS.V2_MOCK_CLEANUP.TERMINALIZE);
  },
};

// ==================== USER AUTH MANAGEMENT (Standalone mode) ====================

export interface UserAuthRecord {
  username: string;
  email: string;
  fullName: string;
  phone: string;
  role: string;
  isActive: boolean;
  isEmailVerified: boolean;
  isSysadmin: boolean;
  failedLoginAttempts: number;
  lockedUntil: number | null;
  lastLoginAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CreateUserAuthRequest {
  username: string;
  password: string;
  email?: string;
  fullName?: string;
  phone?: string;
  role?: string;
  isSysadmin?: boolean;
}

export interface UpdateUserAuthRequest {
  email?: string;
  fullName?: string;
  phone?: string;
  role?: string;
  isEmailVerified?: boolean;
  isSysadmin?: boolean;
}

export const userAuthService = {
  async getAll(): Promise<UserAuthRecord[]> {
    return api.get<UserAuthRecord[]>(API_ENDPOINTS.V2_USER_AUTH.LIST);
  },

  async get(username: string): Promise<UserAuthRecord> {
    return api.get<UserAuthRecord>(API_ENDPOINTS.V2_USER_AUTH.DETAILS(username));
  },

  async create(data: CreateUserAuthRequest): Promise<UserAuthRecord> {
    return api.post<UserAuthRecord>(API_ENDPOINTS.V2_USER_AUTH.BASE, data);
  },

  async update(username: string, data: UpdateUserAuthRequest): Promise<UserAuthRecord> {
    return api.put<UserAuthRecord>(API_ENDPOINTS.V2_USER_AUTH.DETAILS(username), data);
  },

  async delete(username: string): Promise<void> {
    return api.delete(API_ENDPOINTS.V2_USER_AUTH.DETAILS(username));
  },

  async resetPassword(username: string, newPassword: string): Promise<void> {
    return api.post(API_ENDPOINTS.V2_USER_AUTH.RESET_PASSWORD(username), { newPassword });
  },

  async toggleActive(username: string): Promise<{ username: string; isActive: boolean }> {
    return api.put(API_ENDPOINTS.V2_USER_AUTH.TOGGLE_ACTIVE(username), {});
  },
};

// Export all services as a unified admin service
// ==================== LICENSE ====================

const licenseService = {
  // Get all licenses for the configured owner from license server
  async getOwnerLicenses(): Promise<{ success: boolean; ownerEmail: string; licenses: any[]; error?: string }> {
    return api.get(API_ENDPOINTS.V2_LICENSE_OWNER);
  },

  // Request new license keys from the license server
  async requestLicenses(count: number, startDate?: string, endDate?: string): Promise<{ success: boolean; count?: number; licenses?: any[]; error?: string }> {
    return api.post(API_ENDPOINTS.V2_LICENSE_REQUEST, { count, startDate, endDate });
  },

  // Cancel (deactivate) N unassigned licenses — sets end_date for billing, never deletes
  async cancelLicenses(count: number): Promise<{ success: boolean; cancelled?: number; licenses?: any[]; error?: string }> {
    return api.post(API_ENDPOINTS.V2_LICENSE_CANCEL, { count });
  },
};

// ==================== Email Templates ====================

import type {
  EmailTemplateOverride,
  UpdateEmailTemplateRequest,
  EmailBrandingConfig,
  UserEmailPreferences,
  EmailPreferenceCategory,
} from '@/types/email';

const emailTemplateService = {
  async getAll(): Promise<EmailTemplateOverride[]> {
    return api.get(API_ENDPOINTS.V2_EMAIL_TEMPLATES.LIST);
  },

  async getByKey(key: string): Promise<EmailTemplateOverride> {
    return api.get(API_ENDPOINTS.V2_EMAIL_TEMPLATES.DETAILS(key));
  },

  async update(key: string, data: UpdateEmailTemplateRequest): Promise<EmailTemplateOverride> {
    return api.put(API_ENDPOINTS.V2_EMAIL_TEMPLATES.DETAILS(key), data);
  },

  async getDefaults(key: string): Promise<{ subject: string; html: string; text: string }> {
    return api.get(API_ENDPOINTS.V2_EMAIL_TEMPLATES.DEFAULTS(key));
  },

  async resetToDefault(key: string): Promise<EmailTemplateOverride> {
    return api.post(API_ENDPOINTS.V2_EMAIL_TEMPLATES.RESET(key), {});
  },

  async setEnabled(key: string, enabled: boolean): Promise<EmailTemplateOverride> {
    const action = enabled ? 'enable' : 'disable';
    return api.post(API_ENDPOINTS.V2_EMAIL_TEMPLATES.ACTION(key, action), {});
  },
};

export const emailPreferencesService = {
  async get(): Promise<UserEmailPreferences> {
    return api.get(API_ENDPOINTS.V2_EMAIL_PREFERENCES.SELF);
  },

  async update(data: Partial<UserEmailPreferences>): Promise<UserEmailPreferences> {
    return api.put(API_ENDPOINTS.V2_EMAIL_PREFERENCES.SELF, data);
  },

  async getForUser(username: string): Promise<UserEmailPreferences> {
    return api.get(API_ENDPOINTS.V2_EMAIL_PREFERENCES.FOR_USER(username));
  },

  async updateForUser(username: string, data: Partial<UserEmailPreferences>): Promise<UserEmailPreferences> {
    return api.put(API_ENDPOINTS.V2_EMAIL_PREFERENCES.FOR_USER(username), data);
  },

  async getAvailableCategories(): Promise<EmailPreferenceCategory[]> {
    return api.get(API_ENDPOINTS.V2_EMAIL_PREFERENCES.AVAILABLE_CATEGORIES);
  },
};

const emailBrandingService = {
  async get(): Promise<EmailBrandingConfig> {
    return api.get(API_ENDPOINTS.V2_EMAIL_BRANDING.BASE);
  },

  async update(data: EmailBrandingConfig): Promise<EmailBrandingConfig> {
    return api.put(API_ENDPOINTS.V2_EMAIL_BRANDING.BASE, data);
  },
};

export const v2AdminService = {
  users: userManagementService,
  userBrokers: userBrokerService,
  userCapital: userCapitalService,
  userEventDayActions: userEventDayActionService,
  productEventDayActions: productEventDayActionService,
  strategyEventDayActions: strategyEventDayActionService,
  userBills: userBillsService,
  rmsConfig: rmsConfigService,
  auditLogs: auditLogService,
  exchanges: exchangeService,
  holidays: holidayService,
  eventDays: eventDayService,
  specialTradingDays: specialTradingDayService,
  mockTradingDays: mockTradingDayService,
  brokerExchangeConfigs: brokerExchangeConfigService,
  brokerStrategyConfigs: brokerStrategyConfigService,
  strategyDaysAllocation: strategyDaysAllocationService,
  billingPlans: billingPlanService,
  brokeragePlans: brokeragePlanService,
  brokeragePlanRates: brokeragePlanRateService,
  statutoryCharges: statutoryChargesService,
  allocationModels: allocationModelService,
  faqs: faqService,
  trades: tradeService,
  eodPnl: eodPnlService,
  capitalHistory: capitalHistoryService,
  unAccountedPnl: unAccountedPnlService,
  userMargins: userMarginService,
  brokerLoginStatus: brokerLoginStatusService,
  brokerApiStats: brokerApiStatsService,
  brokers: v2BrokerService,
  analytics: analyticsService,
  systemConfig: systemConfigService,
  symbols: symbolService,
  symbolBrokerConfigs: symbolBrokerConfigService,
  marketDataSync: marketDataSyncService,
  strategyPolicies: strategyPolicyService,
  brokerInstruments: brokerInstrumentsService,
  cache: cacheService,
  userAuth: userAuthService,
  license: licenseService,
  emailTemplates: emailTemplateService,
  emailBranding: emailBrandingService,
  emailPreferences: emailPreferencesService,
};
