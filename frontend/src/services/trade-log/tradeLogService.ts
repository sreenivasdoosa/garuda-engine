import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  TradeLogEntry,
  TradeLogFilterParams,
  TradeLogFilters,
  TradeLogPageResponse,
} from '@/types/tradeLog';

export const tradeLogService = {
  /**
   * Paginated cross-trade log query with filters.
   */
  async getPaginated(params: TradeLogFilterParams = {}): Promise<TradeLogPageResponse> {
    const qp = new URLSearchParams();
    if (params.page) qp.append('page', String(params.page));
    if (params.pageSize) qp.append('pageSize', String(params.pageSize));
    if (params.tradeId) qp.append('tradeId', params.tradeId);
    if (params.username) qp.append('username', params.username);
    if (params.broker) qp.append('broker', params.broker);
    if (params.strategy) qp.append('strategy', params.strategy);
    if (params.tradingSymbol) qp.append('tradingSymbol', params.tradingSymbol);
    if (params.eventCategory) qp.append('eventCategory', params.eventCategory);
    if (params.eventType) qp.append('eventType', params.eventType);
    if (params.startTime) qp.append('startTime', params.startTime);
    if (params.endTime) qp.append('endTime', params.endTime);
    if (params.search) qp.append('search', params.search);

    const qs = qp.toString();
    const url = qs ? `${API_ENDPOINTS.V2_TRADE_LOG.BASE}?${qs}` : API_ENDPOINTS.V2_TRADE_LOG.BASE;
    return api.get<TradeLogPageResponse>(url);
  },

  /**
   * Full event timeline for one trade, oldest-first.
   */
  async getByTradeId(tradeId: string): Promise<TradeLogEntry[]> {
    return api.get<TradeLogEntry[]>(API_ENDPOINTS.V2_TRADE_LOG.BY_TRADE(tradeId));
  },

  /**
   * Distinct filter option values for the dropdowns.
   */
  async getFilters(): Promise<TradeLogFilters> {
    return api.get<TradeLogFilters>(API_ENDPOINTS.V2_TRADE_LOG.FILTERS);
  },
};
