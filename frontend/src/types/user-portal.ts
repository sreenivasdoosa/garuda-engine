/**
 * User Portal Types
 * Types for the user portal v2 - user's own data views
 */

// ==================== Broker Types ====================

export interface UserBrokerInfo {
  broker: string;           // Broker code (e.g., "ZERODHA", "FYERS")
  clientID: string;         // User's client ID with the broker
  enabled: boolean;         // Whether broker is enabled
  autoLogin: boolean;       // Auto-login preference
  loginVerified: boolean;   // First-time OAuth done (if true, auto-login is available)
  brokeragePlan?: string;   // Brokerage plan name
  isPro?: boolean;          // Pro user flag
  webSocketEnabled?: boolean;
}

export interface BrokerLoginStatus {
  isLoggedIn: boolean;
  clientID?: string;
}

export interface UserBrokerFunds {
  broker: string;
  totalMargin: number;
  utilizedMargin: number;
  availableMargin: number;
  collateral?: number;
  cash?: number;
  lastUpdatedAt?: string;
}

export interface AddBrokerRequest {
  broker: string;
  clientId: string;
  password?: string;
  pin?: string;
  totp?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface UpdateBrokerRequest {
  password?: string;
  pin?: string;
  totp?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface BrokerLoginResponse {
  loginUrl?: string;
  redirectUrl?: string;
  message?: string;
  status?: string;
}

// ==================== Terminal/Live Data Types ====================

export interface UserTerminalSummary {
  username: string;
  broker: string;
  clientID?: string;

  // Trade counts
  openTradesCount: number;
  activeTradesCount: number;
  completedTradesCount: number;
  cancelledTradesCount: number;

  // P&L
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalCharges: number;
  netPnl: number;
  returnsPercent: number;

  // Margins
  totalMargin: number;
  utilizedMargin: number;
  availableMargin: number;
  marginUtilizationPercent: number;

  // Capital (carried through aggregation for returns%).
  totalCapital?: number;

  // Paper-trading subset (UI derives live = total - paper). Margins have no
  // paper twin (paper trades use no real broker margin).
  paperOpenTradesCount?: number;
  paperActiveTradesCount?: number;
  paperCompletedTradesCount?: number;
  paperCancelledTradesCount?: number;
  paperRealizedPnl?: number;
  paperUnrealizedPnl?: number;
  paperTotalPnl?: number;
  paperTotalCharges?: number;
  paperNetPnl?: number;

  // Metadata
  lastUpdatedAt: number;
  status: 'LOADING' | 'READY' | 'ERROR' | 'STALE';
  isLoggedIn: boolean;
}

export interface UserPosition {
  broker: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  productType: string;
  netQty: number;
  buyQty: number;
  sellQty: number;
  buyAvgPrice: number;
  sellAvgPrice: number;
  cmp: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
}

export interface UserActiveTrade {
  id: string;
  broker: string;
  symbol: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  strategy: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  currentPrice: number;
  stopLoss?: number;
  target?: number;
  pnl: number;
  status: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  entryTime: string;
}

// ==================== Analytics Types ====================

// Matches server: AnalyticsRepository.UserDetailedPerformance
export interface UserPerformanceStats {
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

// Matches server: AnalyticsRepository.DailyPnlSummary
export interface DailyPnlData {
  date: string;
  pnl: number;
  charges: number;
  netPnl: number;
  userCount: number;
}

// Matches server: AnalyticsRepository.MonthlyUserPerformance
export interface MonthlyPnlData {
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

// Matches server: AnalyticsRepository.UserStrategyPerformance
export interface StrategyPerformance {
  strategyName: string;
  displayName?: string;
  product?: string;
  tradingDays: number;
  avgCapital: number;
  netPnl: number;
  avgDailyPnl: number;
  roi: number;
}

// ==================== Reports Types ====================

// Matches server: Trade class (serialized via Jackson)
/** Live vs paper-trading selector for analytics/report reads. Default 'live'. */
export type TradingMode = 'live' | 'paper' | 'mixed';

export interface TradeReport {
  tradeID: string;
  username: string;
  broker: string;
  strategy: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  direction: 'LONG' | 'SHORT';
  productType: string;
  quantity: number;
  contractMultiplier?: number;  // Units per lot (e.g., 100 for CRUDEOIL)
  filledQuantity: number;
  entry: number;
  exit: number;
  profitLoss: number;
  charges: number;
  netProfitLoss: number;
  startTimestamp: number; // epoch milliseconds
  endTimestamp: number | null; // epoch milliseconds
  state: 'OPEN' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  stopLoss?: number;
  target?: number;
  exitReason?: string;
  product?: string;
  isPaperTrading?: boolean;
  isMock?: boolean;
}

// Matches server: DailyRecord class
export interface EodPnlReport {
  dateStr: string;
  username: string;
  broker: string;
  strategy: string;
  product: string;
  capital: number;
  pl: number;
  charges: number;
  netPL: number;
  /** MTF funding interest — tracked separately, never folded into charges/netPL. */
  mtfInterest?: number;
  isPaperTrading?: boolean;
}

export interface ReportFilters {
  fromDate: string;
  toDate: string;
  broker?: string;
  strategy?: string;
}

// ==================== Billing Types ====================

// Matches server: UserBillDetails class
export interface UserBill {
  username: string;
  billingNumber: number;
  supervisorUsername?: string;
  billingPlan: string;
  billingPeriodDays: number;
  billingStartDate: string; // ISO date string
  billingEndDate: string; // ISO date string
  averageCapital: number;
  netProfitLossIntraday: number;
  netProfitLossPositional: number;
  netProfitLoss: number;
  previousLoss: number;
  unAccountedPnl: number;
  netProfitLossAfterAdjustments: number;
  fixedCost: number;
  variableCost: number;
  totalCost: number;
  isPaid: boolean;
  isApproved: boolean;
  paymentDueDate?: string; // ISO date string
  financialYear: string;
  fyBillingNumber: number;
  invoiceNumber?: string;
  GST: number;
  totalCostWithGST: number;
  paidAmount: number;
  tds: number;
  otherDeductions: number;
  isWrittenOff: boolean;
}

export interface BillingSummary {
  outstandingAmount: number;
  totalPaidThisFY: number;
  totalBillsThisFY: number;
  lastPaymentDate?: string;
  lastPaymentAmount?: number;
}

// ==================== Alerts Types ====================

export interface UserSystemAlert {
  id: string;
  timestamp: string;
  alertLevel: 'CRITICAL' | 'WARNING' | 'INFO';
  entityType: string;
  entityName: string;
  operation: string;
  alertMessage: string;
  isRead?: boolean;
}

export interface AlertFiltersState {
  level?: 'CRITICAL' | 'WARNING' | 'INFO';
  entityType?: string;
  fromDate?: string;
  toDate?: string;
}

// ==================== Profile Types ====================

export interface UserProfile {
  id: string;
  username: string;
  name: string;
  email: string;
  phone?: string;
  isActive: boolean;
  createdAt: string;
  lastLogin?: string;
}

export interface NotificationPreferences {
  emailNotifications: boolean;
  smsNotifications: boolean;
  tradeAlerts: boolean;
  marginAlerts: boolean;
  dailySummary: boolean;
}

// ==================== Dashboard Types ====================

export interface DashboardStats {
  todayPnl: number;
  availableMargin: number;
  activeStrategies: number;
  totalStrategies: number;
  activeTrades: number;
  completedTrades: number;
}

// ==================== Subscription Types (re-export from strategy-engine) ====================

export interface UserSubscription {
  subscriptionId?: number;
  username: string;
  strategyName: string;
  brokerName: string;
  capital?: number;
  isActive: boolean;
  activatedAt?: string;
  deactivatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSubscriptionRequest {
  strategyName: string;
  brokerName: string;
  capital?: number;
}

export interface UpdateSubscriptionRequest {
  capital?: number;
}

// ==================== Common Types ====================

export interface DateRangeFilter {
  fromDate: string;
  toDate: string;
}

export interface PaginationParams {
  page: number;
  pageSize: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
