/**
 * Analytics Service
 * Provides API calls for all analytics endpoints
 */

import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// ==================== TYPES ====================

export type TradingMode = 'live' | 'paper' | 'mixed';

export interface UserStats {
  totalUsers: number;
  activeUsers: number;
  inactiveUsers: number;
  usersByRole: RoleCount[];
}

export interface RoleCount {
  role: string;
  count: number;
}

export interface BrokerStats {
  totalMappings: number;
  enabledMappings: number;
  disabledMappings: number;
  loginSuccess: number;
  loginFailed: number;
  brokerDistribution: NameCount[];
}

export interface StrategyStats {
  totalStrategies: number;
  activeStrategies: number;
  stoppedStrategies: number;
  disabledStrategies: number;
  totalUserConfigs: number;
  enabledUserConfigs: number;
  productDistribution: NameCount[];
  strategyPopularity: NameCount[];
}

export interface NameCount {
  name: string;
  count: number;
}

export interface TimeSeriesPoint {
  label: string;
  value: number;
}

export interface DailyCapitalSummary {
  date: string;
  totalCapital: number;
  userCount: number;
}

export interface DailyMarginSummary {
  date: string;
  totalPeakMargin: number;
  totalMargin: number;
  userCount: number;
  utilizationPercent: number;
}

export interface BillingSummary {
  totalBills: number;
  paidBills: number;
  overdueBills: number;
  pendingBills: number;
  totalBilled: number;
  totalPaid: number;
  outstanding: number;
  totalGst: number;
  totalPnl: number;
  avgCapital: number;
}

export interface RevenueData {
  monthly: TimeSeriesPoint[];
  byPlan: NameCount[];
  byFinancialYear: NameCount[];
}

export interface TradeSummary {
  totalTrades: number;
  intradayTrades: number;
  positionalTrades: number;
  totalPnl: number;
  intradayPnl: number;
  positionalPnl: number;
  totalCharges: number;
  intradayCharges: number;
  positionalCharges: number;
  totalWins: number;
  totalLosses: number;
  intradayWins: number;
  intradayLosses: number;
  positionalWins: number;
  positionalLosses: number;
  activePositions: number;
}

/**
 * Fast EOD-aggregated trade summary used by the admin dashboard.
 * Day-level wins/losses are based on per-day totals across all
 * users/strategies in scope. activePositionalTrades is point-in-time
 * (not date-filtered) — returned here to save a second round-trip.
 */
export interface EodTradeSummary {
  totalPnl: number;
  totalCharges: number;
  totalNetPnl: number;
  tradingDays: number;
  winningDays: number;
  losingDays: number;
  activePositionalTrades: number;
}

export interface DailyPnlSummary {
  date: string;
  pnl: number;
  charges: number;
  netPnl: number;
  userCount: number;
}

export interface StrategyPnl {
  strategyName: string;
  netPnl: number;
  tradeCount: number;
}

export interface TradeDistribution {
  byBroker: NameCount[];
  byProduct: NameCount[];
}

export interface CapitalDistribution {
  byUser: NameCount[];
  byBroker: NameCount[];
}

// Strategy Performance Types
export interface StrategyPerformanceStats {
  totalStrategies: number;
  tradingDays: number;
  avgCapital: number;      // Average daily capital deployed
  grossPnl: number;
  totalCharges: number;
  netPnl: number;
  roi: number;             // ROI = netPnl / avgCapital * 100
  totalRecords: number;
  winningDays: number;
  losingDays: number;
  breakevenDays: number;
  winRate: number;
  avgDailyReturn: number;  // Average daily return (%)
  returnStdDev: number;    // Std dev of daily returns (%)
  sharpeRatio: number;     // Sharpe = avgDailyReturn / returnStdDev
}

export interface StrategyDetailedPerformance {
  strategyName: string;
  displayName: string;
  product: string;
  tradingDays: number;
  totalCapital: number;
  avgCapital: number;
  grossPnl: number;
  totalCharges: number;
  netPnl: number;
  roi: number;             // ROI = netPnl / avgCapital * 100
  maxDailyProfit: number;
  maxDailyLoss: number;
  avgDailyPnl: number;     // Average daily P&L (absolute)
  avgDailyReturn: number;  // Average daily return (%)
  returnStdDev: number;    // Std dev of daily returns (%)
  sharpeRatio: number;     // Sharpe = avgDailyReturn / returnStdDev (using returns)
  uniqueUsers: number;
}

export interface ProductPerformance {
  product: string;
  strategyCount: number;
  tradingDays: number;
  avgCapital: number;    // Average capital deployed
  netPnl: number;
  roi: number;           // ROI = netPnl / avgCapital * 100
  avgDailyPnl: number;
  uniqueUsers: number;
}

export interface CumulativePnl {
  date: string;
  strategyName: string;
  cumulativePnl: number;
}

export interface MonthlyStrategyPerformance {
  month: string;
  strategyName: string;
  netPnl: number;
  avgCapital: number;      // Average capital deployed in the month
  tradingDays: number;
  roi: number;             // ROI = netPnl / avgCapital * 100
  avgDailyReturn: number;  // Average daily return (%) within the month
  returnStdDev: number;    // Std dev of daily returns (%) within the month
  sharpeRatio: number;     // Sharpe = avgDailyReturn / returnStdDev
}

// User Performance Types
export interface UserPerformanceStats {
  totalUsers: number;
  tradingDays: number;
  avgCapital: number;
  grossPnl: number;
  totalCharges: number;
  netPnl: number;
  roi: number;
  totalRecords: number;
  profitableUsers: number;
  lossUsers: number;
  breakevenUsers: number;
  profitabilityRate: number;
  avgDailyReturn: number;
  returnStdDev: number;
  sharpeRatio: number;
}

export interface UserDetailedPerformance {
  userName: string;
  tradingDays: number;
  strategiesUsed: number;
  brokersUsed: number;
  avgCapital: number;
  grossPnl: number;
  totalCharges: number;
  netPnl: number;
  roi: number;
  maxDailyProfit: number;
  maxDailyLoss: number;
  avgDailyPnl: number;
  avgDailyReturn: number;
  returnStdDev: number;
  sharpeRatio: number;
}

export interface MonthlyUserPerformance {
  month: string;
  userName: string;
  netPnl: number;
  avgCapital: number;
  tradingDays: number;
  roi: number;
  avgDailyReturn: number;
  returnStdDev: number;
  sharpeRatio: number;
}

export interface UserStrategyPerformance {
  strategyName: string;
  displayName: string;
  product: string;
  tradingDays: number;
  avgCapital: number;
  netPnl: number;
  avgDailyPnl: number;
  roi: number;
}

// ==================== SERVICE ====================

export interface BrokerDetailedPerformance {
  brokerName: string;
  tradingDays: number;
  usersCount: number;
  strategiesUsed: number;
  avgCapital: number;
  grossPnl: number;
  totalCharges: number;
  netPnl: number;
  avgDailyPnl: number;
  roi: number;
}

export interface BrokerUserPerformance {
  userName: string;
  tradingDays: number;
  avgCapital: number;
  netPnl: number;
  avgDailyPnl: number;
  roi: number;
}

export const analyticsService = {
  // User Analytics
  async getUserStats(): Promise<UserStats> {
    return api.get<UserStats>(API_ENDPOINTS.V2_ANALYTICS.USERS);
  },

  async getUserGrowth(fromDate: string, toDate: string): Promise<TimeSeriesPoint[]> {
    return api.get<TimeSeriesPoint[]>(API_ENDPOINTS.V2_ANALYTICS.USERS_GROWTH, { fromDate, toDate });
  },

  // Broker Analytics
  async getBrokerStats(): Promise<BrokerStats> {
    return api.get<BrokerStats>(API_ENDPOINTS.V2_ANALYTICS.BROKERS);
  },

  // Strategy Analytics
  async getStrategyStats(): Promise<StrategyStats> {
    return api.get<StrategyStats>(API_ENDPOINTS.V2_ANALYTICS.STRATEGIES);
  },

  // Capital Analytics
  async getDailyCapitalSummary(fromDate: string, toDate: string): Promise<DailyCapitalSummary[]> {
    return api.get<DailyCapitalSummary[]>(API_ENDPOINTS.V2_ANALYTICS.CAPITAL, { fromDate, toDate });
  },

  async getCapitalDistribution(date: string): Promise<CapitalDistribution> {
    return api.get<CapitalDistribution>(API_ENDPOINTS.V2_ANALYTICS.CAPITAL_DISTRIBUTION, { date });
  },

  // Margin Analytics
  async getDailyMarginSummary(fromDate: string, toDate: string): Promise<DailyMarginSummary[]> {
    return api.get<DailyMarginSummary[]>(API_ENDPOINTS.V2_ANALYTICS.MARGINS, { fromDate, toDate });
  },

  // Billing Analytics (Admin only)
  async getBillingSummary(fromDate: string, toDate: string): Promise<BillingSummary> {
    return api.get<BillingSummary>(API_ENDPOINTS.V2_ANALYTICS.BILLING, { fromDate, toDate });
  },

  async getRevenueData(fromDate: string, toDate: string): Promise<RevenueData> {
    return api.get<RevenueData>(API_ENDPOINTS.V2_ANALYTICS.BILLING_REVENUE, { fromDate, toDate });
  },

  // Trade Analytics
  async getTradeSummary(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<TradeSummary> {
    return api.get<TradeSummary>(API_ENDPOINTS.V2_ANALYTICS.TRADES, { fromDate, toDate, mode });
  },

  /**
   * Fast EOD-based trade summary for the admin dashboard.
   * Sourced from EOD_PNL_REPORTS (pre-aggregated) instead of scanning the
   * per-trade INTRADAY/POSITIONAL tables. Returns trading-day counts
   * instead of per-trade counts. activePositionalTrades is a current
   * snapshot (not date-filtered).
   */
  async getEodTradeSummary(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<EodTradeSummary> {
    return api.get<EodTradeSummary>(API_ENDPOINTS.V2_ANALYTICS.TRADES_EOD_SUMMARY, { fromDate, toDate, mode });
  },

  async getDailyPnlSummary(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<DailyPnlSummary[]> {
    return api.get<DailyPnlSummary[]>(API_ENDPOINTS.V2_ANALYTICS.TRADES_PNL, { fromDate, toDate, mode });
  },

  async getPnlByStrategy(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<StrategyPnl[]> {
    return api.get<StrategyPnl[]>(API_ENDPOINTS.V2_ANALYTICS.TRADES_BY_STRATEGY, { fromDate, toDate, mode });
  },

  async getTradeDistribution(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<TradeDistribution> {
    return api.get<TradeDistribution>(API_ENDPOINTS.V2_ANALYTICS.TRADES_DISTRIBUTION, { fromDate, toDate, mode });
  },

  // Strategy Performance Analytics
  async getStrategyPerformanceStats(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<StrategyPerformanceStats> {
    return api.get<StrategyPerformanceStats>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE, { fromDate, toDate, mode });
  },

  async getStrategyDetailedPerformance(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<StrategyDetailedPerformance[]> {
    return api.get<StrategyDetailedPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE_DETAILED, { fromDate, toDate, mode });
  },

  async getPerformanceByProduct(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<ProductPerformance[]> {
    return api.get<ProductPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE_BY_PRODUCT, { fromDate, toDate, mode });
  },

  async getCumulativePnl(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<CumulativePnl[]> {
    return api.get<CumulativePnl[]>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE_CUMULATIVE, { fromDate, toDate, mode });
  },

  async getMonthlyStrategyPerformance(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<MonthlyStrategyPerformance[]> {
    return api.get<MonthlyStrategyPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE_MONTHLY, { fromDate, toDate, mode });
  },

  async getStrategyDailyPnl(strategy: string, fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<DailyPnlSummary[]> {
    return api.get<DailyPnlSummary[]>(API_ENDPOINTS.V2_ANALYTICS.STRATEGY_PERFORMANCE_DAILY, { strategy, fromDate, toDate, mode });
  },

  // User Performance Analytics
  async getUserPerformanceStats(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<UserPerformanceStats> {
    return api.get<UserPerformanceStats>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE, { fromDate, toDate, mode });
  },

  async getUserDetailedPerformance(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<UserDetailedPerformance[]> {
    return api.get<UserDetailedPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE_DETAILED, { fromDate, toDate, mode });
  },

  async getUserCumulativePnl(fromDate: string, toDate: string, limit = 10, mode: TradingMode = 'live'): Promise<CumulativePnl[]> {
    return api.get<CumulativePnl[]>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE_CUMULATIVE, { fromDate, toDate, limit, mode });
  },

  async getMonthlyUserPerformance(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<MonthlyUserPerformance[]> {
    return api.get<MonthlyUserPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE_MONTHLY, { fromDate, toDate, mode });
  },

  async getUserDailyPnl(user: string, fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<DailyPnlSummary[]> {
    return api.get<DailyPnlSummary[]>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE_DAILY, { user, fromDate, toDate, mode });
  },

  async getBrokerDetailedPerformance(fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<BrokerDetailedPerformance[]> {
    return api.get<BrokerDetailedPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.BROKER_PERFORMANCE_DETAILED, { fromDate, toDate, mode });
  },

  async getBrokerDailyPnl(broker: string, fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<DailyPnlSummary[]> {
    return api.get<DailyPnlSummary[]>(API_ENDPOINTS.V2_ANALYTICS.BROKER_PERFORMANCE_DAILY, { broker, fromDate, toDate, mode });
  },

  async getBrokerUserBreakdown(broker: string, fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<BrokerUserPerformance[]> {
    return api.get<BrokerUserPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.BROKER_PERFORMANCE_USERS, { broker, fromDate, toDate, mode });
  },

  async getUserStrategyBreakdown(user: string, fromDate: string, toDate: string, mode: TradingMode = 'live'): Promise<UserStrategyPerformance[]> {
    return api.get<UserStrategyPerformance[]>(API_ENDPOINTS.V2_ANALYTICS.USER_PERFORMANCE_STRATEGIES, { user, fromDate, toDate, mode });
  },
};

export default analyticsService;
