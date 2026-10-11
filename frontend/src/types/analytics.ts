/**
 * Analytics: one question, any combination of inputs, one answer.
 * Money crosses as strings and is shown, never recomputed.
 */

export type GroupBy =
  | 'day' | 'week' | 'month' | 'account' | 'broker' | 'strategy' | 'symbol' | 'product' | 'exit_reason' | 'direction';

export interface AnalyticsOptions {
  groupBy: GroupBy[];
  tradingClients: { id: string; displayName: string; broker: string }[];
  brokers: string[];
}

export interface AnalyticsQuestion {
  [key: string]: string | undefined;
  fromDate?: string;
  toDate?: string;
  /** comma-separated, any of */
  tradingClientIds?: string;
  brokers?: string;
  strategies?: string;
  products?: string;
  /** 'live' | 'paper' | '' for both */
  paper?: string;
  groupBy: GroupBy;
}

export interface AnalyticsBucket {
  key: string;
  label: string;
  trades: number;
  wins: number;
  losses: number;
  flat: number;
  winRate: string | null;
  grossPnl: string;
  averageTrade: string | null;
  averageWin: string | null;
  averageLoss: string | null;
  best: string | null;
  worst: string | null;
  maxDrawdown: string;
  profitFactor: string | null;
}

export interface AnalyticsPoint {
  tradingDay: string;
  dayPnl: string;
  cumulative: string;
  trades: number;
}

export interface AnalyticsAnswer {
  fromDate: string;
  toDate: string;
  groupBy: GroupBy;
  overall: AnalyticsBucket;
  groups: AnalyticsBucket[];
  curve: AnalyticsPoint[];
}
