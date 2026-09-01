/**
 * Terminal Types
 * Types for the trading terminal - live user trade monitoring
 */

import type { Trade } from './trade';
import type { PaginationMeta } from './pagination';
import type { Product, SquareOffProduct } from './product';

/**
 * Terminal Position data structure - same for both algo and broker positions
 * (Different from Position in trade.ts which is for user portal)
 */
export interface TerminalPosition {
  broker: string;
  username: string;
  tradingSymbol: string;
  exchange: string;
  segment: string;
  productType: string;

  // Quantities
  buyQty: number;
  sellQty: number;
  netQty: number;

  // Prices
  buyAvgPrice: number;
  sellAvgPrice: number;
  netAvgPrice: number;
  cmp: number;           // Current market price
  spotCMP?: number;      // Spot price (for derivatives)
  strike?: number;       // Strike price (for options)

  // P&L
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  realizedPnlByEOD: number;
  unrealizedPnlByEOD: number;
  totalPnlByEOD: number;

  // True for a simulated (paper-trading) position from the virtual broker.
  isPaperTrading?: boolean;
}

/**
 * Exchange-specific summary for multi-exchange market hours handling.
 * Each exchange (NSE, BSE, MCX) has its own summary that can be
 * updated independently based on market hours.
 */
export interface ExchangeSummary {
  exchange: string;           // NSE, BSE, MCX
  isMarketOpen: boolean;      // Current market status

  // Trade counts for this exchange
  openTradesCount: number;
  activeTradesCount: number;
  completedTradesCount: number;
  cancelledTradesCount: number;
  trackLostTradesCount: number;

  // P&L for this exchange
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  totalCharges: number;
  netPnl: number;

  // Position counts for this exchange
  algoPositionsCount: number;
  brokerPositionsCount: number;

  // Mismatch info for this exchange
  mismatchCount: number;
  hasQtyMismatch: boolean;
  hasSymbolMismatch: boolean;
  hasPnlMismatch: boolean;

  // Metadata
  lastUpdatedAt: number;      // When this exchange data was last updated
  isStale: boolean;           // True if market closed and data is from close time
}

/**
 * Strategy-wise P&L breakdown
 */
export interface StrategySummary {
  strategy: string;
  displayName?: string;
  product?: string;
  activeTradesCount: number;
  completedTradesCount: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  charges: number;
  netPnl?: number;
  allocatedCapital?: number;
  returnsPercent?: number;
  // Paper-trading subset (UI derives live = total - paper).
  paperActiveTradesCount?: number;
  paperCompletedTradesCount?: number;
  paperRealizedPnl?: number;
  paperUnrealizedPnl?: number;
  paperTotalPnl?: number;
  paperCharges?: number;
  paperNetPnl?: number;
}

/**
 * Position mismatch between algo and broker
 */
export interface PositionMismatch {
  tradingSymbol: string;
  productType?: string;
  exchange?: string;
  segment?: string;

  // Algo position
  algoQty: number;
  algoAvgPrice: number;
  algoPnl: number;
  algoPnlByEOD?: number;
  existsInAlgo: boolean;

  // Broker position
  brokerQty: number;
  brokerAvgPrice: number;
  brokerPnl: number;
  existsInBroker: boolean;

  // Current market price
  cmp?: number;

  // Signed qty of option legs the system auto-completed as worthless after
  // market close that the broker still shows open — already subtracted from
  // the server's qty-mismatch math; subtract it client-side too when deriving
  // diffs from raw positions.
  systemCompletedQty?: number;

  // Mismatch details
  qtyDifference: number;
  pnlDifference: number;
  pnlDifferencePercent: number;
  hasQtyMismatch: boolean;
  hasSymbolMismatch: boolean;
  hasPnlMismatch: boolean;
  mismatchType: 'QTY' | 'SYMBOL' | 'PNL' | 'MULTIPLE';

  // True for a simulated (paper-trading) position.
  isPaperTrading?: boolean;
}

/**
 * Lightweight summary for WebSocket streaming
 * Updated every 2.5 seconds via WebSocket
 */
export interface UserTradeSummary {
  // User identification
  username: string;
  broker: string;
  clientID?: string;
  allocationModel?: string;

  // Trade counts by status (totals — include live + paper)
  openTradesCount: number;      // Orders placed but not filled
  activeTradesCount: number;    // Open positions (filled orders)
  completedTradesCount: number; // Closed trades today
  cancelledTradesCount: number; // Cancelled/rejected orders
  trackLostTradesCount: number; // Trades that lost tracking

  // Paper-trading subset of the open/active/completed counts above.
  // UI derives: live = total - paper, paper = paper, mixed = total.
  paperOpenTradesCount?: number;
  paperActiveTradesCount?: number;
  paperCompletedTradesCount?: number;
  paperCancelledTradesCount?: number;
  paperTrackLostTradesCount?: number;

  // Capital information
  totalCapital: number;
  externalCapital?: number;

  // P&L Summary
  realizedPnl: number;         // P&L from completed trades
  unrealizedPnl: number;       // P&L from active trades
  totalPnl: number;            // realizedPnl + unrealizedPnl
  totalCharges: number;        // Total brokerage + taxes
  netPnl: number;              // totalPnl - totalCharges
  returnsPercent: number;      // (netPnl / totalCapital) * 100

  // Algo vs Broker comparison
  algoPnl: number;
  brokerPnl: number;
  paperAlgoPnl?: number;           // paper-only portion of algoPnl
  paperBrokerPnl?: number;         // paper-only portion of brokerPnl
  // Paper-only portion of every other aggregated metric. UI derives
  // live = total - paper, paper = paper, mixed = total. (Capital is NOT
  // mode-split — always the configured totalCapital; margin/mismatch have no
  // paper twin since paper trades use no real margin and never reconcile.)
  paperRealizedPnl?: number;
  paperUnrealizedPnl?: number;
  paperTotalPnl?: number;
  paperTotalCharges?: number;
  paperNetPnl?: number;
  paperAlgoIntradayPnl?: number;
  paperAlgoPositionalPnl?: number;
  paperBrokerIntradayPnl?: number;
  paperBrokerPositionalPnl?: number;
  paperAlgoPositionsCount?: number;
  paperBrokerPositionsCount?: number;
  paperIntradayHedgeShortCount?: number;
  paperPositionalHedgeShortCount?: number;
  pnlDifference: number;           // brokerPnl - algoPnl
  pnlDifferencePercent: number;    // Percentage difference

  // Algo P&L breakdown by product type
  algoIntradayPnl: number;         // P&L from INTRADAY trades
  // NOTE: the server buckets ONLY Product.POSITIONAL here (UserTradeSummaryService) — CASHBUY and
  // MTF P&L land in neither split, so intraday + positional < algoPnl for equity users.
  algoPositionalPnl: number;       // P&L from POSITIONAL trades

  // Broker P&L breakdown by product type
  brokerIntradayPnl: number;       // P&L from MIS/CO/BO positions
  brokerPositionalPnl: number;     // P&L from NRML/CNC positions

  // Position summary
  algoPositionsCount: number;
  brokerPositionsCount: number;

  // Hedge-distance breakdown for ACTIVE POSITIONAL SHORT trades:
  //   intradayHedgeShortCount  — trades currently hedged at the strategy's intraday distance
  //   positionalHedgeShortCount — trades currently hedged at the strategy's positional distance
  // Rendered in the terminal row as "I-N P-M" badges so the operator can see at a
  // glance how many positional shorts are on each hedge distance without expanding
  // the row. Updated each summary refresh, so the values shift live as the
  // morning / evening hedge-replace flow swaps distances.
  intradayHedgeShortCount: number;
  positionalHedgeShortCount: number;

  // "Z" column — ACTIVE option trades whose CMP sits at the exchange floor
  // tick (0 < cmp <= 0.05): effectively worthless, typically deep-OTM legs on
  // expiry day. Rendered as a dark badge after the Trades column ("-" when 0).
  zeroPriceActiveTradesCount?: number;
  paperZeroPriceActiveTradesCount?: number;

  hasQtyMismatch: boolean;         // Any quantity mismatch
  hasSymbolMismatch: boolean;      // Symbol exists in one but not the other
  hasPnlMismatch: boolean;         // P&L difference > threshold (10%)
  mismatchSeverity: 'NONE' | 'WARNING' | 'CRITICAL';
  mismatchCount: number;           // Number of positions with mismatch

  // Margins
  totalMargin: number;
  utilizedMargin: number;
  availableMargin: number;
  marginUtilizationPercent: number;
  peakMarginUtilizationPercent: number;

  // riskProfile/brokerRiskProfile/paper* and strategySummaries were REMOVED from the summary —
  // the admin terminal fetches them on demand via /risk-profiles, /strategy-summaries and
  // /overall-breakdown (TerminalBreakdown), and the user portal computes risk client-side. This
  // keeps the per-position risk-profile + per-strategy aggregation off the 2.5s broadcast.

  // Exchange-wise breakdown (for multi-exchange market hours handling)
  // Key: exchange name (NSE, BSE, MCX), Value: exchange-specific summary
  exchangeSummaries?: Record<string, ExchangeSummary>;

  // Metadata
  lastUpdatedAt: number;          // Epoch millis
  status: 'LOADING' | 'READY' | 'ERROR' | 'STALE';
  errorMessage?: string;
  isLoggedIn: boolean;            // Whether broker session is active
}

/**
 * Detailed trade/position data - fetched on-demand
 */
/**
 * On-demand breakdown for a user-broker: strategy summaries and/or risk profiles. Served by the
 * dedicated /strategy-summaries, /risk-profiles, and /overall-breakdown endpoints (these used to
 * ride on UserTradeSummary). A given response only fills the half(s) its endpoint computes.
 */
export interface TerminalBreakdown {
  username: string;
  broker: string;
  strategySummaries: Record<string, StrategySummary>;
  riskProfile: Record<string, number>;
  brokerRiskProfile: Record<string, number>;
  paperRiskProfile: Record<string, number>;
  paperBrokerRiskProfile: Record<string, number>;
}

/** Per-section outcome of the 3 detail fetches (client-side metadata; not sent by the server). */
export interface DetailsSectionStatus {
  status: 'ok' | 'error';
  /** Error/timeout message to show in the section when status === 'error'. */
  message?: string;
}
export interface DetailsSectionStatusMap {
  trades?: DetailsSectionStatus;
  positions?: DetailsSectionStatus;
  margins?: DetailsSectionStatus;
}

export interface UserTradeDetails {
  username: string;
  broker: string;
  clientID?: string;

  /**
   * Client-side only: the outcome of each of the 3 scoped detail fetches (trades/positions/
   * margins). A section is present only if it was attempted (i.e. the caller is permitted);
   * 'error' carries the server/timeout message to render in that tab. Never sent by the server.
   */
  sectionStatus?: DetailsSectionStatusMap;

  // Trades by status
  openTrades: Trade[];
  activeTrades: Trade[];
  completedTrades: Trade[];
  cancelledTrades: Trade[];
  trackLostTrades: Trade[];

  // Positions (both algo and broker have same structure)
  algoPositions: TerminalPosition[];
  brokerPositions: TerminalPosition[];

  // Pre-calculated mismatches
  mismatches: PositionMismatch[];

  // Margins (if fetched)
  margins?: {
    totalMargin: number;
    utilizedMargin: number;
    availableMargin: number;
    collateral: number;
    cash: number;
  };
  peakMargins?: {
    totalMargin: number;
    utilizedMargin: number;
    availableMargin: number;
  };
}

/**
 * Alert data from server
 */
export interface AlertData {
  timestamp: string;
  alertLevel: 'CRITICAL' | 'WARNING' | 'INFO';
  entityType: string;
  entityName: string;
  operation: string;
  alertMessage: string;
}

/**
 * Lightweight notification for order/position updates
 */
export interface UpdateNotification {
  username: string;
  broker: string;
}

/**
 * WebSocket message types for terminal
 */
export interface TerminalWebSocketMessage {
  terminalSummaries?: UserTradeSummary[];
  type?: 'full' | 'delta';
  // Page window meta for the terminalSummaries payload (server paginates the
  // stream per-socket; matches the REST { data, pagination } envelope).
  pagination?: PaginationMeta;
  alert?: AlertData;
  // Lightweight notifications (just username + broker, not full data)
  orderUpdate?: UpdateNotification;
  positionUpdate?: UpdateNotification;
}

/**
 * Terminal filter options
 */
export interface TerminalFilters {
  username?: string;
  broker?: string;
  allocationModel?: string;
  showOnlyWithMismatch?: boolean;
  showOnlyWithActiveTrades?: boolean;
  showOnlyLoggedIn?: boolean;
  /** LOCAL filter: only user-broker rows with cancelled trades (live or paper). */
  showOnlyCancelled?: boolean;
  sortBy?: 'username' | 'algoPnl' | 'algoPercent' | 'brokerPnl' | 'brokerPercent' | 'mismatchSeverity' | 'activeTradesCount' | 'capital';
  sortOrder?: 'asc' | 'desc';
}

/**
 * Square off request for terminal
 */
export interface TerminalSquareOffRequest {
  username: string;
  broker: string;
  clientID?: string;
  product: SquareOffProduct;
  strategies?: string[];      // Optional: only squareoff specific strategies
}

/**
 * Alter trade request
 */
export interface AlterTradeRequest {
  action: 'completeTrade' | 'alterExitPrice' | 'resetTrade' | 'completeTradeBulk';
  username: string;
  broker: string;
  tradeIds?: string[];
  exitPrice?: number;
  remarks?: string;
}

export interface BulkCompleteTradeItem {
  username: string;
  broker: string;
  tradeID: string;
  exitPrice: number;
  exitDate?: string;
}

export interface BulkCompleteTradeResult {
  tradeID: string;
  status: 'success' | 'error';
  message: string;
}

export interface ActiveTradeCatalogItem {
  username: string;
  broker: string;
  tradeID: string;
  strategy: string;
  tradingSymbol: string;
  product: string;
  productType: string;
  group?: string;
  direction: 'LONG' | 'SHORT';
  quantity: number;
  filledQuantity: number;
  entry: number;
  cmp: number;
  startTimestamp: number;
}

/**
 * Exit position request
 */
export interface ExitPositionRequest {
  username: string;
  broker: string;
  clientID?: string;
  positions: Array<{
    tradingSymbol: string;
    direction: 'LONG' | 'SHORT';
    qty: number;
    productType: string;
    exchange: string;
    segment?: string;
    isPaperTrading?: boolean;
  }>;
}

/**
 * Refresh summary request
 */
export interface RefreshSummaryRequest {
  username: string;
  broker: string;
  fetchBrokerPositions?: boolean;
  fetchMargins?: boolean;
}

/**
 * Terminal action result
 */
export interface TerminalActionResult {
  success: boolean;
  status?: string;   // Server status message (from data.data.status)
  message?: string;
  orderIds?: string[];
  errors?: Array<{
    tradingSymbol?: string;
    tradeId?: string;
    error: string;
  }>;
}

/**
 * Immediate response from a bulk (async) square-off request. The server kicks
 * off the work on a background thread and returns a jobId for polling.
 */
export interface SquareOffStartResponse {
  jobId: string;
  status: 'started';
  usersTotal: number;
  message?: string;
  statusUrl: string;
}

/**
 * Status snapshot of an async square-off job (GET /trades/squareoff/status/{jobId}).
 */
export interface SquareOffJobStatus {
  jobId: string;
  requestedBy?: string;
  scope?: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  usersTotal: number;
  usersProcessed: number;
  usersFailed: number;
  tradesEnqueued: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  error?: string;
}

/**
 * Exit position result item - returned for each position in the exit request
 */
export interface ExitPositionResultItem {
  tradingSymbol: string;
  qty: number;
  status: 'success' | 'error' | 'partial';
  orderIds?: string[];
  message?: string;
}

/**
 * Exit positions response - array of result items
 */
export type ExitPositionsResponse = ExitPositionResultItem[];

/**
 * Trade signal type enum
 */
export type TradeSignalType = 'LONG_ENTRY' | 'SHORT_ENTRY' | 'LONG_EXIT' | 'SHORT_EXIT';

/**
 * Trade signal - represents a signal generated by a strategy
 */
export interface TradeSignal {
  tradeSignalID: string;
  signalGenerationTime: number;  // Instant as epoch millis
  product: Product;
  tradeSignalType: TradeSignalType;

  username: string;
  broker: string;
  clientID?: string;
  segment?: string;
  exchange: string;

  strategy: string;
  group: string;
  tranch: number;
  tradingSymbol: string;
  direction: 'LONG' | 'SHORT';
  productType?: string;

  trigger: number;
  target: number;
  stopLoss: number;
  quantity: number;
  quantityPerLot: number;
  contractMultiplier?: number;  // Units per lot (e.g., 100 for CRUDEOIL)
  timestamp: number;  // Instant as epoch millis
  isTriggered: boolean;
  disabled: boolean;
  disabledReason?: string;

  tradeCutOffTime?: number;  // Instant as epoch millis
  cancelUnfilledOrderAt?: number;  // Instant as epoch millis
  validTill?: number;  // Instant as epoch millis

  isFutures: boolean;
  isOptions: boolean;
  optionType?: 'CE' | 'PE';
  baseStrike?: number;

  remarks?: string;
  reEntryCount?: number;
  currentTradeCount?: number;
  maxTradesPerStock?: number;
  slice?: number;

  hedgeCorrelationID?: string;
  hedgeDistancePercentage?: number;
  pairTradeCorrelationID?: string;

  placeMarketOrder?: boolean;
  noStopLoss?: boolean;
  noTarget?: boolean;
  isPaperTrading?: boolean;
  isMock?: boolean;
}

/**
 * Order status history entry
 */
export interface OrderStatusHistoryEntry {
  orderStatus: string;
  lastUpdatedTimestamp: number;
}

/**
 * Order type history entry
 */
export interface OrderTypeHistoryEntry {
  orderType: string;
  lastUpdatedTimestamp: number;
}

/**
 * Order details from broker order book
 * Represents a single order with all its attributes
 */
export interface OrderDetails {
  orderId: string;
  username: string;
  broker: string;
  clientID?: string;
  exchange: string;
  segment?: string;
  productType: string;           // MIS, NRML, CNC
  tradingSymbol: string;

  orderStatus: string;           // Latest status
  orderStatusHistory?: OrderStatusHistoryEntry[];

  orderType: string;             // LIMIT, MARKET, SL, SL-M
  orderTypeHistory?: OrderTypeHistoryEntry[];

  tradeID?: string;              // Associated algo trade ID (if any)

  price: number;
  triggerPrice: number;
  averagePrice: number;
  direction: 'LONG' | 'SHORT';

  quantity: number;
  filledQuantity: number;
  pendingQuantity: number;
  disclosedQuantity?: number;

  orderPlacedTimestamp?: number;
  orderExecutedTimestamp?: number;
  lastOrderUpdateTimestamp?: number;
  exchangeLastUpdateTimestamp?: number;

  parentOrderId?: string;        // For BO/CO orders
  exchangeOrderId?: string;
  systemOrderId?: string;        // System-generated order tag (JK prefix identifies algo orders)

  message?: string;              // Status message / rejection reason
  numModifyRequests?: number;
  strategy?: string;

  /** Indicates if this order was placed by the algo system (true) or externally (false) */
  isAlgoOrder?: boolean;

  /** True for a simulated (paper-trading) order from the virtual broker. */
  isPaperTrading?: boolean;
}

/**
 * Live external (manual) intraday P&L for one user+broker, computed on demand from the current order
 * book (external, COMPLETE, MIS option orders). Realized P&L from FIFO-matched legs; open positions
 * are marked-to-market at CMP and charged as if squared off at CMP.
 */
export interface ExternalPnlLiveDetails {
  username: string;
  broker: string;

  capital: number; // external (manual) capital

  grossPnl: number;      // realizedPnl + unrealizedPnl
  realizedPnl: number;
  unrealizedPnl: number;

  // Charge breakdown (includes notional square-off of open positions at CMP)
  brokerage: number;
  transactionCharges: number; // exchange turnover charges
  sebiCharges: number;
  sttCharges: number;
  stampDutyCharges: number;
  gstCharges: number;
  totalCharges: number;

  netPnl: number; // grossPnl - totalCharges

  openPositionsCount: number;
  fetchedAt: number; // epoch millis

  symbols: ExternalPnlSymbolRow[];
  warnings: string[];
}

/** Per-symbol external intraday P&L detail. */
export interface ExternalPnlSymbolRow {
  tradingSymbol: string;
  exchange: string;
  netOpenQty: number;   // signed: >0 long, <0 short, 0 flat
  cmp: number;
  realizedPnl: number;
  unrealizedPnl: number;
  pnl: number;
  charges: number;
}
