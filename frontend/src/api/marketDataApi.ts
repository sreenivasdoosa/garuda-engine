/**
 * Market Data API Service (Standalone mode)
 *
 * API functions for market-data servlets registered under /api/v2/market-data/*.
 * These endpoints return raw JSON (not V2 wrapped), so apiClient passes them through as-is.
 *
 * Uses the `api` helper from client.ts which correctly types the return value
 * (the response interceptor unwraps AxiosResponse → returns data directly).
 */

import { api } from './client';
import apiClient from './client';
import { API_ENDPOINTS } from './endpoints';

// ============ Types ============

export interface Rule {
  id: number;
  exchange: string;
  name: string;
  symbol: string;
  breakoutLevel: number;
  breakoutLevelDT0: number;
  breakoutLevelDT1: number;
  breakoutLevelDT2: number;
  breakoutDirection: string;
  isBreakoutLevelInPercentage: boolean;
  breakoutValidRange: number;
  fromTimestampStr: string;
  fromLastNMins: number;
  fromLevel: number;
}

export interface StrategyRule {
  strategyName: string;
  exchange: string;
  tranch: number;
  condition: string;
  rulesExpr: string;
  dependsOnCond: string | null;
}

export interface SymbolInfo {
  symbol: string;
  indexSymbol: string | null;
  exchange: string;
  isIndex: boolean;
  hasOptionsWeeklyExpiry: boolean;
  hasOptionsMonthlyExpiry: boolean;
  hasFuturesWeeklyExpiry: boolean;
  hasFuturesMonthlyExpiry: boolean;
  strikeGap: number;
  freezeLimitQty: number;
  pcrStrikesEachSide: number;
  contractMultiplier: number;
}

export interface IndexSymbol {
  exchange: string;
  symbol: string;
  referenceSymbol: string;
  fullSymbol: string;
  straddleSymbol: string;
  fullStraddleSymbol: string;
  isFutures: boolean;
}

export interface IndicesResponse {
  status: string;
  indices: IndexSymbol[];
}

export interface Quote {
  exchange: string;
  tradingSymbol: string;
  lastTradedPrice: number;
  lastTradedQty: number;
  lastTradedTimestamp: string | null;
  volumeTradedToday: number;
  averagePrice: number;
  open: number;
  high: number;
  low: number;
  close: number;
  change: number;
  buyQty: number;
  sellQty: number;
  oi: number;
  oiDayHigh: number;
  oiDayLow: number;
  ucLimit: number;
  lcLimit: number;
}

export interface StraddleTickResponse {
  exchange: string;
  symbol: string;
  referenceSymbol: string | null;
  ceSymbol: string;
  peSymbol: string;
  cePrice: number;
  pePrice: number;
  price: number;
  ceOI: number;
  peOI: number;
  timestamp: number | null;
}

export interface SymbolPricePair {
  symbol: string;
  price: number;
}

export interface SignalOutput {
  strategyName: string;
  exchange: string;
  tranch: number;
  condition: string;
  symbolPricesList: SymbolPricePair[];
  lastUpdatedAt: number | null;
  expiresAt: number | null;
}

export interface OHLCCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  tradingSymbol: string;
  timestamp: number;
}

export type HistoryInterval = 'minute' | '3minute' | '5minute' | '10minute' | '15minute' | '30minute' | '60minute' | 'day';

export interface HistoryParams {
  symbol: string;
  from: string;
  to: string;
  interval: HistoryInterval;
}

// ============ Signal Rules API ============

const MD = API_ENDPOINTS.MARKET_DATA;

export const mdRulesApi = {
  getAll: () =>
    api.get<Rule[]>(MD.ADMIN_RULES),
  create: (rule: Omit<Rule, 'id'>) =>
    api.post<Rule>(MD.ADMIN_RULES, rule),
  update: (id: number, rule: Omit<Rule, 'id'>) =>
    api.put<Rule>(MD.ADMIN_RULES_DETAILS(id), rule),
  delete: (id: number) =>
    api.delete(MD.ADMIN_RULES_DETAILS(id)),
};

// ============ Strategy Rules API ============

export const mdStrategyRulesApi = {
  getAll: () =>
    api.get<StrategyRule[]>(MD.ADMIN_STRATEGY_RULES),
  create: (rule: StrategyRule) =>
    api.post<StrategyRule>(MD.ADMIN_STRATEGY_RULES, rule),
  update: (
    oldKey: { strategyName: string; exchange: string; tranch: number; condition: string },
    rule: StrategyRule,
  ) =>
    api.put<StrategyRule>(MD.ADMIN_STRATEGY_RULES, {
      ...rule,
      oldStrategyName: oldKey.strategyName,
      oldExchange: oldKey.exchange,
      oldTranch: oldKey.tranch,
      oldCondition: oldKey.condition,
    }),
  // Delete needs query params, which api.delete doesn't support (it uses body)
  delete: (key: { strategyName: string; exchange: string; tranch: number; condition: string }) =>
    apiClient.delete(MD.ADMIN_STRATEGY_RULES, {
      params: {
        strategyName: key.strategyName,
        exchange: key.exchange,
        tranch: key.tranch,
        condition: key.condition,
      },
    }) as unknown as Promise<void>,
};

// ============ Symbols API ============

export const mdSymbolsApi = {
  getAll: () =>
    api.get<SymbolInfo[]>(MD.ADMIN_SYMBOLS),
};

// ============ Indices API ============

export const mdIndicesApi = {
  getAll: () =>
    api.get<IndicesResponse>(MD.INDICES),
};

// ============ Quotes API ============

export const mdQuotesApi = {
  getQuotes: (symbols: string[]) =>
    api.get<Quote[]>(MD.QUOTES, { symbols: symbols.join(',') }),
};

// ============ Straddle Ticks API ============

export const mdStraddleTicksApi = {
  getLatest: (symbols: string[]) =>
    api.get<StraddleTickResponse[]>(MD.STRADDLE_TICKS, { symbols: symbols.join(',') }),
};

// ============ Signal Outputs API ============

export const mdSignalOutputsApi = {
  getAll: () =>
    api.get<SignalOutput[]>(MD.ADMIN_SIGNAL_OUTPUTS),
};

// ============ History API ============

export const mdHistoryApi = {
  getHistory: (params: HistoryParams) =>
    api.get<OHLCCandle[]>(MD.HISTORY, params as unknown as Record<string, unknown>),
  getStraddleHistory: (params: HistoryParams) =>
    api.get<OHLCCandle[]>(MD.STRADDLE_HISTORY, params as unknown as Record<string, unknown>),
};

// ============ Helper ============

export function getErrorMessage(error: unknown, fallbackMessage: string = 'An error occurred'): string {
  if (error && typeof error === 'object') {
    const err = error as { message?: string; data?: { error?: string; message?: string } };
    if (err.message) return err.message;
    if (err.data?.error) return err.data.error;
    if (err.data?.message) return err.data.message;
  }
  if (error instanceof Error) return error.message;
  return fallbackMessage;
}
