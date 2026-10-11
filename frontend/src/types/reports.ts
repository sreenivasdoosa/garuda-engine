/**
 * Reports and Trading Data type definitions
 * Covers trades, PnL reports, capital changes, broker login status, and broker API stats
 */

import type { TradableProduct } from './product';

// ==================== TRADES ====================

export interface Trade {
  id: string;
  username: string;
  broker: string;
  exchange: string;
  strategy: string;
  symbol: string;
  /** Engine product the trade was taken in — see types/product.ts (INTRADAY/POSITIONAL/CASHBUY/MTF). */
  tradeType: TradableProduct;
  orderType: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  pnl: number;
  brokerage: number;
  netPnl: number;
  status: 'OPEN' | 'CLOSED' | 'PARTIAL';
  entryTime: string;
  exitTime?: string;
  /**
   * Multi-leg fields. Absent on trades taken before the leg model existed, and on any single-leg
   * entry, so every consumer must treat them as optional rather than defaulting them.
   */
  /** Which part this leg played: PRIMARY, HEDGE, LONG_LEG or SHORT_LEG. */
  legRole?: 'PRIMARY' | 'HEDGE' | 'LONG_LEG' | 'SHORT_LEG';
  /** Entry order within the group — lower goes first. 0 means "not sequenced" (pre-M4 rows). */
  entrySequence?: number;
  /** Groups every leg entered together, whatever their product or instrument. */
  comboId?: string;
}

export interface TradeFilter {
  [key: string]: string | boolean | number | undefined;
  username?: string;
  broker?: string;
  exchange?: string;
  strategy?: string;
  /**
   * Product filter for GET /api/trades/{tradeType} (sent lower-cased). Since V306 all products
   * live in one TRADES table, so this is a plain row filter — any tradable product is valid.
   */
  tradeType?: TradableProduct;
  active?: boolean;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

export interface TradeSummary {
  totalTrades: number;
  totalPnl: number;
  totalCharges: number;
  totalNetPnl: number;
}

export interface PaginatedTradesResponse {
  trades: Trade[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary?: TradeSummary;
}

// ==================== PNL REPORTS ====================

export interface EODPnlReport {
  username: string;
  broker: string;
  strategy: string;
  product: string;
  dateStr: string;
  capital: number;
  pl: number;
  charges: number;
  netPL: number;
  /** MTF funding interest — tracked separately, never folded into charges/netPL. */
  mtfInterest?: number;
  isPaperTrading?: boolean;
}

export interface EODPnlFilter {
  [key: string]: string | number | undefined;
  username?: string;
  broker?: string;
  strategy?: string;
  product?: string;
  date?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  pageSize?: number;
}

export interface EODPnlSummary {
  totalRecords: number;
  totalPnl: number;
  totalCharges: number;
  totalNetPnl: number;
}

export interface EODPnlResponse {
  records: EODPnlReport[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  summary: EODPnlSummary;
}

// ==================== CAPITAL CHANGES ====================

export interface CapitalChangeHistory {
  username: string;
  broker: string;
  strategy: string;
  oldCapital: number;
  newCapital: number;
  updatedTimestamp: number; // epoch milliseconds
  updatedBy: string;
}

// ==================== BROKER STATUS ====================

// Note: BrokerLoginStatus is defined in broker.ts

// Individual broker API stat record (raw from database)
export interface BrokerApiStat {
  broker: string;
  operation: string;
  entityId?: string; // orderId, userId, etc.
  startEpoch: number;
  endEpoch: number;
  timeTaken: number;
}

// Aggregated broker API stats (for summary display)
export interface BrokerApiStats {
  broker: string;
  date: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatency: number;
  maxLatency: number;
}

// ==================== GARUDA REPORTS ====================
// Both reports read the trades table the engine writes. Money crosses as
// strings; charges are null until the charges phase, never a zero.

export interface ReportFilters {
  [key: string]: string | boolean | undefined;
  fromDate?: string;
  toDate?: string;
  tradingClientId?: string;
  strategy?: string;
  product?: string;
  /** 'paper' | 'live' | '' for all */
  paper?: string;
  /** Trades only: CLOSED, OPEN, ACTIVE, COMPLETED, CANCELLED, FAILED, or '' for all */
  state?: string;
  /** Daily P&L only: a row per strategy within each day. */
  byStrategy?: boolean;
  byAccount?: boolean;
  byProduct?: boolean;
}

export interface ReportFilterOptions {
  tradingClients: { id: string; displayName: string; broker: string }[];
  strategies: string[];
  products: string[];
  states: string[];
}

export interface ReportTotals {
  trades: number;
  closed: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: string | null;
  grossPnl: string | null;
  charges: string | null;
  netPnl: string | null;
  best: string | null;
  worst: string | null;
}

export interface TradeReportRow {
  tradeId: string;
  tradingClientId: string;
  tradingClient: string | null;
  broker: string | null;
  strategy: string;
  instrumentId: string;
  tradingSymbol: string;
  product: string;
  direction: string;
  isPaper: boolean;
  state: string;
  quantity: number;
  filledQuantity: number;
  entry: string | null;
  exit: string | null;
  startedAt: string | null;
  endedAt: string | null;
  tradingDay: string | null;
  exitReason: string | null;
  failureReason: string | null;
  grossPnl: string | null;
  charges: string | null;
  netPnl: string | null;
  group: string;
  tranche: number;
}

export interface TradesReportResponse {
  fromDate: string;
  toDate: string;
  rows: TradeReportRow[];
  totals: ReportTotals;
  truncated: boolean;
}

export interface DailyPnlRow {
  tradingDay: string;
  tradingClientId: string | null;
  tradingClient: string | null;
  broker: string | null;
  strategy: string | null;
  product: string | null;
  isPaper: boolean;
  trades: number;
  wins: number;
  losses: number;
  grossPnl: string;
  charges: string | null;
  netPnl: string;
}

export interface DailyPnlResponse {
  fromDate: string;
  toDate: string;
  rows: DailyPnlRow[];
  totals: ReportTotals;
  tradingDays: number;
}
