import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  Trade,
  Position,
  TradeAction,
  SquareOffRequest,
  TradeFilter,
  TradeSummary,
  DailyPerformance,
  MonthlyPerformance,
  StrategyPerformanceReport,
} from '@/types/trade';

export const tradeService = {
  /**
   * Get trades with filters
   */
  async getTrades(filters?: TradeFilter): Promise<Trade[]> {
    return api.get<Trade[]>(API_ENDPOINTS.TRADE.LIST, filters as Record<string, unknown>);
  },

  /**
   * Get active trades
   */
  async getActiveTrades(filters?: Partial<TradeFilter>): Promise<Trade[]> {
    return api.get<Trade[]>(API_ENDPOINTS.TRADE.ACTIVE, filters as Record<string, unknown>);
  },

  /**
   * Get trade history
   */
  async getTradeHistory(filters?: TradeFilter): Promise<Trade[]> {
    return api.get<Trade[]>(API_ENDPOINTS.TRADE.HISTORY, filters as Record<string, unknown>);
  },

  /**
   * Get trade by ID
   */
  async getById(id: string): Promise<Trade> {
    return api.get<Trade>(API_ENDPOINTS.TRADE.DETAILS(id));
  },

  /**
   * Get positions
   */
  async getPositions(filters?: {
    userId?: string;
    broker?: string;
    strategy?: string;
  }): Promise<Position[]> {
    return api.get<Position[]>(API_ENDPOINTS.TRADE.POSITIONS, filters);
  },

  /**
   * Modify trade
   */
  async modifyTrade(action: TradeAction): Promise<{ success: boolean; trade: Trade }> {
    return api.put(API_ENDPOINTS.TRADE.DETAILS(action.tradeId), action);
  },

  /**
   * Cancel trade
   */
  async cancelTrade(tradeId: string, reason?: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.TRADE.DETAILS(tradeId), { reason });
  },

  /**
   * Exit trade
   */
  async exitTrade(
    tradeId: string,
    data?: { quantity?: number; price?: number }
  ): Promise<{ success: boolean; trade: Trade }> {
    return api.post(`${API_ENDPOINTS.TRADE.DETAILS(tradeId)}/exit`, data);
  },

  /**
   * Square off positions
   */
  async squareOff(request: SquareOffRequest): Promise<{ success: boolean; squaredOff: number }> {
    return api.post(API_ENDPOINTS.TRADE.SQUARE_OFF, request);
  },

  /**
   * Get trade summary
   */
  async getSummary(filters?: TradeFilter): Promise<TradeSummary> {
    return api.get<TradeSummary>(`${API_ENDPOINTS.TRADE.BASE}/summary`, filters as Record<string, unknown>);
  },

  /**
   * Get daily performance
   */
  async getDailyPerformance(params: {
    userId?: string;
    broker?: string;
    strategy?: string;
    fromDate: string;
    toDate: string;
  }): Promise<DailyPerformance[]> {
    return api.get<DailyPerformance[]>(API_ENDPOINTS.REPORTS.DAYWISE, params);
  },

  /**
   * Get monthly performance
   */
  async getMonthlyPerformance(params: {
    userId?: string;
    year?: number;
  }): Promise<MonthlyPerformance[]> {
    return api.get<MonthlyPerformance[]>(API_ENDPOINTS.REPORTS.MONTHLY, params);
  },

  /**
   * Get strategy-wise performance
   */
  async getStrategyPerformance(params: {
    userId?: string;
    fromDate?: string;
    toDate?: string;
  }): Promise<StrategyPerformanceReport[]> {
    return api.get<StrategyPerformanceReport[]>(API_ENDPOINTS.REPORTS.STRATEGY_WISE, params);
  },

  /**
   * Export trades to CSV/Excel
   */
  async exportTrades(params: {
    format: 'csv' | 'xlsx';
    filters?: TradeFilter;
  }): Promise<Blob> {
    const response = await api.get<Blob>(API_ENDPOINTS.REPORTS.EXPORT, {
      ...params.filters,
      format: params.format,
    });
    return response;
  },
};
