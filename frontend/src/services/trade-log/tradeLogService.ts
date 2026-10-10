import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  TradeLogEntry,
  TradeLogFilterParams,
  TradeLogFilters,
  TradeLogPageResponse,
} from '@/types/tradeLog';

const E = API_ENDPOINTS.TRADE_LOG;

export const tradeLogService = {
  /** The log across trades, freshest first, filtered and paged in SQL. */
  getPaginated: (params: TradeLogFilterParams = {}) =>
    api.get<TradeLogPageResponse>(
      E.BASE,
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')),
    ),

  /** One trade's events, oldest first. */
  getByTradeId: (tradeId: string) => api.get<TradeLogEntry[]>(E.BY_TRADE(tradeId)),

  /** What the dropdowns offer. */
  getFilters: () => api.get<TradeLogFilters>(E.FILTERS),
};
