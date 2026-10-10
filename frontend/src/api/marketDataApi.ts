/**
 * Market Data API Service (Standalone mode)
 *
 * API functions for market-data servlets registered under /api/market-data/*.
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
  /** Whichever instrument actually carries this index's price. */
  fullSymbol: string;
  straddleSymbol: string;
  fullStraddleSymbol: string;
  /** True when the price comes from a future because no level is published. */
  isFutures: boolean;
  /** Whether a cash index exists at all. False on MCX. */
  hasSpot: boolean;
  /** The cash index, when there is one — for a chart overlay. */
  fullSpotSymbol: string | null;
  /** The near-month future, when the master lists one. */
  fullFuturesSymbol: string | null;
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

/**
 * The engine's wire shape for a candle.
 *
 * Prices cross as **strings** and the timestamp as an ISO instant. That is
 * deliberate on the engine's side: it holds prices as exact decimals and JSON
 * has only floats, so serialising a number is where 123.45 quietly becomes
 * 123.44999999999999. A chart can only draw floats, so the conversion happens
 * here, once, at the boundary -- rather than in every component.
 */
interface WireCandle {
  tradingSymbol: string;
  timestamp: string;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: number | null;
}

/**
 * Minutes east of UTC that the Console draws its time axes in.
 *
 * Every venue garuda supports -- NSE, BSE, MCX -- trades on this clock, so one
 * number covers them all. It becomes a per-venue lookup the day a venue in
 * another zone is added; until then a second rule would be untested weight.
 */
const DISPLAY_ZONE_MINUTES = 330; // IST

/**
 * An instant, as the epoch that *reads* as its Indian wall-clock time.
 *
 * Lightweight-charts renders its axis in UTC and offers no timezone, so a
 * chart that should show 09:15 IST has to be handed the epoch that is 09:15
 * in UTC.
 *
 * **One fixed zone, not each string's own offset.** The engine stamps candles
 * in the venue's zone (`+05:30`) and ticks in UTC (`+00:00`) -- the same
 * instant, written two ways. Shifting each by the offset it happens to carry
 * puts them five and a half hours apart, which is exactly far enough that the
 * live price matches no candle on the chart and silently never appears.
 */
export function wallClockEpochMs(iso: string): number {
  return new Date(iso).getTime() + DISPLAY_ZONE_MINUTES * 60_000;
}

/** One wire candle as the chart wants it, or null when it is incomplete. */
function toCandle(wire: WireCandle): OHLCCandle | null {
  const values = [wire.open, wire.high, wire.low, wire.close].map((v) =>
    v === null ? NaN : Number(v),
  );
  if (!values.every(Number.isFinite)) return null;
  const [open, high, low, close] = values;
  return {
    tradingSymbol: wire.tradingSymbol,
    timestamp: wallClockEpochMs(wire.timestamp),
    open,
    high,
    low,
    close,
    volume: wire.volume ?? 0,
  };
}

function toCandles(wire: WireCandle[]): OHLCCandle[] {
  return wire.map(toCandle).filter((c): c is OHLCCandle => c !== null);
}

export const mdHistoryApi = {
  getHistory: (params: HistoryParams) =>
    api
      .get<WireCandle[]>(MD.HISTORY, params as unknown as Record<string, unknown>)
      .then(toCandles),
  getStraddleHistory: (params: HistoryParams) =>
    api
      .get<WireCandle[]>(MD.STRADDLE_HISTORY, params as unknown as Record<string, unknown>)
      .then(toCandles),
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
