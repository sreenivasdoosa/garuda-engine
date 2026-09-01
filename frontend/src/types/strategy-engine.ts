/**
 * Strategy Engine types - Event-driven strategy execution engine
 */

// ==================== Enums ====================

export type StrategyStatus = 'ACTIVE' | 'WIND_DOWN' | 'INACTIVE';
export type StrategyScope = 'SYSTEM' | 'USER';

// Product (and the tradable-product helpers) live in ./product — the single source of truth
// shared by the terminal, reports and strategy screens. Re-exported here for existing importers.
import type { Product } from './product';

export type { Product, TradableProduct, SquareOffProduct } from './product';
export {
  TRADABLE_PRODUCTS,
  PRODUCT_LABELS,
  PRODUCT_BADGE_BG,
  PRODUCT_BADGE_TONE,
  productLabel,
  productBadgeBg,
  productBadgeTone,
} from './product';

/** Top-level asset class of a strategy template (equity vs F&O). */
export type AssetClass = 'EQUITY' | 'FNO';

/** Equity position-sizing model (see backend EquitySizingModel). */
export type EquitySizingModel = 'FIXED_AMOUNT_PER_STOCK' | 'MAX_POSITIONS_EQUAL_SPLIT' | 'MAX_RISK_PER_TRADE';

/** Index-reconstitution policy for predefined stock universes. */
export type OnIndexRemoval = 'HOLD_UNTIL_EXIT' | 'EXIT_IMMEDIATELY';

export type TradeMode = 'OPTION_SELLING' | 'OPTION_BUYING' | 'FUTURES' | 'FUTURES_OPTIONS' | 'EQUITY';

export const TRADE_MODES: { value: TradeMode; label: string; description: string }[] = [
  { value: 'OPTION_SELLING', label: 'Option Selling', description: 'Sell/write options (straddle, strangle, directional selling)' },
  { value: 'OPTION_BUYING', label: 'Option Buying', description: 'Buy options (long calls, long puts, debit spreads)' },
  { value: 'FUTURES', label: 'Futures', description: 'Trade futures (long or short based on direction)' },
  { value: 'FUTURES_OPTIONS', label: 'Futures + Options', description: 'Combined futures and options strategies (reserved)' },
  { value: 'EQUITY', label: 'Equity', description: 'Cash equity / stock trading (long only)' },
];

export type ExpiryType = 'WEEKLY' | 'MONTHLY';

export type UnderlyingType = 'INDEX' | 'FUTURE' | 'SYNTHETIC_FUTURE';

export type DirectionProviderType = 'CANDLE' | 'PCR' | 'IV_SKEW' | 'FIXED' | 'INDICATOR' | 'N_BARS_BREAKOUT';

// Direction provider comparison modes for CANDLE provider
export type CandleComparisonMode = 'CMP_VS_REF' | 'REF_VS_REF';

// Reference time options for CANDLE provider
export type CandleReferenceTime = 'MARKET_OPEN' | 'MARKET_CLOSE' | string; // string for specific time HH:mm:ss

// Price type options
export type CandlePriceType = 'OPEN' | 'HIGH' | 'LOW' | 'CLOSE';

// Direction provider configurations
export const DIRECTION_PROVIDER_TYPES: { value: DirectionProviderType; label: string; description: string }[] = [
  { value: 'INDICATOR', label: 'Indicator-based', description: 'Direction based on technical indicators (Supertrend, RSI, etc.)' },
  { value: 'CANDLE', label: 'Candle-based', description: 'Direction based on price comparisons at specific times' },
  { value: 'PCR', label: 'PCR-based', description: 'Direction based on Put-Call Ratio' },
  { value: 'IV_SKEW', label: 'IV Skew-based', description: 'Direction based on IV difference between CE and PE' },
  { value: 'FIXED', label: 'Fixed Direction', description: 'Always use same direction (LONG or SHORT)' },
  { value: 'N_BARS_BREAKOUT', label: 'N-Bar Breakout', description: 'Direction from rolling N-bar high/low breakout on the underlying spot candles' },
];

// Same as legacy strategy - uses short codes
export type TradableDay = 'E' | 'DT1' | 'DT2' | 'M' | 'T' | 'W' | 'TH' | 'F';

export const TRADABLE_DAYS: { value: TradableDay; label: string; group: 'expiry' | 'weekday' }[] = [
  { value: 'E', label: 'Expiry Day', group: 'expiry' },
  { value: 'DT1', label: 'DT-1 (Day before)', group: 'expiry' },
  { value: 'DT2', label: 'DT-2 (Two days before)', group: 'expiry' },
  { value: 'M', label: 'Monday', group: 'weekday' },
  { value: 'T', label: 'Tuesday', group: 'weekday' },
  { value: 'W', label: 'Wednesday', group: 'weekday' },
  { value: 'TH', label: 'Thursday', group: 'weekday' },
  { value: 'F', label: 'Friday', group: 'weekday' },
];

export type SignalAction = 'BUY' | 'SELL' | 'CLOSE' | 'ADJUST';

export type SignalStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';

// ==================== Indicator Rules ====================

/**
 * Indicator types for rule conditions
 */
export type IndicatorType = 'SUPERTREND' | 'RSI' | 'SMA' | 'EMA' | 'BOLLINGER' | 'ATR' | 'VWAP' | 'PRICE';

/**
 * Comparator operators for rule conditions
 */
export type RuleComparator =
  | 'GREATER_THAN'
  | 'LESS_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN_OR_EQUAL'
  | 'EQUAL'
  | 'NOT_EQUAL'
  | 'CROSS_ABOVE'
  | 'CROSS_BELOW'
  | 'FLIP';

/**
 * Direction result from rule evaluation
 */
export type RuleDirection = 'LONG' | 'SHORT';

/**
 * Candle interval types (matching backend HistDataIntervals)
 */
export type CandleInterval = '1minute' | '5minute' | '15minute' | '30minute' | '60minute' | 'day';

/**
 * Bollinger band types for sub-indicator selection
 */
export type BollingerBandType = 'UPPER' | 'MIDDLE' | 'LOWER';

/**
 * Price types for PRICE indicator
 */
export type PriceType = 'CLOSE' | 'OPEN' | 'HIGH' | 'LOW';

/**
 * Rule condition - a single indicator comparison
 */
export interface RuleCondition {
  indicator: IndicatorType;
  params: Record<string, number | string>;  // e.g., { period: 14 } or { period: 20, multiplier: 2.0 }
  interval: CandleInterval;
  comparator: RuleComparator;
  // Value can be numeric (e.g., RSI > 30) or string (e.g., SUPERTREND = 'GREEN')
  value?: number | string;
  // For indicator-to-indicator comparison (e.g., PRICE CROSS_ABOVE EMA)
  referenceIndicator?: IndicatorType;
  referenceParams?: Record<string, number | string>;
  referenceInterval?: CandleInterval;  // Timeframe for reference indicator (defaults to main interval if not set)
}

/**
 * Rule node - either an operator (AND/OR) or a condition
 */
export interface RuleNode {
  type: 'operator' | 'condition';
  // For operator nodes
  operator?: 'AND' | 'OR';
  children?: RuleNode[];
  // For condition nodes
  condition?: RuleCondition;
}

/**
 * Direction rules - determines WHICH side to trade (LONG or SHORT)
 *
 * Used when strategy.directional=true to determine which side to trade.
 * Evaluation order:
 * 1. Evaluate longRules - if TRUE, direction is LONG (sell PE)
 * 2. Else evaluate shortRules - if TRUE, direction is SHORT (sell CE)
 * 3. If neither matches, no direction (falls back to Direction Provider or no entry)
 */
export interface DirectionRules {
  longRules?: RuleNode;   // Rules for LONG direction (bullish - sell PE)
  shortRules?: RuleNode;  // Rules for SHORT direction (bearish - sell CE)
}

/**
 * Indicator rule set - simplified design for entry/direction/exit rules
 *
 * Design Philosophy:
 * - entryRules: Determines WHEN to enter (TRUE/FALSE)
 * - directionRules: Determines WHICH side to trade (LONG/SHORT) - optional
 * - Strategy's directional flag determines ONE side vs BOTH sides
 *
 * Flow:
 * 1. Evaluate entryRules -> TRUE or FALSE
 * 2. If FALSE -> no entry
 * 3. If TRUE:
 *    - If strategy.directional=false -> sell BOTH CE and PE
 *    - If strategy.directional=true:
 *      - If directionRules configured -> evaluate to get LONG or SHORT
 *      - Else -> use Direction Provider (fallback)
 */
export interface IndicatorRuleSet {
  strategyName: string;

  // Entry rules - evaluates to TRUE/FALSE
  // Determines WHEN to enter a trade
  entryRules?: RuleNode;

  // Direction rules - determines WHICH side to trade
  // Only used when strategy.directional=true
  // Contains separate LONG and SHORT rule trees
  directionRules?: DirectionRules;

  // Exit rules - optional indicator-based exit conditions
  exitRules?: RuleNode;

  // Whether to use indicator-based exit rules
  useIndicatorExit: boolean;
}


/**
 * Indicator definitions for UI display and configuration
 */
export const INDICATOR_DEFINITIONS: {
  value: IndicatorType;
  label: string;
  description: string;
  params: { name: string; label: string; defaultValue: number | string; type: 'number' | 'select'; options?: string[] }[];
  valueType: 'numeric' | 'string' | 'band';  // 'band' for Bollinger
  stringValues?: string[];  // For string comparisons like SUPERTREND
}[] = [
  {
    value: 'SUPERTREND',
    label: 'Supertrend',
    description: 'Trend following indicator based on ATR',
    params: [
      { name: 'period', label: 'ATR Period', defaultValue: 10, type: 'number' },
      { name: 'multiplier', label: 'Multiplier', defaultValue: 3.0, type: 'number' },
    ],
    valueType: 'string',
    stringValues: ['GREEN', 'RED'],
  },
  {
    value: 'RSI',
    label: 'RSI',
    description: 'Relative Strength Index (0-100)',
    params: [
      { name: 'period', label: 'Period', defaultValue: 14, type: 'number' },
    ],
    valueType: 'numeric',
  },
  {
    value: 'SMA',
    label: 'SMA',
    description: 'Simple Moving Average',
    params: [
      { name: 'period', label: 'Period', defaultValue: 20, type: 'number' },
    ],
    valueType: 'numeric',
  },
  {
    value: 'EMA',
    label: 'EMA',
    description: 'Exponential Moving Average',
    params: [
      { name: 'period', label: 'Period', defaultValue: 20, type: 'number' },
    ],
    valueType: 'numeric',
  },
  {
    value: 'BOLLINGER',
    label: 'Bollinger Bands',
    description: 'Bollinger Bands (upper/middle/lower)',
    params: [
      { name: 'period', label: 'Period', defaultValue: 20, type: 'number' },
      { name: 'stdDev', label: 'Std Dev', defaultValue: 2.0, type: 'number' },
      { name: 'bandType', label: 'Band', defaultValue: 'MIDDLE', type: 'select', options: ['UPPER', 'MIDDLE', 'LOWER'] },
    ],
    valueType: 'band',
  },
  {
    value: 'ATR',
    label: 'ATR',
    description: 'Average True Range - measures volatility',
    params: [
      { name: 'period', label: 'Period', defaultValue: 14, type: 'number' },
    ],
    valueType: 'numeric',
  },
  {
    value: 'VWAP',
    label: 'VWAP',
    description: 'Volume Weighted Average Price',
    params: [],
    valueType: 'numeric',
  },
  {
    value: 'PRICE',
    label: 'Price',
    description: 'Candle price (close, open, high, low)',
    params: [
      { name: 'type', label: 'Price Type', defaultValue: 'CLOSE', type: 'select', options: ['CLOSE', 'OPEN', 'HIGH', 'LOW'] },
    ],
    valueType: 'numeric',
  },
];

/**
 * Comparator definitions for UI display
 */
export const COMPARATOR_DEFINITIONS: {
  value: RuleComparator;
  label: string;
  symbol: string;
  requiresReference: boolean;  // True for CROSS_ABOVE/CROSS_BELOW
  forSupertrend?: boolean;     // True if this comparator is for Supertrend state transitions
}[] = [
  { value: 'GREATER_THAN', label: 'Greater than', symbol: '>', requiresReference: false },
  { value: 'LESS_THAN', label: 'Less than', symbol: '<', requiresReference: false },
  { value: 'GREATER_THAN_OR_EQUAL', label: 'Greater or equal', symbol: '≥', requiresReference: false },
  { value: 'LESS_THAN_OR_EQUAL', label: 'Less or equal', symbol: '≤', requiresReference: false },
  { value: 'EQUAL', label: 'Equal', symbol: '=', requiresReference: false },
  { value: 'NOT_EQUAL', label: 'Not equal', symbol: '≠', requiresReference: false },
  { value: 'CROSS_ABOVE', label: 'Crosses above', symbol: '↗', requiresReference: true },
  { value: 'CROSS_BELOW', label: 'Crosses below', symbol: '↘', requiresReference: true },
  { value: 'FLIP', label: 'Flips to', symbol: '⟳', requiresReference: false, forSupertrend: true },
];

/**
 * Candle interval definitions for UI display
 */
export const CANDLE_INTERVAL_DEFINITIONS: {
  value: CandleInterval;
  label: string;
}[] = [
  { value: '1minute', label: '1 Min' },
  { value: '5minute', label: '5 Min' },
  { value: '15minute', label: '15 Min' },
  { value: '30minute', label: '30 Min' },
  { value: '60minute', label: '1 Hour' },
  { value: 'day', label: 'Daily' },
];

// ==================== Strategy Template ====================

/**
 * Strategy template - reusable strategy logic blueprint
 */
export interface StrategyTemplate {
  templateName: string;
  displayName: string;
  /**
   * W4 tiering: generic templates (false) are never shown or chosen — they are derived from the
   * strategy's intent. Only custom-logic templates (true) appear in the form's optional picker.
   */
  isUserSelectable?: boolean;
  description?: string;
  evaluatorClass: string;
  supportsTickTrigger: boolean;
  supportsScheduledTrigger: boolean;
  supportsSignalTrigger: boolean;
  supportsPeriodicTrigger: boolean;
  supportsHedgeManagement: boolean;
  isFnO: boolean;
  /** Top-level asset class (EQUITY|FNO). Complements isFnO; defaults to FNO. */
  assetClass?: AssetClass;
  supportTranches: boolean;
  defaultConfig?: string; // JSON string
  version: number;
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateStrategyTemplateRequest {
  templateName: string;
  displayName: string;
  description?: string;
  evaluatorClass: string;
  supportsTickTrigger?: boolean;
  supportsScheduledTrigger?: boolean;
  supportsSignalTrigger?: boolean;
  supportsPeriodicTrigger?: boolean;
  supportsHedgeManagement?: boolean;
  isFnO?: boolean;
  assetClass?: AssetClass;
  supportTranches?: boolean;
  defaultConfig?: string;
}

export interface UpdateStrategyTemplateRequest extends Partial<CreateStrategyTemplateRequest> {}

// ==================== Strategy Definition ====================

/**
 * Strategy definition - enhanced strategy instance
 */
export interface StrategyDefinition {
  strategyId?: number;
  strategyName: string;
  displayName?: string;
  displayOrder?: number;
  templateName: string;
  fnoSymbolName: string;
  exchange: string;
  product: Product;
  tradeMode?: TradeMode;  // OPTION_SELLING (default), OPTION_BUYING, FUTURES, etc.
  // Trigger type flags - enable multiple trigger types for a strategy
  tickTriggerEnabled: boolean;
  scheduledTriggerEnabled: boolean;
  signalTriggerEnabled: boolean;
  periodicTriggerEnabled: boolean;
  // Timing
  startTime?: string; // HH:mm:ss
  stopTime?: string;  // HH:mm:ss
  tradableDays?: string; // JSON array: ["E","DT1","DT2","M","T","W","TH","F"] - whitelist
  excludedDays?: string; // JSON array: ["E","DT1","DT2","M","T","W","TH","F"] - blacklist
  // Capital
  capitalPerLot?: number;
  capitalPerLotHedged?: number;   // Capital per lot when hedging enabled
  capitalPerLotNaked?: number;    // Capital per lot when hedging disabled
  isOverlapCapital: boolean;
  // F&O settings
  expiryType?: ExpiryType;
  excludeMonthlyExpiry?: boolean;  // For weekly strategies: skip monthly expiry week
  usePremiumBalancing?: boolean;   // Use premium-balanced selection vs simple ATM
  underlyingType?: UnderlyingType;
  hedgeDistancePercentageIntraday?: number;
  hedgeDistancePercentagePositional?: number;
  // Trading behavior
  isDirectional: boolean;
  // Direction provider configuration (for directional strategies)
  directionProviderType?: DirectionProviderType;
  directionProviderParams?: string; // JSON string from API, parsed to object in UI
  /** Declared combo shape as a JSON string; absent for a non-combo strategy. See ComboSpec. */
  comboSpecJson?: string;
  /** Which leg goes on first; undefined = the shape's default. */
  entryLegOrder?: EntryLegOrder;
  /** Which leg comes off first; undefined = REVERSE_ENTRY. */
  exitLegOrder?: ExitLegOrder;
  // Ownership & Scope
  username?: string;  // Owner of the definition
  isPublic?: boolean; // Visibility: true = visible to all, false = private
  scope?: StrategyScope; // SYSTEM = admin-created (only admin assigns), USER = user-created (users can self-subscribe)
  // Mock-trading flag: participates only in admin-toggled mock sessions.
  // Server enforces product=INTRADAY for any definition where this is true.
  isMock?: boolean;
  // Reactivation behavior
  catchUpMissedTranches?: boolean; // When reactivated, schedule missed tranches
  // Adaptive mode (maxTranches moved to StrategyConfigTree)
  adaptiveTranchesEnabled?: boolean; // Enable adaptive/cascading tranch mode
  // Periodic evaluation settings (used when periodicTriggerEnabled=true)
  periodicIntervalMinutes?: number; // Interval in minutes (1-240)
  periodicOffsetSeconds?: number; // Offset in seconds after minute boundary (0-15)
  // Hedge window replace - only for POSITIONAL strategies
  hedgeReplaceEnabled?: boolean; // Enable automatic hedge replacement windows (morning/evening)
  hedgeMorningStartOffset?: number; // Minutes after market open for morning window start (default 1)
  hedgeMorningEndOffset?: number;   // Minutes after market open for morning window end (default 15)
  hedgeEveningStartOffset?: number; // Minutes before market close for evening window start (default 10)
  hedgeEveningEndOffset?: number;   // Minutes before market close for evening window end (default 2)
  // Risk allocation configuration
  riskPercentage?: number;       // Default risk % of capital per day (e.g., 1.5 = 1.5%)
  absoluteMaxRisk?: number;      // Alternative: absolute max risk amount (overrides percentage)
  minRiskPercentage?: number;    // Floor for user override (strategy level only)
  maxRiskPercentage?: number;    // Ceiling for user override (strategy level only)
  // Equity leverage & sizing (tradeMode === 'EQUITY')
  universeId?: number;            // Stock-universe binding
  leverage?: number;             // Strategy-level default leverage
  minLeverage?: number;          // Floor for user leverage override
  maxLeverage?: number;          // Ceiling for user leverage override
  equitySizingModel?: EquitySizingModel;
  fixedAmountPerStock?: number;  // Model A: fixed rupee amount per stock
  maxActivePositions?: number;   // Model B: capital / max concurrent positions
  maxRiskPctPerTrade?: number;   // Model C: % of capital risked per trade
  onIndexRemoval?: OnIndexRemoval; // Predefined-index reconstitution policy
  // Status - controls what operations are allowed
  status: StrategyStatus;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Shape of directionProviderParams when directionProviderType === 'N_BARS_BREAKOUT'.
 * Used by NBarsBreakoutDirectionProvider (timeframeMinutes + lookbackBars) and
 * by AdaptiveOptionsEvaluator (the rest, for re-entry / SL-Target / window
 * gating). All values are stringified when stored — this interface is the
 * pre-stringification shape.
 */
export interface NBarsBreakoutParams {
  timeframeMinutes?: number;
  lookbackBars?: number;
  stoplossPct?: number;
  targetPct?: number | null;
  maxReentries?: number; // 0 = unlimited
  tradingWindowStart?: string; // HH:mm
  tradingWindowEnd?: string;   // HH:mm
  dte?: number;
  fixedLots?: number | null;
  expiryDayCutoffTime?: string; // HH:mm
}

export interface CreateStrategyDefinitionRequest {
  strategyName: string;
  displayName?: string;
  displayOrder?: number;
  templateName: string;
  fnoSymbolName: string;
  exchange: string;
  product?: Product;
  tradeMode?: TradeMode;
  // Trigger type flags
  tickTriggerEnabled?: boolean;
  scheduledTriggerEnabled?: boolean;
  signalTriggerEnabled?: boolean;
  periodicTriggerEnabled?: boolean;
  startTime?: string;
  stopTime?: string;
  tradableDays?: string;
  excludedDays?: string;
  capitalPerLot?: number;
  capitalPerLotHedged?: number;
  capitalPerLotNaked?: number;
  isOverlapCapital?: boolean;
  expiryType?: ExpiryType;
  excludeMonthlyExpiry?: boolean;
  usePremiumBalancing?: boolean;
  underlyingType?: UnderlyingType;
  hedgeDistancePercentageIntraday?: number;
  hedgeDistancePercentagePositional?: number;
  isDirectional?: boolean;
  directionProviderType?: DirectionProviderType;
  directionProviderParams?: string; // JSON string sent to API
  /** Declared combo shape as a JSON string; omit for a non-combo strategy. */
  comboSpecJson?: string;
  entryLegOrder?: EntryLegOrder;
  exitLegOrder?: ExitLegOrder;
  isPublic?: boolean;
  // Mock-trading flag — see StrategyDefinition.isMock for semantics.
  isMock?: boolean;
  scope?: StrategyScope;
  catchUpMissedTranches?: boolean;
  adaptiveTranchesEnabled?: boolean;
  periodicIntervalMinutes?: number;
  periodicOffsetSeconds?: number;
  hedgeReplaceEnabled?: boolean;
  hedgeMorningStartOffset?: number;
  hedgeMorningEndOffset?: number;
  hedgeEveningStartOffset?: number;
  hedgeEveningEndOffset?: number;
  // Risk allocation
  riskPercentage?: number;
  absoluteMaxRisk?: number;
  minRiskPercentage?: number;
  maxRiskPercentage?: number;
  // Equity leverage & sizing (tradeMode === 'EQUITY')
  universeId?: number;
  leverage?: number;
  minLeverage?: number;
  maxLeverage?: number;
  equitySizingModel?: EquitySizingModel;
  fixedAmountPerStock?: number;
  maxActivePositions?: number;
  maxRiskPctPerTrade?: number;
  onIndexRemoval?: OnIndexRemoval;
}

export interface UpdateStrategyDefinitionRequest extends Partial<CreateStrategyDefinitionRequest> {}

// ==================== User Strategy Subscription ====================

/**
 * User strategy subscription - user-strategy linkage for event-driven engine
 * Simplified model after V123 migration - only tracks user, strategy, broker, capital
 */
export interface UserStrategySubscription {
  subscriptionId?: number;
  username: string;
  strategyName: string;
  brokerName: string;
  capital?: number;
  // Risk allocation overrides (optional - uses strategy defaults if not set)
  riskPercentage?: number;   // Override risk % of capital per day
  absoluteMaxRisk?: number;  // Override absolute max risk amount
  // Equity overrides (optional): leverage clamped to strategy [minLeverage, maxLeverage]
  leverage?: number;
  maxActivePositions?: number;
  isActive: boolean;
  isPaperTrading?: boolean;  // Paper-trading mode: simulate orders, no real broker order placed
  activatedAt?: string;
  deactivatedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateUserSubscriptionRequest {
  username: string;
  strategyName: string;
  brokerName: string;
  capital?: number;
  riskPercentage?: number;
  absoluteMaxRisk?: number;
  leverage?: number;
  maxActivePositions?: number;
  isActive?: boolean;
  isPaperTrading?: boolean;
}

export interface UpdateUserSubscriptionRequest {
  capital?: number;
  riskPercentage?: number;
  absoluteMaxRisk?: number;
  leverage?: number;
  maxActivePositions?: number;
  isActive?: boolean;
  isPaperTrading?: boolean;
}

// ==================== Tranch Schedule ====================

/**
 * Tranch schedule - scheduled execution time for strategy tranches
 */
export interface TranchSchedule {
  scheduleId?: number;
  strategyName: string;
  tranchNumber: number;
  scheduledTime: string; // HH:mm:ss
  minGapSeconds: number;
  maxPositionsPerTranch?: number;
  validFrom?: string; // yyyy-MM-dd
  validUntil?: string; // yyyy-MM-dd
  isActive: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTranchScheduleRequest {
  strategyName: string;
  tranchNumber: number;
  scheduledTime: string;
  minGapSeconds?: number;
  maxPositionsPerTranch?: number;
  validFrom?: string;
  validUntil?: string;
}

export interface UpdateTranchScheduleRequest extends Partial<CreateTranchScheduleRequest> {}

// ==================== External Signal ====================

/**
 * External signal - signal queue entry for processing
 */
export interface ExternalSignal {
  signalId?: number;
  source: string; // TELEGRAM, API, WEBHOOK, etc.
  sourceReference?: string; // Message ID, Request ID, etc.
  strategyName?: string;
  symbol?: string;
  action: SignalAction;
  payload?: string; // JSON payload
  status: SignalStatus;
  processedAt?: string;
  errorMessage?: string;
  receivedAt?: string;
}

export interface CreateExternalSignalRequest {
  source: string;
  sourceReference?: string;
  strategyName?: string;
  symbol?: string;
  action: SignalAction;
  payload?: string;
}

export interface CancelSignalRequest {
  reason?: string;
}

// ==================== Engine Status & Metrics ====================

/**
 * Engine status snapshot for a specific exchange
 */
export interface ExchangeEngineStatus {
  exchange: string;
  running: boolean;
  dryRunMode: boolean;
  activeSubscriptions: number;
  scheduledTranches: number;
  executedTranches: number;
  scheduledHedges?: number;
  executedHedges?: number;
}

/**
 * All exchanges engine status
 */
export interface AllEnginesStatus {
  exchanges: ExchangeEngineStatus[];
  activeEngines: number;
}

/**
 * Legacy engine status (for backwards compatibility)
 * @deprecated Use ExchangeEngineStatus instead
 */
export interface EngineStatus {
  running: boolean;
  dryRunMode: boolean;
  activeSubscriptions: number;
  eventsProcessed: number;
  signalsGenerated: number;
  ticksPublished: number;
  scheduledTranches: number;
  scheduledHedges: number;
}

/**
 * Hedge window for morning/evening replace
 */
export interface HedgeWindow {
  type: 'MORNING' | 'EVENING';
  action: 'REPLACE';
  windowStart: string;
  windowEnd: string;
  targetDistance: number;
  description: string;
  status: 'SCHEDULED' | 'ACTIVE' | 'COMPLETED';
  nonExpiryOnly?: boolean;
  // Replace OUTCOME counts (from the strategy's SHORT trades) — reflect what actually happened,
  // independent of the time-based `status`. A window can be time-COMPLETED with replaceDone=0.
  replaceTotal?: number;
  replaceDone?: number;
  replaceFailed?: number;
  replacePending?: number;
}

/**
 * Hedge window details for a strategy
 */
export interface HedgeWindowStrategy {
  strategyName: string;
  product: 'POSITIONAL' | 'LEGACY';
  intradayDistancePercent?: number;
  positionalDistancePercent?: number;
  morningWindow?: HedgeWindow;
  eveningWindow?: HedgeWindow;
  pendingTasks: number;
  // Legacy format
  windows?: Array<{
    type: string;
    windowStart: string;
    windowEnd: string;
    isActive: boolean;
    status?: string;
  }>;
}

/**
 * Hedge window summary stats
 */
export interface HedgeWindowSummary {
  exchange: string;
  running: boolean;
  registeredStrategies: number;
  legacyConfigs: number;
  scheduledTasks: number;
  executedTasks: number;
  windowTimes?: {
    morningStart: string;
    morningEnd: string;
    eveningStart: string;
    eveningEnd: string;
  };
}

/**
 * Detailed engine metrics for a specific exchange
 */
export interface ExchangeEngineMetrics {
  status: ExchangeEngineStatus;
  tranches: {
    scheduledTasks: number;
    executedTasks: number;
    running: boolean;
  };
  hedges: {
    scheduledTasks: number;
    executedTasks: number;
    running: boolean;
    summary?: HedgeWindowSummary;
    strategies?: HedgeWindowStrategy[];
  };
  subscriptions: {
    activeCount: number;
  };
}

/**
 * Legacy detailed engine metrics (for backwards compatibility)
 * @deprecated Use ExchangeEngineMetrics instead
 */
export interface EngineMetrics {
  status: EngineStatus;
  dispatcher: {
    activeSubscriptions: number;
    totalSubscriptions: number;
  };
  ticks: {
    ticksReceived: number;
    ticksPublished: number;
    ticksFiltered: number;
  };
  tranches: {
    scheduledTasks: number;
    executedTasks: number;
  };
  hedges: {
    scheduledTasks: number;
    executedTasks: number;
  };
  signals: {
    signalsProcessed: number;
    signalsDispatched: number;
    signalsFailed: number;
  };
}

/**
 * Signal cleanup result
 */
export interface SignalCleanupResult {
  deleted: number;
  daysOld: number;
}

// ==================== Strategy State Monitoring ====================

/**
 * Status of a single tranch within a strategy
 */
export interface TranchStatus {
  tranchNumber: number;
  scheduledTime?: string;
  dayCondition?: string;      // Day condition configured for this tranch (e.g., "M", "E", "DT1")
  signaled: boolean;
  signaledAt?: string;
  lotsConfigured?: number;
  // Runtime scheduling info
  isScheduledToday?: boolean;  // True if this tranch is scheduled to execute today
  todayDayCondition?: string;  // Today's day condition (e.g., "M", "E", "DT1")
  scheduleStatus?: 'SIGNALED' | 'WATCHING' | 'NOT_TODAY' | 'PENDING' | 'PAST_TIME' | 'NO_TIME' | 'INVALID_TIME' | 'HOLIDAY';
  hasActiveBreakoutWatch?: boolean;  // True if this tranch has active breakout watches
}

/**
 * Breakout watch types
 */
export type BreakoutWatchType = 'OPTION_SYMBOL' | 'UNDERLYING';
export type BreakoutDirection = 'ABOVE' | 'BELOW' | 'EITHER';
export type BreakoutTriggerMode = 'PERCENTAGE' | 'ABSOLUTE' | 'CANDLE_LOW';

/**
 * Breakout watch data from API
 */
export interface BreakoutWatch {
  // Core identity
  watchId: number;
  watchType: BreakoutWatchType;
  watchSymbol: string;
  exchange: string;

  // Subscription context
  strategyName: string;
  username: string;
  brokerName: string;
  tranchNumber: number;
  groupId?: string;
  isPaperTrading?: boolean;

  // Trigger configuration
  referencePrice: number;
  triggerPriceAbove: number;
  triggerPriceBelow: number;
  direction: BreakoutDirection;
  triggerMode: BreakoutTriggerMode;
  triggerValue: number;

  // Status
  isTriggered: boolean;
  triggeredAt?: string;
  triggeredPrice?: number;
  // Soft-expired: validTill passed without triggering. Row stays in DB
  // until next-day engine startup so the UI can render it.
  isExpired?: boolean;
  expiredAt?: string;

  // Timing
  validTill?: string;
  createdAt?: string;

  // Option-specific fields (for OPTION_SYMBOL type)
  tradingSymbol?: string;
  optionType?: 'CE' | 'PE';
  strike?: number;
  tradeDirection?: 'LONG' | 'SHORT';
  quantity?: number;
  quantityPerLot?: number;
  entryPremium?: number;

  // Underlying-specific fields (for UNDERLYING type)
  fnoSymbol?: string;
  strikeType?: string;
  strikeValue?: string;
  optionPremium?: number;
  optionPremiumUpper?: number;

  // Metadata
  metadata?: string;

  // Computed fields (from API enrichment)
  currentLTP?: number;
  distanceToTriggerAbove?: number;
  distanceToTriggerBelow?: number;
  pctFromReference?: number;
  isValid?: boolean;
}

/**
 * Breakout watch summary statistics
 */
export interface BreakoutWatchSummary {
  totalActive: number;
  totalTriggered: number;
  totalExpired?: number;
  totalAll: number;
  byStrategy: Record<string, number>;
  byUser: Record<string, number>;
  byWatchType: Record<string, number>;
}

/**
 * Comprehensive snapshot of a user's strategy state
 */
export interface StrategyStateSnapshot {
  // Identity
  username: string;
  strategyName: string;
  brokerName: string;
  tradingDate: string;

  // Subscription info
  subscriptionId?: number;
  subscriptionActive: boolean;
  capital?: number;
  activatedAt?: string;

  // State info
  stateId?: number;
  lastEvaluationAt?: string;
  lastSignalAt?: string;
  evaluationCount: number;
  signalCount: number;

  // Tranch status
  tranchCount: number;
  tranchesSignaled: number;
  tranches?: TranchStatus[];

  // State data (custom evaluator data)
  stateData?: Record<string, unknown>;

  // Flags
  signalsGeneratedToday: boolean;
  portfolioSLHit: boolean;
  portfolioTargetHit: boolean;
}

/**
 * Summary for a single strategy (aggregate)
 */
export interface StrategySummaryStats {
  strategyName: string;
  subscriptionCount: number;
  activeCount: number;
  totalSignals: number;
  tranchesConfigured?: number;
  tranchesScheduled?: number;  // Tranches scheduled to execute today
  tranchesSignaled?: number;
}

/**
 * Summary for a single user (aggregate)
 */
export interface UserSummaryStats {
  username: string;
  subscriptionCount: number;
  activeCount: number;
  totalSignals: number;
  totalEvaluations: number;
  tranchesConfigured?: number;
  tranchesScheduled?: number;  // Tranches scheduled to execute today
  tranchesSignaled?: number;
  strategies?: string[];
}

/**
 * Aggregate summary of strategy states
 */
export interface StrategyStateSummary {
  // Summary date
  tradingDate: string;

  // Overall counts
  totalSubscriptions: number;
  activeSubscriptions: number;
  inactiveSubscriptions: number;

  // Evaluation stats
  totalEvaluations: number;
  subscriptionsWithEvaluations: number;

  // Signal stats
  totalSignalsGenerated: number;
  subscriptionsWithSignals: number;

  // Tranch stats
  totalTranchesConfigured?: number;
  totalTranchesScheduled?: number;  // Tranches scheduled to execute today
  totalTranchesSignaled?: number;

  // Breakdown
  byStrategy?: StrategySummaryStats[];
  byUser?: UserSummaryStats[];
}

/**
 * Filter options for strategy states
 */
export interface StrategyStateFilters {
  username?: string;
  strategy?: string;
  status?: 'all' | 'active' | 'signaled' | 'pending';
  date?: string;
}

/**
 * Snapshot of MOCK_SESSION_STATE returned by /api/v2/engine/mock/status.
 */
export interface MockSessionStatus {
  isActive: boolean;
  startedAt?: string | null;
  startedBy?: string | null;
  stoppedAt?: string | null;
  stoppedBy?: string | null;
  stopReason?: string | null;
  updatedAt?: string | null;
  /**
   * Computed (server-side, only when isActive=true) — when the
   * auto-stop ticker will fire if no manual stop comes in. Anchored
   * to startedAt so the deadline doesn't drift. Falls back to
   * startedAt + 2h, capped at the configured cleanup time, when the
   * configured cutoff is already in the past.
   */
  effectiveStopAt?: string | null;
  /**
   * Today's configured Mock Trading Day sessions (synced from the
   * market-data service). Drives the terminal banner and the
   * Start-button window (enabled from the earliest sessionStart).
   */
  mockDayToday?: boolean;
  mockDaySessions?: MockDaySession[] | null;
  /** "HH:mm:ss" — earliest sessionStart across today's mock sessions. */
  mockDayEarliestStart?: string | null;
  /** "HH:mm:ss" — latest sessionEnd across today's mock sessions. */
  mockDayLatestEnd?: string | null;
}

/** One exchange's mock session window for a Mock Trading Day. */
export interface MockDaySession {
  exchange: string;
  tradingDate: string;       // "yyyy-MM-dd"
  sessionStart: string;      // "HH:mm:ss"
  sessionEnd: string;        // "HH:mm:ss"
  description?: string | null;
}

/**
 * A combo's declared shape — the legs of a multi-leg strategy.
 *
 * Absent on every strategy that is not a combo, which means "shape comes from tradeMode", exactly
 * as before. It exists because product, tradeMode and direction on a definition are single-valued
 * and a long/short pair needs them to disagree between legs.
 *
 * Sent to the API as a JSON string in `comboSpecJson`, matching how directionProviderParams and the
 * rules JSON already travel.
 */
/**
 * Which leg of a multi-leg entry/exit goes first.
 *
 * Undefined means "the default for this shape" — PROTECTION_FIRST for a hedged option entry,
 * DERIVATIVE_FIRST for a combo, REVERSE_ENTRY for any exit — which is what the engine did before
 * these were authorable. Leaving them unset changes nothing.
 */
export type EntryLegOrder = 'PROTECTION_FIRST' | 'EXPOSURE_FIRST' | 'DERIVATIVE_FIRST' | 'CASH_FIRST';
export type ExitLegOrder = 'REVERSE_ENTRY' | 'SAME_AS_ENTRY' | 'PROTECTION_LAST';

export type ComboType = 'LONG_SHORT' | 'FUTURES_OPTIONS' | 'COVERED_CALL' | 'PROTECTIVE_PUT';
export type ComboLegInstrument = 'OPTION' | 'FUTURE' | 'EQUITY';
export type ComboLegRole = 'PRIMARY' | 'HEDGE' | 'LONG_LEG' | 'SHORT_LEG';

export interface ComboLegSpec {
  role: ComboLegRole;
  instrument: ComboLegInstrument;
  direction: 'LONG' | 'SHORT';
  /** Omit to inherit the strategy's product. */
  product?: string;
  /** Multiplier on the entry's single sized quantity; omit for the whole size. */
  quantityRatio?: number;
  /** Lower goes first; omit to let the engine sequence the derivative leg ahead of cash. */
  entrySequence?: number;
}

export interface ComboSpec {
  type: ComboType;
  legs: ComboLegSpec[];
}

/** Result of POST /engine/definitions/resolve-template — which engine a draft lands on and why. */
export interface TemplateResolution {
  resolved: boolean;
  templateName: string | null;
  displayName: string | null;
  /** Why nothing matched, phrased for the person filling in the form. Null when resolved. */
  reason: string | null;
}
