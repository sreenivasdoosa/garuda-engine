/**
 * Strategy Config Tree Types
 * Matches: StrategyConfigTree.java
 * Unified hierarchical configuration for strategy settings
 */

// ==================== Breakout Watch Types ====================

/**
 * Breakout watch type - what to monitor
 */
export type BreakoutWatchType = 'OPTION_SYMBOL' | 'UNDERLYING';

/**
 * Breakout direction - when to trigger
 */
export type BreakoutDirection = 'ABOVE' | 'BELOW' | 'EITHER';

/**
 * Breakout trigger mode - how to calculate trigger price
 */
export type BreakoutTriggerMode = 'PERCENTAGE' | 'ABSOLUTE' | 'CANDLE_LOW';

/**
 * Breakout watch type definitions for UI
 */
export const BREAKOUT_WATCH_TYPES: { value: BreakoutWatchType; label: string; description: string }[] = [
  { value: 'OPTION_SYMBOL', label: 'Option Premium', description: 'Watch option premium - strike selected at watch creation' },
  { value: 'UNDERLYING', label: 'Underlying Price', description: 'Watch index/futures price - fresh strike selection at trigger' },
];

/**
 * Breakout direction definitions for UI
 */
export const BREAKOUT_DIRECTIONS: { value: BreakoutDirection; label: string; description: string }[] = [
  { value: 'BELOW', label: 'Below (Drop)', description: 'Trigger when price drops below threshold' },
  { value: 'ABOVE', label: 'Above (Rise)', description: 'Trigger when price rises above threshold' },
  { value: 'EITHER', label: 'Either Direction', description: 'Trigger on price move in either direction' },
];

/**
 * Breakout trigger mode definitions for UI
 */
export const BREAKOUT_TRIGGER_MODES: { value: BreakoutTriggerMode; label: string; description: string }[] = [
  { value: 'PERCENTAGE', label: 'Percentage', description: 'Trigger based on percentage change (e.g., 20% drop)' },
  { value: 'ABSOLUTE', label: 'Absolute Points', description: 'Trigger based on absolute price change (e.g., 50 points)' },
  { value: 'CANDLE_LOW', label: 'Candle Low', description: 'Trigger at identified candle low (auto-set for CandleLow_NearPremium)' },
];

// ==================== Exit Configuration Types ====================

/**
 * Exit mode type
 */
export type ExitModeType = 'SAME_DAY' | 'DAYS_FROM_ENTRY' | 'DTE' | 'EXPIRY' | 'MINUTES_FROM_ENTRY' | 'END_OF_MONTH_FROM_ENTRY';

/**
 * Exit mode definitions for UI
 */
export const EXIT_MODES: { value: ExitModeType; label: string; description: string; needsDays: boolean }[] = [
  { value: 'SAME_DAY', label: 'Same Day', description: 'Exit on the same day at specified time', needsDays: false },
  { value: 'DAYS_FROM_ENTRY', label: 'Days from Entry', description: 'Exit N trading days after entry', needsDays: true },
  { value: 'DTE', label: 'Days to Expiry', description: 'Exit N trading days before expiry', needsDays: true },
  { value: 'EXPIRY', label: 'Expiry Day', description: 'Exit on expiry day', needsDays: false },
  { value: 'MINUTES_FROM_ENTRY', label: 'Minutes from Entry', description: 'Exit N trading minutes after entry (spans across days)', needsDays: true },
  // Swing/carry-forward holding period (equity CASHBUY/MTF and options positional):
  // exitDays carries the month count N; exit on the last trading day of month(entry+N).
  { value: 'END_OF_MONTH_FROM_ENTRY', label: 'End of Month (N months)', description: 'Exit on the last trading day of the Nth month after entry (N in Exit Days)', needsDays: true },
];

/**
 * Special exit time value for matching entry time
 */
export const EXIT_TIME_ENTRY_TIME = 'ENTRY_TIME';

/**
 * Exit time options for UI (includes special ENTRY_TIME option)
 */
export const EXIT_TIME_OPTIONS: { value: string; label: string; description: string }[] = [
  { value: EXIT_TIME_ENTRY_TIME, label: 'Same as Entry Time', description: 'Exit at the same time as signal generation (uses current system time)' },
];

// ==================== Day Condition Types ====================

/**
 * Day condition enum values (abbreviated form)
 * M=Monday, T=Tuesday, W=Wednesday, TH=Thursday, F=Friday
 * E=Expiry Day, DT1=Day before expiry, DT2=Two days before expiry
 */
export type DayConditionType =
  | 'M'
  | 'T'
  | 'W'
  | 'TH'
  | 'F'
  | 'E'
  | 'DT1'
  | 'DT2';

/**
 * Day condition info from API
 */
export interface DayConditionInfo {
  value: DayConditionType;
  label: string;
  isExpiryRelated: boolean;
  isDayOfWeek: boolean;
}

export type LotAllocationMode = 'DAY_LOCAL' | 'GLOBAL_SHARED';

export const LOT_ALLOCATION_MODES: { value: LotAllocationMode; label: string; description: string }[] = [
  { value: 'DAY_LOCAL', label: 'Day Local', description: 'Current behavior. Today lots are allocated only across today\'s tranches.' },
  { value: 'GLOBAL_SHARED', label: 'Global Shared', description: 'Allocate lots across a global tranche pool, then expose only this day\'s tranche slice.' },
];

/**
 * Strategy Config Tree entity
 * Stored in STRATEGY_CONFIG_TREE table
 *
 * Priority system (bitmask):
 * - USERNAME present: +16
 * - BROKER present: +8
 * - TRANCH_NUMBER present: +4
 * - DAY_CONDITION present: +2
 */
export interface StrategyConfigTree {
  id?: number;

  // Scope identifiers (null = applies to all at that level)
  username?: string | null;      // null = applies to all users
  broker?: string | null;        // null = applies to all brokers
  strategyName: string;          // Always required
  tranchNumber?: number | null;  // null = applies to all tranches / non-tranch mode
  dayCondition?: DayConditionType | null;  // null = all days

  // Configuration values (all nullable - only set what you want to override)
  // Strike configuration
  strikeType?: string | null;     // "MoneyNess", "FixedPremium", or "PremiumRange"
  strikeValue?: string | null;    // "ATM", "OTM+1", "OTM+2", "ITM-1", etc. (for MoneyNess)
  optionPremium?: number | null;       // Premium value (FixedPremium) or lower bound (PremiumRange)
  optionPremiumUpper?: number | null;  // Upper bound for PremiumRange
  oiRank?: number | null;              // For PremiumRange_OIRanked: which OI rank to select (1-5, 1 = highest OI)
  ignoreITMStrikes?: boolean | null;   // For PremiumRange_OIRanked: whether to filter out ITM strikes (default true)
  lookbackMinutes?: number | null;     // For CandleLow_NearPremium: minutes to look back for candle history
  otmLevels?: number | null;           // For CandleLow_NearPremium: strike levels to check on each side of ATM (default 10)
  useATMIfITM?: boolean | null;        // For FixedPremium/PremiumRange: use ATM if selected strike is ITM

  // Liquidity filters for strike selection (null = inherit, 0 = off, > 0 = active threshold)
  volumeFilter?: number | null;             // Min traded volume a strike must have to be tradable
  oiFilter?: number | null;                 // Min open interest a strike must have to be tradable
  applyVolumeFilterToHedge?: boolean | null;  // Apply volumeFilter to hedge legs too (default false = exempt)
  applyOIFilterToHedge?: boolean | null;      // Apply oiFilter to hedge legs too (default false = exempt)

  // Lots configuration
  lotsPerTranch?: number | null;       // Explicit lots for this tranch (null = calculate from capital)

  // Hedging
  hedgingEnabled?: boolean | null;
  hedgeStrikeRoundingMinDistance?: number | null;  // Min hedge distance % to apply rounding (e.g., 2.0 = apply rounding when hedge distance >= 2%)

  // Stop Loss & Target
  slPercentage?: number | null;
  targetPercentage?: number | null;
  combinedSLPercentage?: number | null;
  combinedTargetPercentage?: number | null;
  riskCalculationMode?: string | null;  // 'STOP_LOSS' | 'WING_WIDTH_MAX_LOSS'
  noStopLoss?: boolean | null;

  // Trailing SL
  trailSL?: boolean | null;
  trailLogic?: string | null;
  trailSLType?: string | null;           // Type: FIXED, PERCENTAGE
  trailConfig?: string | null;           // JSON config for calculator parameters
  slBufferPercentage?: number | null; // Buffer percentage (e.g., 3.0 = 3%)
  trailSLToCost?: boolean | null;        // Whether to trail SL to cost
  combinedTrailSL?: boolean | null;
  combinedTrailLogic?: string | null;

  // SL order buffer
  slTriggerToLimitGapPercentage?: number | null;  // Buffer for SL limit orders (e.g., 6 = 6%)

  // Timing (for tranch-specific)
  tranchTiming?: string | null;       // Entry time HH:mm:ss
  tranchCutoffTime?: string | null;   // No new trades after this

  // Tranch gap configuration (in minutes)
  minTranchGap?: number | null;       // Min compressed gap when time is tight (default 1 min)
  tranchGap?: number | null;       // Normal gap between tranch entries (in minutes)

  // Re-entry
  reEntry?: boolean | null;
  maxReentries?: number | null;              // Max re-entry attempts (default 2)
  minReentryLossPercentage?: number | null;  // Min loss % to trigger re-entry (default 0)

  // Exit configuration
  exitMode?: string | null;    // SAME_DAY, DAYS_FROM_ENTRY, DTE, EXPIRY
  exitDays?: number | null;    // Days parameter for exit mode
  exitTime?: string | null;    // Time of day to exit (HH:mm:ss)

  // Order fill escalation
  orderFillEscalationMode?: string | null;      // NONE, MARKET, STEP_ESCALATION
  orderFillEscalationSeconds?: number | null;   // Seconds before escalation
  orderFillEscalationSteps?: string | null;     // JSON array of escalation steps

  // Breakout Watch Configuration (tranch-level)
  breakoutEnabled?: boolean | null;             // Enable breakout watch for this tranch
  breakoutWatchType?: BreakoutWatchType | null; // OPTION_SYMBOL or UNDERLYING
  breakoutDirection?: BreakoutDirection | null; // ABOVE, BELOW, or EITHER
  breakoutTriggerMode?: BreakoutTriggerMode | null; // PERCENTAGE or ABSOLUTE
  breakoutTriggerValue?: number | null;         // Trigger threshold (% or absolute points)
  breakoutSelectFreshStrikes?: boolean | null;  // For UNDERLYING: select fresh strikes at trigger

  // Max tranches limit (strategy/day level only, not tranch level)
  maxTranches?: number | null;                  // Maximum number of tranches to execute per day
  lotAllocationMode?: LotAllocationMode | null;
  globalAllocationTranches?: number | null;
  allocationStartTranch?: number | null;

  // Computed priority (read-only, set by database)
  priority?: number;

  // Metadata
  description?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Request to create/update a strategy config tree entry
 */
export interface CreateStrategyConfigTreeRequest {
  username?: string | null;
  broker?: string | null;
  strategyName: string;
  tranchNumber?: number | null;
  dayCondition?: DayConditionType | null;

  strikeType?: string | null;
  strikeValue?: string | null;
  optionPremium?: number | null;
  optionPremiumUpper?: number | null;
  oiRank?: number | null;
  ignoreITMStrikes?: boolean | null;
  lookbackMinutes?: number | null;
  otmLevels?: number | null;
  useATMIfITM?: boolean | null;
  volumeFilter?: number | null;
  oiFilter?: number | null;
  applyVolumeFilterToHedge?: boolean | null;
  applyOIFilterToHedge?: boolean | null;
  lotsPerTranch?: number | null;
  hedgingEnabled?: boolean | null;
  hedgeStrikeRoundingMinDistance?: number | null;
  slPercentage?: number | null;
  targetPercentage?: number | null;
  combinedSLPercentage?: number | null;
  combinedTargetPercentage?: number | null;
  riskCalculationMode?: string | null;
  noStopLoss?: boolean | null;
  trailSL?: boolean | null;
  trailLogic?: string | null;
  trailSLType?: string | null;
  trailConfig?: string | null;
  slBufferPercentage?: number | null;
  trailSLToCost?: boolean | null;
  combinedTrailSL?: boolean | null;
  combinedTrailLogic?: string | null;
  slTriggerToLimitGapPercentage?: number | null;
  tranchTiming?: string | null;
  tranchCutoffTime?: string | null;
  minTranchGap?: number | null;
  tranchGap?: number | null;
  reEntry?: boolean | null;
  maxReentries?: number | null;
  minReentryLossPercentage?: number | null;
  exitMode?: string | null;
  exitDays?: number | null;
  exitTime?: string | null;
  orderFillEscalationMode?: string | null;
  orderFillEscalationSeconds?: number | null;
  orderFillEscalationSteps?: string | null;
  breakoutEnabled?: boolean | null;
  breakoutWatchType?: BreakoutWatchType | null;
  breakoutDirection?: BreakoutDirection | null;
  breakoutTriggerMode?: BreakoutTriggerMode | null;
  breakoutTriggerValue?: number | null;
  breakoutSelectFreshStrikes?: boolean | null;
  maxTranches?: number | null;
  lotAllocationMode?: LotAllocationMode | null;
  globalAllocationTranches?: number | null;
  allocationStartTranch?: number | null;
  description?: string | null;
}

export type UpdateStrategyConfigTreeRequest = Partial<CreateStrategyConfigTreeRequest>;

/**
 * Effective configuration after merging all applicable overrides
 * Includes both resolved values and their sources (for debugging/auditing)
 */
export interface EffectiveConfig {
  // Resolved values
  slPercentage: number;
  targetPercentage: number;
  combinedSLPercentage: number;
  combinedTargetPercentage: number;
  riskCalculationMode?: string;
  noStopLoss?: boolean;
  trailSL: boolean;
  trailLogic?: string;
  trailSLType?: string;
  trailConfig?: string;
  slBufferPercentage?: number;
  trailSLToCost?: boolean;
  combinedTrailSL: boolean;
  combinedTrailLogic?: string;
  slTriggerToLimitGapPercentage?: number;
  strikeType?: string;
  strikeValue?: string;
  optionPremium: number;
  optionPremiumUpper: number;
  oiRank?: number;
  ignoreITMStrikes?: boolean;
  lookbackMinutes?: number;
  otmLevels?: number;
  useATMIfITM?: boolean;
  volumeFilter?: number;
  oiFilter?: number;
  applyVolumeFilterToHedge?: boolean;
  applyOIFilterToHedge?: boolean;
  lotsPerTranch?: number;
  hedgingEnabled: boolean;
  hedgeStrikeRoundingMinDistance?: number;
  reEntry: boolean;
  maxReentries: number;                  // Default 2
  minReentryLossPercentage: number;      // Default 0
  tranchTiming?: string;
  tranchCutoffTime?: string;
  minTranchGap?: number;
  tranchGap?: number;
  exitMode?: string;
  exitDays?: number;
  exitTime?: string;
  orderFillEscalationMode?: string;
  orderFillEscalationSeconds?: number;
  orderFillEscalationSteps?: string;
  // Breakout
  breakoutEnabled?: boolean;
  breakoutWatchType?: string;
  breakoutDirection?: string;
  breakoutTriggerMode?: string;
  breakoutTriggerValue?: number;
  breakoutSelectFreshStrikes?: boolean;

  // Max tranches
  maxTranches?: number;
  lotAllocationMode?: LotAllocationMode;
  globalAllocationTranches?: number;
  allocationStartTranch?: number;

  // Source tracking (for UI preview)
  sourceStrategy?: string;
  slSource?: string;
  targetSource?: string;
  combinedSLSource?: string;
  combinedTargetSource?: string;
  riskCalculationModeSource?: string;
  noStopLossSource?: string;
  trailSLSource?: string;
  trailLogicSource?: string;
  trailSLTypeSource?: string;
  trailConfigSource?: string;
  slBufferPercentageSource?: string;
  trailSLToCostSource?: string;
  combinedTrailSLSource?: string;
  combinedTrailLogicSource?: string;
  slTriggerToLimitGapPercentageSource?: string;
  strikeTypeSource?: string;
  strikeValueSource?: string;
  optionPremiumSource?: string;
  optionPremiumUpperSource?: string;
  oiRankSource?: string;
  volumeFilterSource?: string;
  oiFilterSource?: string;
  applyVolumeFilterToHedgeSource?: string;
  applyOIFilterToHedgeSource?: string;
  ignoreITMStrikesSource?: string;
  lookbackMinutesSource?: string;
  otmLevelsSource?: string;
  lotsPerTranchSource?: string;
  hedgingSource?: string;
  reEntrySource?: string;
  maxReentriesSource?: string;
  minReentryLossPercentageSource?: string;
  tranchTimingSource?: string;
  tranchCutoffSource?: string;
  minTranchGapSource?: string;
  tranchGapSource?: string;
  exitModeSource?: string;
  exitDaysSource?: string;
  exitTimeSource?: string;
  orderFillEscalationModeSource?: string;
  orderFillEscalationSecondsSource?: string;
  orderFillEscalationStepsSource?: string;
  breakoutEnabledSource?: string;
  breakoutWatchTypeSource?: string;
  breakoutDirectionSource?: string;
  breakoutTriggerModeSource?: string;
  breakoutTriggerValueSource?: string;
  breakoutSelectFreshStrikesSource?: string;
  maxTranchesSource?: string;
  lotAllocationModeSource?: string;
  globalAllocationTranchesSource?: string;
  allocationStartTranchSource?: string;
}

/**
 * Day condition constants with display names
 */
export const DAY_CONDITIONS: { value: DayConditionType; label: string; group: 'weekday' | 'expiry' }[] = [
  // Expiry-related (more specific)
  { value: 'E', label: 'Expiry Day', group: 'expiry' },
  { value: 'DT1', label: 'DT-1 (Day before)', group: 'expiry' },
  { value: 'DT2', label: 'DT-2 (Two days before)', group: 'expiry' },
  // Day of week
  { value: 'M', label: 'Monday', group: 'weekday' },
  { value: 'T', label: 'Tuesday', group: 'weekday' },
  { value: 'W', label: 'Wednesday', group: 'weekday' },
  { value: 'TH', label: 'Thursday', group: 'weekday' },
  { value: 'F', label: 'Friday', group: 'weekday' },
];

/**
 * Get scope description for a config
 */
export function getScopeDescription(config: StrategyConfigTree): string {
  const parts: string[] = [`Strategy: ${config.strategyName}`];
  if (config.username) parts.push(`User: ${config.username}`);
  if (config.broker) parts.push(`Broker: ${config.broker}`);
  if (config.tranchNumber != null) parts.push(`Tranch: ${config.tranchNumber}`);
  if (config.dayCondition) {
    const dc = DAY_CONDITIONS.find(d => d.value === config.dayCondition);
    parts.push(`Day: ${dc?.label || config.dayCondition}`);
  }
  return parts.join(', ');
}

/**
 * Get priority badge color based on priority level
 */
export function getPriorityColor(priority: number): string {
  if (priority >= 24) return 'danger';   // User-specific
  if (priority >= 4) return 'warning';   // Tranch or day specific
  return 'secondary';                     // Base config
}

/**
 * Get priority label
 */
export function getPriorityLabel(priority: number): string {
  if (priority >= 30) return 'User+Tranch+Day';
  if (priority >= 28) return 'User+Tranch';
  if (priority >= 26) return 'User+Day';
  if (priority >= 24) return 'User';
  if (priority >= 6) return 'Tranch+Day';
  if (priority >= 4) return 'Tranch';
  if (priority >= 2) return 'Day';
  return 'Base';
}

/**
 * Calculate expected priority from scope fields
 */
export function calculatePriority(config: Partial<StrategyConfigTree>): number {
  let p = 0;
  if (config.username) p += 16;
  if (config.broker) p += 8;
  if (config.tranchNumber != null) p += 4;
  if (config.dayCondition) p += 2;
  return p;
}
