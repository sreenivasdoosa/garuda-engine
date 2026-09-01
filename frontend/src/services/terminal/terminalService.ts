/**
 * Terminal Service
 * API calls for the trading terminal
 */

import { api } from '@/api/client';
import type {
  UserTradeSummary,
  UserTradeDetails,
  TerminalBreakdown,
  TerminalSquareOffRequest,
  AlterTradeRequest,
  BulkCompleteTradeItem,
  BulkCompleteTradeResult,
  ActiveTradeCatalogItem,
  ExitPositionRequest,
  RefreshSummaryRequest,
  TerminalActionResult,
  ExitPositionsResponse,
  TradeSignal,
  OrderDetails,
  ExternalPnlLiveDetails,
  SquareOffStartResponse,
  SquareOffJobStatus,
} from '@/types/terminal';
import type { SquareOffProduct } from '@/types/product';

const BASE_URL = '/api/v2/terminal';
const TRADES_URL = '/api/v2/trades';
const POSITIONS_URL = '/api/v2/positions';

/** Fleet-wide square-off preview counts (all accessible users), for the confirmation modals. */
export interface SquareOffPreview {
  totalActiveTrades: number;
  usersWithActiveCount: number;
  byProduct: Record<string, number>; // e.g. { INTRADAY: 1234, POSITIONAL: 56, CASHBUY: 7, MTF: 2 }
  byStrategy: { strategy: string; product: string; activeTrades: number }[];
}

// The user-broker details endpoint fetches live broker positions + margins and
// can legitimately take 10-15s on a slow link. Bound it at 20s so a hung request
// fails (and the caller's single-flight latch releases) instead of stalling forever.
const DETAILS_REQUEST_TIMEOUT_MS = 20_000;

/** Map a settled scoped-detail fetch to a section status, with a friendly timeout message. */
const settledToStatus = (
  r: PromiseSettledResult<unknown>
): { status: 'ok' | 'error'; message?: string } => {
  if (r.status === 'fulfilled') {
    return { status: 'ok' };
  }
  const reason = r.reason as { message?: string } | undefined;
  const raw = (reason && typeof reason === 'object' && reason.message) ? String(reason.message) : 'Failed to load';
  const isTimeout = /timeout|timed out|ECONNABORTED/i.test(raw);
  return { status: 'error', message: isTimeout ? 'Request timed out. Please retry.' : raw };
};

export const terminalService = {
  /**
   * Get live summaries for an EXPLICIT list of (username, broker) rows — the rows the
   * admin is currently viewing. The server computes ONLY these (demand-driven), and the
   * live WS stream (setSummaryScope) keeps the SAME set in sync. The LIST + pagination of
   * which user-brokers exist comes from userBrokerService.getPaginated, not here.
   * Max 200 rows (server rejects more).
   */
  getSummaries: async (userBrokers: { username: string; broker: string }[]): Promise<UserTradeSummary[]> => {
    if (!userBrokers || userBrokers.length === 0) {
      return [];
    }
    // POST (not GET): the (username,broker) batch rides in the body — a large list in the
    // query string overflowed the request-line limit (HTTP 431). Still a READ on the server.
    return api.post<UserTradeSummary[]>(`${BASE_URL}/summaries`, { userBrokers });
  },

  // Fleet-wide active-trade counts (ALL accessible users, not the current page) for the
  // square-off confirmation modals: total, by product, and by strategy.
  getSquareOffPreview: async (): Promise<SquareOffPreview> => {
    return api.get<SquareOffPreview>(`${BASE_URL}/squareoff-preview`);
  },

  getActiveTradesCatalog: async (filters?: {
    username?: string;
    broker?: string;
    strategy?: string;
    symbol?: string;
  }): Promise<ActiveTradeCatalogItem[]> => {
    const params: Record<string, string> = {};
    if (filters?.username) params.username = filters.username;
    if (filters?.broker) params.broker = filters.broker;
    if (filters?.strategy) params.strategy = filters.strategy;
    if (filters?.symbol) params.symbol = filters.symbol;
    return api.get<ActiveTradeCatalogItem[]>(`${BASE_URL}/active-trades`, params);
  },

  getActiveSymbols: async (filters?: {
    username?: string;
    broker?: string;
    strategy?: string;
  }): Promise<string[]> => {
    const params: Record<string, string> = {};
    if (filters?.username) params.username = filters.username;
    if (filters?.broker) params.broker = filters.broker;
    if (filters?.strategy) params.strategy = filters.strategy;
    return api.get<string[]>(`${BASE_URL}/active-symbols`, params);
  },

  /**
   * The terminal detail panel is fetched as THREE independent, permission-gated endpoints
   * (trades → TRADES, positions → POSITIONS, margins → MARGINS), each user-scoped server-side.
   * getScopedDetails fires only the permitted ones in parallel and merges them into the same
   * UserTradeDetails shape the UI already consumes. (The old combined /details endpoint was removed.)
   */
  getTrades: async (username: string, broker: string): Promise<UserTradeDetails> => {
    return api.get<UserTradeDetails>(
      `${BASE_URL}/users/${username}/brokers/${broker}/trades`,
      undefined,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  getPositions: async (
    username: string,
    broker: string,
    options?: { fetchBrokerPositions?: boolean; force?: boolean }
  ): Promise<UserTradeDetails> => {
    const params: Record<string, unknown> = {};
    if (options?.fetchBrokerPositions) params.fetchBrokerPositions = true;
    if (options?.force) params.force = true;
    return api.get<UserTradeDetails>(
      `${BASE_URL}/users/${username}/brokers/${broker}/positions`,
      params,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  getMargins: async (
    username: string,
    broker: string,
    options?: { force?: boolean }
  ): Promise<UserTradeDetails> => {
    const params: Record<string, unknown> = {};
    if (options?.force) params.force = true;
    return api.get<UserTradeDetails>(
      `${BASE_URL}/users/${username}/brokers/${broker}/margins`,
      params,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  /**
   * Fetch the detail panel for a user-broker by calling only the endpoints the caller is
   * permitted for (allow), in parallel, and merging into one UserTradeDetails. Sections the
   * user can't view come back empty. fetchBrokerPositions/force control the positions+margins
   * broker fetch (force=true only on an explicit refresh; expand uses cache).
   */
  getScopedDetails: async (
    username: string,
    broker: string,
    allow: { trades: boolean; positions: boolean; margins: boolean },
    options?: { fetchBrokerPositions?: boolean; force?: boolean }
  ): Promise<UserTradeDetails> => {
    const fetchBrokerPositions = options?.fetchBrokerPositions ?? true;
    const force = options?.force ?? false;

    // allSettled so one failing section doesn't blank the others — each section's outcome is
    // recorded in sectionStatus and rendered in its own tab.
    const [tradesR, positionsR, marginsR] = await Promise.allSettled([
      allow.trades ? terminalService.getTrades(username, broker) : Promise.resolve(null),
      allow.positions ? terminalService.getPositions(username, broker, { fetchBrokerPositions, force }) : Promise.resolve(null),
      allow.margins ? terminalService.getMargins(username, broker, { force }) : Promise.resolve(null),
    ]);

    const valueOf = (r: PromiseSettledResult<UserTradeDetails | null>): UserTradeDetails | null =>
      r.status === 'fulfilled' ? r.value : null;
    const tradesRes = valueOf(tradesR);
    const positionsRes = valueOf(positionsR);
    const marginsRes = valueOf(marginsR);
    const base = tradesRes || positionsRes || marginsRes;

    // Build the per-section status only for sections that were attempted (permitted).
    const sectionStatus: NonNullable<UserTradeDetails['sectionStatus']> = {};
    if (allow.trades) sectionStatus.trades = settledToStatus(tradesR);
    if (allow.positions) sectionStatus.positions = settledToStatus(positionsR);
    if (allow.margins) sectionStatus.margins = settledToStatus(marginsR);

    return {
      username,
      broker,
      clientID: base?.clientID,
      openTrades: tradesRes?.openTrades ?? [],
      activeTrades: tradesRes?.activeTrades ?? [],
      completedTrades: tradesRes?.completedTrades ?? [],
      cancelledTrades: tradesRes?.cancelledTrades ?? [],
      trackLostTrades: tradesRes?.trackLostTrades ?? [],
      algoPositions: positionsRes?.algoPositions ?? [],
      brokerPositions: positionsRes?.brokerPositions ?? [],
      mismatches: positionsRes?.mismatches ?? [],
      margins: marginsRes?.margins,
      peakMargins: marginsRes?.peakMargins,
      sectionStatus,
    } as UserTradeDetails;
  },

  /**
   * Risk profiles for a user-broker (RISK_PROFILES View) — lazy, fetched when the Risk Profile tab
   * is opened. force=true forces a fresh broker fetch; default uses cache.
   */
  getRiskProfiles: async (
    username: string,
    broker: string,
    options?: { fetchBrokerPositions?: boolean; force?: boolean }
  ): Promise<TerminalBreakdown> => {
    const params: Record<string, unknown> = {};
    if (options?.fetchBrokerPositions === false) params.fetchBrokerPositions = false;
    if (options?.force) params.force = true;
    return api.get<TerminalBreakdown>(
      `${BASE_URL}/users/${username}/brokers/${broker}/risk-profiles`,
      params,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  /**
   * Strategy summaries for a user-broker (STRATEGY_SUMMARIES View) — lazy, fetched when the
   * Strategy Summaries tab is opened.
   */
  getStrategySummaries: async (
    username: string,
    broker: string
  ): Promise<TerminalBreakdown> => {
    return api.get<TerminalBreakdown>(
      `${BASE_URL}/users/${username}/brokers/${broker}/strategy-summaries`,
      undefined,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  /**
   * Fleet-wide strategy + risk breakdown for the given user-brokers (TERMINAL View) — fetched when
   * the Overall Summary modal opens. Mirrors getSummaries' userBrokers JSON param.
   */
  getOverallBreakdown: async (
    userBrokers: { username: string; broker: string }[]
  ): Promise<TerminalBreakdown[]> => {
    if (!userBrokers || userBrokers.length === 0) {
      return [];
    }
    // POST (not GET): batch list in the body to avoid HTTP 431. READ on the server.
    return api.post<TerminalBreakdown[]>(
      `${BASE_URL}/overall-breakdown`,
      { userBrokers },
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  /**
   * Get trade signals for a specific user-broker
   * Returns signals sorted by signalGenerationTime descending (latest first)
   */
  getTradeSignals: async (
    username: string,
    broker: string
  ): Promise<TradeSignal[]> => {
    return api.get<TradeSignal[]>(
      `${BASE_URL}/users/${username}/brokers/${broker}/signals`
    );
  },

  /**
   * Get order book for a specific user-broker
   * Returns all orders from the broker's order book for today
   */
  getOrderBook: async (
    username: string,
    broker: string
  ): Promise<OrderDetails[]> => {
    return api.get<OrderDetails[]>(
      `${BASE_URL}/users/${username}/brokers/${broker}/orders`
    );
  },

  /**
   * Get LIVE external (manual) intraday P&L for a specific user-broker.
   * Computed on demand from the current order book (force-fetched server-side), incl. mark-to-market
   * of open positions at CMP and an itemised charge breakdown. Safe to call anytime.
   */
  getExternalPnl: async (
    username: string,
    broker: string
  ): Promise<ExternalPnlLiveDetails> => {
    return api.get<ExternalPnlLiveDetails>(
      `${BASE_URL}/users/${username}/brokers/${broker}/external-pnl`,
      undefined,
      { timeout: DETAILS_REQUEST_TIMEOUT_MS }
    );
  },

  /**
   * Force refresh summary for a specific user-broker
   */
  refreshSummary: async (request: RefreshSummaryRequest): Promise<UserTradeSummary> => {
    return api.post<UserTradeSummary>(
      `${BASE_URL}/users/${request.username}/brokers/${request.broker}/refresh`,
      request
    );
  },

  /**
   * Full refresh - POSTs the summary refresh and fetches the permitted detail sections in
   * parallel. Returns both the updated summary and the (scoped) details.
   */
  fullRefresh: async (
    username: string,
    broker: string,
    allow: { trades: boolean; positions: boolean; margins: boolean },
    options?: { fetchBrokerPositions?: boolean; force?: boolean }
  ): Promise<{ summary: UserTradeSummary; details: UserTradeDetails }> => {
    const [summary, details] = await Promise.all([
      api.post<UserTradeSummary>(
        `${BASE_URL}/users/${username}/brokers/${broker}/refresh`,
        { username, broker, fetchBrokerPositions: true }
      ),
      terminalService.getScopedDetails(username, broker, allow, options),
    ]);

    return { summary, details };
  },

  /**
   * Square off all positions for a user-broker.
   * Bulk square-off is asynchronous: the server returns a jobId immediately and
   * runs the work on a background thread (poll getSquareOffStatus for progress).
   */
  squareOff: async (request: TerminalSquareOffRequest): Promise<SquareOffStartResponse> => {
    const product = request.product.toLowerCase();
    return api.post<SquareOffStartResponse>(`${TRADES_URL}/squareoff/${product}`, {
      username: request.username,
      broker: request.broker,
      clientID: request.clientID,
      strategies: request.strategies,
    });
  },

  /**
   * Square off all positions for ALL users accessible by the requesting user.
   * Asynchronous - returns a jobId for polling.
   * @param product - a tradable product (INTRADAY/POSITIONAL/CASHBUY/MTF) or 'ALL'
   * @param broker - broker name (required)
   */
  squareOffAll: async (product: SquareOffProduct, broker: string): Promise<SquareOffStartResponse> => {
    const productPath = product.toLowerCase();
    return api.post<SquareOffStartResponse>(`${TRADES_URL}/squareoff/${productPath}`, {
      username: 'all',
      broker,
    });
  },

  /**
   * Square off positions for specific strategies across ALL users.
   * Asynchronous - returns a jobId for polling.
   * @param strategies - Array of strategy names to square off
   */
  squareOffByStrategies: async (strategies: string[]): Promise<SquareOffStartResponse> => {
    return api.post<SquareOffStartResponse>(`${TRADES_URL}/squareoff/all`, {
      username: 'all',
      broker: 'all',
      strategies,
    });
  },

  /**
   * Poll the status of an async bulk square-off job.
   */
  getSquareOffStatus: async (jobId: string): Promise<SquareOffJobStatus> => {
    return api.get<SquareOffJobStatus>(`${TRADES_URL}/squareoff/status/${jobId}`);
  },

  /**
   * Alter trades (complete, reset, alter exit price)
   */
  alterTrades: async (request: AlterTradeRequest): Promise<TerminalActionResult> => {
    return api.post<TerminalActionResult>(`${TRADES_URL}/alter`, request);
  },

  /**
   * Alter the exit price of an ALREADY-COMPLETED (terminal) trade. Recalculates
   * P&L + charges server-side and regenerates the EOD report. Operates on one
   * trade at a time (the backend `alterExitPrice` operation has no bulk form).
   * @param username - User's username
   * @param broker - Broker name
   * @param tradeID - Trade ID to alter
   * @param exitPrice - New exit price
   */
  alterExitPrice: async (
    username: string,
    broker: string,
    tradeID: string,
    exitPrice: number
  ): Promise<TerminalActionResult> => {
    return api.post<TerminalActionResult>(`${TRADES_URL}/alter`, {
      username,
      broker,
      tradeID,
      operation: 'alterExitPrice',
      exitPrice,
    });
  },

  /**
   * Set a single trade as complete
   * @param username - User's username
   * @param broker - Broker name
   * @param tradeID - Trade ID to complete
   * @param exitPrice - Exit price for the trade
   * @param exitDate - Exit date (YYYY-MM-DD format, required for positional/cashbuy)
   */
  completeTrade: async (
    username: string,
    broker: string,
    tradeID: string,
    exitPrice: number,
    exitDate?: string
  ): Promise<TerminalActionResult> => {
    return api.post<TerminalActionResult>(`${TRADES_URL}/alter`, {
      username,
      broker,
      tradeID,
      operation: 'completeTrade',
      exitPrice,
      exitDate,
    });
  },

  /**
   * Set multiple trades as complete in a single request
   */
  completeTradesBulk: async (
    username: string,
    broker: string,
    trades: BulkCompleteTradeItem[]
  ): Promise<BulkCompleteTradeResult[]> => {
    return api.post<BulkCompleteTradeResult[]>(`${TRADES_URL}/alter`, {
      username,
      broker,
      operation: 'completeTradeBulk',
      trades,
    });
  },

  /**
   * Square off a single trade by tradeID
   * @param username - User's username
   * @param broker - Broker name
   * @param tradeID - Trade ID to square off
   * @param product - a tradable product (INTRADAY/POSITIONAL/CASHBUY/MTF) or 'ALL'
   */
  squareOffTrade: async (
    username: string,
    broker: string,
    tradeID: string,
    product: SquareOffProduct = 'ALL'
  ): Promise<TerminalActionResult> => {
    const productPath = product.toLowerCase();
    return api.post<TerminalActionResult>(`${TRADES_URL}/squareoff/${productPath}`, {
      username,
      broker,
      tradeID,
    });
  },

  /**
   * Cancel an open trade (trade that is active but not yet filled)
   * @param username - User's username
   * @param broker - Broker name
   * @param tradeID - Trade ID to cancel
   */
  cancelTrade: async (
    username: string,
    broker: string,
    tradeID: string
  ): Promise<TerminalActionResult> => {
    return api.post<TerminalActionResult>(`${TRADES_URL}/alter`, {
      username,
      broker,
      tradeID,
      operation: 'cancelTrade',
    });
  },

  /**
   * Exit specific positions
   */
  exitPositions: async (request: ExitPositionRequest): Promise<ExitPositionsResponse> => {
    return api.post<ExitPositionsResponse>(`${POSITIONS_URL}/exit`, request);
  },

  /**
   * Get algo positions for a user-broker
   */
  getAlgoPositions: async (username: string, broker: string) => {
    return api.get(`${POSITIONS_URL}/algo`, { username, broker });
  },

  /**
   * Get broker positions for a user-broker
   */
  getBrokerPositions: async (username: string, broker: string, force?: boolean) => {
    return api.get(`${POSITIONS_URL}/broker`, { username, broker, force });
  },

  /**
   * Get aggregated PnL snapshots for a specific date
   * @param date - Date string in YYYY-MM-DD format (defaults to today if not provided)
   */
  getPnlChartData: async (date?: string, mode: 'live' | 'paper' = 'live'): Promise<PnlChartResponse> => {
    const params: Record<string, string> = { mode };
    if (date) params.date = date;
    return api.get<PnlChartResponse>(`${BASE_URL}/pnl-chart`, params);
  },

  /**
   * Get aggregated PnL snapshots for a date range
   * @param fromDate - Start date in YYYY-MM-DD format
   * @param toDate - End date in YYYY-MM-DD format
   * @param mode - live or paper snapshot series
   */
  getPnlChartDataRange: async (fromDate: string, toDate: string, mode: 'live' | 'paper' = 'live'): Promise<PnlChartRangeResponse> => {
    return api.get<PnlChartRangeResponse>(`${BASE_URL}/pnl-chart/range`, { fromDate, toDate, mode });
  },

  /**
   * Get PnL chart service status
   */
  getPnlChartStatus: async (): Promise<PnlChartStatus> => {
    return api.get<PnlChartStatus>(`${BASE_URL}/pnl-chart/status`);
  },
};

// Types for PnL chart data
export interface AggregatedPnlSnapshot {
  id: number;
  snapshotDate: string;
  snapshotTimestamp: number; // Epoch milliseconds
  totalAlgoPnl: number;
  totalBrokerPnl: number;
  totalCapital: number;
  totalExternalCapital: number;
  totalMargin: number;
  totalUtilizedMargin: number;
}

export interface PnlChartResponse {
  date: string;
  snapshots: AggregatedPnlSnapshot[];
  count: number;
}

export interface PnlChartRangeResponse {
  fromDate: string;
  toDate: string;
  snapshots: AggregatedPnlSnapshot[];
  count: number;
}

export interface PnlChartStatus {
  isRunning: boolean;
  retentionDays: number;
  snapshotIntervalMs: number;
  todaySnapshotCount: number;
  latestSnapshot?: AggregatedPnlSnapshot;
}

export default terminalService;
