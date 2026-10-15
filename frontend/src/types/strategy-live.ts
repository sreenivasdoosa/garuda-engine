/**
 * Strategies as garuda serves them: a definition is a spec -- its underlying,
 * its product and its legs -- rules say when it enters and which way, and a
 * subscription puts it on a trading client with capital, live or paper.
 */

import type { DirectionRules, RuleNode } from './strategy-engine';

export type StrategyStatus = 'ACTIVE' | 'INACTIVE' | 'WIND_DOWN';
export type DefinitionProduct = 'INTRADAY' | 'POSITIONAL' | 'CASHBUY' | 'MTF';

/** One leg, as the engine's selector registry reads it. */
export interface Leg {
  instrument: Record<string, unknown> & { type: string };
  side?: 'SAME_AS_SIGNAL' | 'OPPOSITE' | 'ALWAYS_LONG' | 'ALWAYS_SHORT';
  role?: string;
  product?: string;
  order_type?: string;
  ratio_numerator?: number;
  ratio_denominator?: number;
  sequence?: number;
}

export interface StrategyDefinitionLive {
  strategyId: number;
  strategyName: string;
  displayName: string | null;
  displayOrder: number | null;
  underlyingSymbol: string;
  exchange: string;
  product: DefinitionProduct;
  tickTriggerEnabled: boolean | null;
  scheduledTriggerEnabled: boolean | null;
  signalTriggerEnabled: boolean | null;
  periodicTriggerEnabled: boolean | null;
  startTime: string | null;
  stopTime: string | null;
  tradableDays: string | null;
  excludedDays: string | null;
  capitalPerLot: number | null;
  capitalPerLotHedged: number | null;
  capitalPerLotNaked: number | null;
  isOverlapCapital: boolean | null;
  expiryType: 'WEEKLY' | 'MONTHLY' | null;
  excludeMonthlyExpiry: boolean;
  usePremiumBalancing: boolean;
  underlyingType: string | null;
  hedgeDistancePercentageIntraday: number | null;
  hedgeDistancePercentagePositional: number | null;
  isDirectional: boolean | null;
  directionProviderType: string | null;
  directionProviderParams: string | null;
  status: StrategyStatus;
  catchUpMissedTranches: boolean;
  adaptiveTranchesEnabled: boolean;
  periodicIntervalMinutes: number | null;
  periodicOffsetSeconds: number | null;
  riskPercentage: number | null;
  absoluteMaxRisk: number | null;
  comboSpecJson: string | null;
  legs: Leg[];
  tradeMode: string;
  strategyClass: string | null;
  useIndicatorEntry: boolean;
  hedgeReplaceEnabled: boolean | null;
  hedgeMorningStartOffset: number | null;
  hedgeMorningEndOffset: number | null;
  hedgeEveningStartOffset: number | null;
  hedgeEveningEndOffset: number | null;
  minRiskPercentage: number | null;
  maxRiskPercentage: number | null;
  leverage: number | null;
  minLeverage: number | null;
  maxLeverage: number | null;
  universeId: number | null;
  equitySizingModel: string | null;
  fixedAmountPerStock: number | null;
  maxActivePositions: number | null;
  maxRiskPctPerTrade: number | null;
  onIndexRemoval: string | null;
  entryLegOrder: string | null;
  exitLegOrder: string | null;
  subscriptions?: number;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Every editable column, by its wire name; absent leaves it unchanged. */
export type StrategyDefinitionEdit = Partial<
  Omit<StrategyDefinitionLive, 'strategyId' | 'legs' | 'subscriptions' | 'createdAt' | 'updatedAt'>
> & { legs?: Leg[] };

export interface StrategyRulesLive {
  strategyName: string;
  entryRules: RuleNode | null;
  directionRules: DirectionRules | null;
  exitRules: RuleNode | null;
  entryRulesJson: string | null;
  directionRulesJson: string | null;
  exitRulesJson: string | null;
  useIndicatorExit: boolean;
}

export interface StrategyRulesEdit {
  entryRules?: RuleNode | null;
  directionRules?: DirectionRules | null;
  exitRules?: RuleNode | null;
  useIndicatorExit?: boolean;
}

export interface SubscriptionLive {
  subscriptionId: number;
  tradingClientId: string;
  displayName: string;
  strategyName: string;
  isActive: boolean;
  capital: number | null;
  riskPercentage: number | null;
  absoluteMaxRisk: number | null;
  leverage: number | null;
  maxActivePositions: number | null;
  isPaperTrading: boolean;
  activatedAt: string | null;
  deactivatedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SubscriptionEdit {
  capital?: number;
  riskPercentage?: number | null;
  absoluteMaxRisk?: number | null;
  leverage?: number | null;
  maxActivePositions?: number | null;
  isActive?: boolean;
  isPaperTrading?: boolean;
}

export interface NewSubscription extends SubscriptionEdit {
  tradingClientId: string;
  strategyName: string;
}

export interface StrategyCatalog {
  selectors: { type: string; fields: string[] }[];
  rules: string[];
  directionRules: string[];
  sideRules: string[];
  legRoles: string[];
  products: string[];
  definitionProducts: string[];
  orderTypes: string[];
  optionTypes: string[];
  expiryTypes: string[];
  statuses: string[];
  tradeModes: string[];
  strategyClasses: string[];
  directionProviders: string[];
  underlyingTypes: string[];
  equitySizingModels: string[];
  onIndexRemoval: string[];
  dayCodes: string[];
  legOrders: string[];
}

export interface DayAllocation {
  strategyName: string;
  monday: number;
  tuesday: number;
  wednesday: number;
  thursday: number;
  friday: number;
  expiryDay: number;
  dt1Day: number;
  dt2Day: number;
}

export interface EngineMonitor {
  tradingDay: string;
  schedule: { strategy: string; tranche: number; at: string; status: 'PENDING' | 'FIRED' | 'MISSED' }[];
  unscheduled: { strategy: string; tranche: number; because: string }[];
  watches: {
    key: string;
    tradingClientId: string;
    strategy: string;
    tranche: number;
    kind: string;
    watched: string;
    direction: string;
    above: string | null;
    below: string | null;
    status: 'LIVE' | 'FIRED' | 'LAPSED';
    triggeredAt: string | null;
    triggeredPrice: string | null;
  }[];
  states: {
    tradingClientId: string;
    strategy: string;
    signalled: Record<string, string>;
    signalsToday: number;
    lotsToday: number;
    usedRisk: string;
    evaluations: number;
    lastEvaluationAt: string | null;
  }[];
  refused: Record<string, string>;
}
