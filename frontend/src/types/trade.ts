import type { OrderType, PositionType, TradeStatus } from './common';

export interface Trade {
  id: string;
  tradeId: string;
  userId: string;
  username: string;
  broker: string;
  clientId: string;
  strategy: string;
  strategyName: string;
  symbol: string;
  exchange: string;
  segment: string;
  orderType: OrderType;
  positionType: PositionType;
  quantity: number;
  entryPrice: number;
  exitPrice?: number;
  currentPrice?: number;
  stopLoss?: number;
  target?: number;
  pnl: number;
  pnlPercentage: number;
  status: TradeStatus;
  entryTime: string;
  exitTime?: string;
  orderId?: string;
  brokerOrderId?: string;
  remarks?: string;
  tags?: string[];
  isPaperTrading?: boolean;
  isMock?: boolean;
}

export interface Position {
  id: string;
  userId: string;
  username: string;
  broker: string;
  clientId: string;
  strategy: string;
  symbol: string;
  exchange: string;
  segment: string;
  positionType: PositionType;
  productType?: string;  // MIS, NRML, etc.
  quantity: number;
  avgPrice: number;
  currentPrice: number;
  ltp: number;
  pnl: number;
  pnlPercentage: number;
  dayPnl: number;
  value: number;
  margin: number;
  lastUpdated: string;
}

export interface TradeAction {
  tradeId: string;
  action: 'modify' | 'cancel' | 'exit' | 'partial_exit';
  quantity?: number;
  price?: number;
  stopLoss?: number;
  target?: number;
  remarks?: string;
}

export interface SquareOffRequest {
  positions: Array<{
    positionId: string;
    quantity?: number; // partial square off
  }>;
  reason?: string;
}

export interface TradeFilter {
  userId?: string;
  username?: string;
  broker?: string;
  strategy?: string;
  status?: TradeStatus;
  symbol?: string;
  fromDate?: string;
  toDate?: string;
  orderType?: OrderType;
}

export interface TradeSummary {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  totalPnl: number;
  avgPnl: number;
  winRate: number;
  profitFactor: number;
  maxProfit: number;
  maxLoss: number;
  avgWin: number;
  avgLoss: number;
}

export interface DailyPerformance {
  date: string;
  totalTrades: number;
  pnl: number;
  winRate: number;
  cumulativePnl: number;
}

export interface MonthlyPerformance {
  month: string;
  year: number;
  totalTrades: number;
  pnl: number;
  winRate: number;
  maxDrawdown: number;
}

export interface StrategyPerformanceReport {
  strategyId: string;
  strategyName: string;
  totalTrades: number;
  pnl: number;
  winRate: number;
  avgReturn: number;
  sharpeRatio: number;
}
