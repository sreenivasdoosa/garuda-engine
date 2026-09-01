import { api } from '@/api/client';
import type {
  LiveCompletedIdsResponse,
  LivePositionsResponse,
  LiveStateResponse,
  LiveSummaryResponse,
  LiveTradePageResponse,
  LiveTradesResponse,
  TradingModeFilter,
} from '@/types/user-live';

/**
 * REST client for the user-portal live API. The live summary page sources its data from the
 * split endpoints (docs/USER_PORTAL_REST_LOAD_OPTIMIZATION_DESIGN.md):
 *   - /summary       O(1) realized + counts + capital + margins (poll, first paint)
 *   - /active        open+active trades (poll, live-tracked set)
 *   - /completed     keyset-paged today's completed (LAZY — history tab / scroll)
 *   - /completed/ids index-only id list (reconciliation)
 *   - /cancelled     today's cancelled (LAZY — cancelled tab)
 *   - /positions     algo + broker positions (compare tab)
 * Polling-grade on the server: in-memory only, never a broker API call.
 */
const USER_LIVE_ENDPOINTS = {
  SUMMARY: '/api/v2/me/live/summary',
  ACTIVE: '/api/v2/me/live/active',
  COMPLETED: '/api/v2/me/live/completed',
  COMPLETED_IDS: '/api/v2/me/live/completed/ids',
  CANCELLED: '/api/v2/me/live/cancelled',
  POSITIONS: '/api/v2/me/live/positions',
  TRADES: '/api/v2/me/live/trades',
  STATE: '/api/v2/me/live/state',
};

export interface LiveQueryOptions {
  broker?: string;
  status?: 'active' | 'completed' | 'all';
  mode?: TradingModeFilter;
}

export interface CompletedPageOptions {
  broker?: string;
  mode?: TradingModeFilter;
  /** Compound keyset cursor from the previous page's nextCursor / nextCursorId. */
  cursor?: number | null;
  cursorId?: string | null;
  limit?: number;
}

function baseParams(options?: LiveQueryOptions): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (options?.broker) params.broker = options.broker;
  if (options?.status) params.status = options.status;
  if (options?.mode) params.mode = options.mode;
  return params;
}

export const userLiveService = {
  /** O(1) per-broker realized + counts + capital + margins (Phase 1) — the tiles' source. */
  async getLiveSummary(options?: { broker?: string; mode?: TradingModeFilter }): Promise<LiveSummaryResponse> {
    const params: Record<string, unknown> = {};
    if (options?.broker) params.broker = options.broker;
    if (options?.mode) params.mode = options.mode;
    return api.get<LiveSummaryResponse>(USER_LIVE_ENDPOINTS.SUMMARY, params);
  },

  /** Open+active trades only (Phase 2) — the live-tracked set, per-broker grouped. */
  async getLiveActive(options?: { broker?: string; mode?: TradingModeFilter }): Promise<LiveTradesResponse> {
    const params: Record<string, unknown> = {};
    if (options?.broker) params.broker = options.broker;
    if (options?.mode) params.mode = options.mode;
    return api.get<LiveTradesResponse>(USER_LIVE_ENDPOINTS.ACTIVE, params);
  },

  /** One keyset page of today's COMPLETED trades (Phase 2) — lazy / scroll pagination. */
  async getLiveCompletedPage(options?: CompletedPageOptions): Promise<LiveTradePageResponse> {
    const params: Record<string, unknown> = {};
    if (options?.broker) params.broker = options.broker;
    if (options?.mode) params.mode = options.mode;
    if (options?.cursor != null) params.cursor = options.cursor;
    if (options?.cursorId) params.cursorId = options.cursorId;
    if (options?.limit != null) params.limit = options.limit;
    return api.get<LiveTradePageResponse>(USER_LIVE_ENDPOINTS.COMPLETED, params);
  },

  /** Index-only id list of today's completed (Phase 4) — delta-sync reconciliation. */
  async getLiveCompletedIds(options?: { broker?: string; mode?: TradingModeFilter }): Promise<LiveCompletedIdsResponse> {
    const params: Record<string, unknown> = {};
    if (options?.broker) params.broker = options.broker;
    if (options?.mode) params.mode = options.mode;
    return api.get<LiveCompletedIdsResponse>(USER_LIVE_ENDPOINTS.COMPLETED_IDS, params);
  },

  /** Today's CANCELLED trades (Phase 2) — lazy, single capped read. */
  async getLiveCancelled(options?: { broker?: string; mode?: TradingModeFilter; limit?: number }): Promise<LiveTradePageResponse> {
    const params: Record<string, unknown> = {};
    if (options?.broker) params.broker = options.broker;
    if (options?.mode) params.mode = options.mode;
    if (options?.limit != null) params.limit = options.limit;
    return api.get<LiveTradePageResponse>(USER_LIVE_ENDPOINTS.CANCELLED, params);
  },

  /** Algo + broker positions (compare tab). */
  async getLivePositions(options?: LiveQueryOptions): Promise<LivePositionsResponse> {
    return api.get<LivePositionsResponse>(USER_LIVE_ENDPOINTS.POSITIONS, baseParams(options));
  },

  /** Targeted trades refetch (e.g. after a tradeUpdate for an unknown tradeID). */
  async getLiveTrades(options?: LiveQueryOptions): Promise<LiveTradesResponse> {
    const params = baseParams(options);
    params.status = options?.status ?? 'all';
    return api.get<LiveTradesResponse>(USER_LIVE_ENDPOINTS.TRADES, params);
  },

  /** Legacy combined snapshot — retained as a fallback/compat composite (not the portal path). */
  async getLiveState(options?: LiveQueryOptions): Promise<LiveStateResponse> {
    const params = baseParams(options);
    params.include = 'trades,positions,margins';
    params.status = options?.status ?? 'all';
    return api.get<LiveStateResponse>(USER_LIVE_ENDPOINTS.STATE, params);
  },
};
