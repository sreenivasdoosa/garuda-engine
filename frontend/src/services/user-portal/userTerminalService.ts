/**
 * User Terminal Service
 * API service for user's terminal/live data operations
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type { UserTerminalSummary, UserPosition, UserActiveTrade } from '@/types/user-portal';
import type { UserTradeSummary, UserTradeDetails } from '@/types/terminal';

// User portal terminal endpoints
const USER_TERMINAL_ENDPOINTS = {
  SUMMARY: '/api/v2/me/terminal/summary',
  DETAILS: (broker: string) => `/api/v2/me/terminal/details/${broker}`,
  PNL_CHART: '/api/v2/me/terminal/pnl-chart',
};

// Types for user PnL chart data
export interface UserPnlSnapshot {
  id: number;
  username: string;
  broker: string;
  snapshotDate: string;
  snapshotTimestamp: number; // Epoch milliseconds
  algoPnl: number;
  brokerPnl: number;
  capital: number;
  totalMargin: number;
  utilizedMargin: number;
}

export interface UserPnlChartResponse {
  date: string;
  broker: string | null;
  brokers: string[];
  snapshots: UserPnlSnapshot[];
  count: number;
}

export const userTerminalService = {
  /**
   * Get terminal summary for current user (all brokers)
   */
  async getSummary(): Promise<UserTradeSummary[]> {
    return api.get<UserTradeSummary[]>(USER_TERMINAL_ENDPOINTS.SUMMARY);
  },

  /**
   * Get detailed trade data for a specific broker
   */
  async getDetails(
    broker: string,
    options?: { fetchBrokerPositions?: boolean; fetchMargins?: boolean }
  ): Promise<UserTradeDetails> {
    const params: Record<string, string> = {};
    if (options?.fetchBrokerPositions) params.fetchBrokerPositions = 'true';
    if (options?.fetchMargins) params.fetchMargins = 'true';

    return api.get<UserTradeDetails>(USER_TERMINAL_ENDPOINTS.DETAILS(broker), params);
  },

  /**
   * Get aggregated terminal summary across all brokers
   */
  async getAggregatedSummary(): Promise<UserTerminalSummary> {
    const summaries = await this.getSummary();

    if (summaries.length === 0) {
      return {
        username: '',
        broker: 'ALL',
        openTradesCount: 0,
        activeTradesCount: 0,
        completedTradesCount: 0,
        cancelledTradesCount: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        totalCharges: 0,
        netPnl: 0,
        returnsPercent: 0,
        totalMargin: 0,
        utilizedMargin: 0,
        availableMargin: 0,
        marginUtilizationPercent: 0,
        lastUpdatedAt: Date.now(),
        status: 'READY',
        isLoggedIn: false,
      };
    }

    // Aggregate across all brokers
    const aggregated = summaries.reduce(
      (acc, summary) => ({
        openTradesCount: acc.openTradesCount + summary.openTradesCount,
        activeTradesCount: acc.activeTradesCount + summary.activeTradesCount,
        completedTradesCount: acc.completedTradesCount + summary.completedTradesCount,
        cancelledTradesCount: acc.cancelledTradesCount + summary.cancelledTradesCount,
        realizedPnl: acc.realizedPnl + summary.realizedPnl,
        unrealizedPnl: acc.unrealizedPnl + summary.unrealizedPnl,
        totalPnl: acc.totalPnl + summary.totalPnl,
        totalCharges: acc.totalCharges + summary.totalCharges,
        netPnl: acc.netPnl + summary.netPnl,
        totalMargin: acc.totalMargin + summary.totalMargin,
        utilizedMargin: acc.utilizedMargin + summary.utilizedMargin,
        availableMargin: acc.availableMargin + summary.availableMargin,
        totalCapital: acc.totalCapital + (summary.totalCapital || 0),
        // Paper-trading subset (carried so the UI live/paper/mixed filter works).
        paperOpenTradesCount: acc.paperOpenTradesCount + (summary.paperOpenTradesCount || 0),
        paperActiveTradesCount: acc.paperActiveTradesCount + (summary.paperActiveTradesCount || 0),
        paperCompletedTradesCount: acc.paperCompletedTradesCount + (summary.paperCompletedTradesCount || 0),
        paperCancelledTradesCount: acc.paperCancelledTradesCount + (summary.paperCancelledTradesCount || 0),
        paperRealizedPnl: acc.paperRealizedPnl + (summary.paperRealizedPnl || 0),
        paperUnrealizedPnl: acc.paperUnrealizedPnl + (summary.paperUnrealizedPnl || 0),
        paperTotalPnl: acc.paperTotalPnl + (summary.paperTotalPnl || 0),
        paperTotalCharges: acc.paperTotalCharges + (summary.paperTotalCharges || 0),
        paperNetPnl: acc.paperNetPnl + (summary.paperNetPnl || 0),
      }),
      {
        openTradesCount: 0,
        activeTradesCount: 0,
        completedTradesCount: 0,
        cancelledTradesCount: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
        totalCharges: 0,
        netPnl: 0,
        totalMargin: 0,
        utilizedMargin: 0,
        availableMargin: 0,
        totalCapital: 0,
        paperOpenTradesCount: 0,
        paperActiveTradesCount: 0,
        paperCompletedTradesCount: 0,
        paperCancelledTradesCount: 0,
        paperRealizedPnl: 0,
        paperUnrealizedPnl: 0,
        paperTotalPnl: 0,
        paperTotalCharges: 0,
        paperNetPnl: 0,
      }
    );

    const returnsPercent =
      aggregated.totalCapital > 0 ? (aggregated.netPnl / aggregated.totalCapital) * 100 : 0;

    const marginUtilizationPercent =
      aggregated.totalMargin > 0
        ? (aggregated.utilizedMargin / aggregated.totalMargin) * 100
        : 0;

    return {
      username: summaries[0]?.username || '',
      broker: 'ALL',
      ...aggregated,
      returnsPercent,
      marginUtilizationPercent,
      lastUpdatedAt: Math.max(...summaries.map((s) => s.lastUpdatedAt)),
      status: summaries.every((s) => s.status === 'READY') ? 'READY' : 'LOADING',
      isLoggedIn: summaries.some((s) => s.isLoggedIn),
    };
  },

  /**
   * Get all positions for current user
   */
  async getPositions(): Promise<UserPosition[]> {
    const summaries = await this.getSummary();
    const positions: UserPosition[] = [];

    for (const summary of summaries) {
      try {
        const details = await this.getDetails(summary.broker);
        const brokerPositions = details.algoPositions.map((pos) => ({
          broker: summary.broker,
          tradingSymbol: pos.tradingSymbol,
          exchange: pos.exchange,
          segment: pos.segment,
          productType: pos.productType,
          netQty: pos.netQty,
          buyQty: pos.buyQty,
          sellQty: pos.sellQty,
          buyAvgPrice: pos.buyAvgPrice,
          sellAvgPrice: pos.sellAvgPrice,
          cmp: pos.cmp,
          realizedPnl: pos.realizedPnl,
          unrealizedPnl: pos.unrealizedPnl,
          totalPnl: pos.totalPnl,
        }));
        positions.push(...brokerPositions);
      } catch {
        // Skip broker if details fetch fails
      }
    }

    return positions;
  },

  /**
   * Get all active trades for current user
   */
  async getActiveTrades(): Promise<UserActiveTrade[]> {
    const summaries = await this.getSummary();
    const trades: UserActiveTrade[] = [];

    for (const summary of summaries) {
      try {
        const details = await this.getDetails(summary.broker);
        const brokerTrades = details.activeTrades.map((trade) => ({
          id: trade.id,
          broker: summary.broker,
          symbol: trade.symbol,
          tradingSymbol: trade.symbol,
          exchange: trade.exchange,
          segment: trade.segment || '',
          strategy: trade.strategy,
          direction: (trade.positionType === 'SHORT' ? 'SHORT' : 'LONG') as 'LONG' | 'SHORT',
          quantity: trade.quantity,
          entryPrice: trade.entryPrice,
          currentPrice: trade.currentPrice ?? trade.entryPrice,
          stopLoss: trade.stopLoss,
          target: trade.target,
          pnl: trade.pnl,
          status: 'ACTIVE' as const,
          entryTime: trade.entryTime,
        }));
        trades.push(...brokerTrades);
      } catch {
        // Skip broker if details fetch fails
      }
    }

    return trades;
  },

  /**
   * Get PnL chart data for intraday charting
   * @param date - Date string in YYYY-MM-DD format (defaults to today if not provided)
   * @param broker - Optional broker filter (if not provided, returns all brokers)
   */
  async getPnlChartData(date?: string, broker?: string, mode: 'live' | 'paper' = 'live'): Promise<UserPnlChartResponse> {
    const params: Record<string, string> = { mode };
    if (date) params.date = date;
    if (broker) params.broker = broker;
    return api.get<UserPnlChartResponse>(USER_TERMINAL_ENDPOINTS.PNL_CHART, params);
  },
};
