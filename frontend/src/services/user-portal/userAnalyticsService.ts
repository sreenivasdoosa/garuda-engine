/**
 * User Analytics Service
 * API service for user's analytics and performance data
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type {
  UserPerformanceStats,
  DailyPnlData,
  MonthlyPnlData,
  StrategyPerformance,
  DateRangeFilter,
  TradingMode,
} from '@/types/user-portal';

// User portal analytics endpoints
const USER_ANALYTICS_ENDPOINTS = {
  PERFORMANCE: '/api/v2/me/analytics/performance',
  DAILY: '/api/v2/me/analytics/daily',
  MONTHLY: '/api/v2/me/analytics/monthly',
  STRATEGIES: '/api/v2/me/analytics/strategies',
};

export const userAnalyticsService = {
  /**
   * Get user performance stats
   */
  async getPerformanceStats(dateRange?: DateRangeFilter, mode: TradingMode = 'live'): Promise<UserPerformanceStats> {
    const params: Record<string, string> = { mode };
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<UserPerformanceStats>(USER_ANALYTICS_ENDPOINTS.PERFORMANCE, params);
  },

  /**
   * Get detailed user performance
   */
  async getDetailedPerformance(dateRange?: DateRangeFilter): Promise<UserPerformanceStats> {
    const params: Record<string, string> = {};
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<UserPerformanceStats>(USER_ANALYTICS_ENDPOINTS.PERFORMANCE, params);
  },

  /**
   * Get daily P&L data for equity curve
   */
  async getDailyPnl(dateRange?: DateRangeFilter, mode: TradingMode = 'live'): Promise<DailyPnlData[]> {
    const params: Record<string, string> = { mode };
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<DailyPnlData[]>(USER_ANALYTICS_ENDPOINTS.DAILY, params);
  },

  /**
   * Get cumulative P&L data
   */
  async getCumulativePnl(dateRange?: DateRangeFilter): Promise<DailyPnlData[]> {
    const params: Record<string, string> = {};
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    // The API returns daily data, we calculate cumulative on client side
    const dailyData = await api.get<DailyPnlData[]>(USER_ANALYTICS_ENDPOINTS.DAILY, params);

    // Calculate cumulative P&L
    let cumulativePnl = 0;
    return dailyData.map((day) => {
      cumulativePnl += day.pnl;
      return {
        ...day,
        cumulativePnl,
      };
    });
  },

  /**
   * Get monthly P&L data
   */
  async getMonthlyPnl(dateRange?: DateRangeFilter, mode: TradingMode = 'live'): Promise<MonthlyPnlData[]> {
    const params: Record<string, string> = { mode };
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<MonthlyPnlData[]>(USER_ANALYTICS_ENDPOINTS.MONTHLY, params);
  },

  /**
   * Get strategy-wise performance breakdown
   */
  async getStrategyPerformance(dateRange?: DateRangeFilter, mode: TradingMode = 'live'): Promise<StrategyPerformance[]> {
    const params: Record<string, string> = { mode };
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<StrategyPerformance[]>(USER_ANALYTICS_ENDPOINTS.STRATEGIES, params);
  },
};
