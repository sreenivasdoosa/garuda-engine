/**
 * Billing and Brokerage Plans type definitions
 * Covers billing plans, brokerage plans, and allocation models
 */

// ==================== BILLING PLANS ====================

export interface BillingPlan {
  planName: string;
  billingPeriodDays: number;
  fixedCostPercentage: number;
  profitSharingPercentage: number;
  noCostProfitSharingPercentage: number;
  displayName?: string;
  description?: string;
  enabled?: boolean;
}

export interface CreateBillingPlanRequest {
  planName: string;
  billingPeriodDays: number;
  fixedCostPercentage?: number;
  profitSharingPercentage?: number;
  noCostProfitSharingPercentage?: number;
  displayName?: string;
  description?: string;
  enabled?: boolean;
}

// ==================== BROKERAGE PLANS ====================

// Parent brokerage plan (BROKERAGE_PLANS table)
export interface BrokeragePlan {
  planName: string;
  brokerName: string;
  description?: string;
  planType: 'PER_TRADE' | 'FIXED_PERIOD';
  fixedFee: number;
  billingPeriod: 'MONTHLY' | 'QUARTERLY';
}

export interface CreateBrokeragePlanRequest {
  planName: string;
  brokerName?: string;
  description?: string;
  planType?: 'PER_TRADE' | 'FIXED_PERIOD';
  fixedFee?: number;
  billingPeriod?: 'MONTHLY' | 'QUARTERLY';
}

// ==================== BROKERAGE PLAN RATES ====================

// Child rate per segment+product (BROKERAGE_PLAN_RATES table)
export interface BrokeragePlanRate {
  planName: string;
  segment: 'EQUITY' | 'FUTURES' | 'OPTIONS';
  product: 'INTRADAY' | 'POSITIONAL' | 'DELIVERY';
  unitType: 'order' | 'lot';
  ratePerUnit: number;
  brokeragePct: number;
}

export interface CreateBrokeragePlanRateRequest {
  planName: string;
  segment: string;
  product: string;
  unitType: 'order' | 'lot';
  ratePerUnit: number;
  brokeragePct: number;
}

// ==================== STATUTORY CHARGES ====================

/**
 * Per-broker SPARSE statutory-charge override: null field = inherit the
 * default StatutoryCharges value; non-null = override (merged per column
 * server-side at the charge calculator).
 */
export interface StatutoryChargesBrokerOverride {
  broker: string;
  exchange: string;
  segment: string;
  product: string;
  sttBuyPct: number | null;
  sttSellPct: number | null;
  exchangeTxnPct: number | null;
  sebiChargesPct: number | null;
  stampDutyBuyPct: number | null;
  stampDutySellPct: number | null;
  gstPct: number | null;
  depositoryCharges: number | null;
}

export interface StatutoryCharges {
  exchange: string;
  segment: 'EQUITY' | 'FUTURES' | 'OPTIONS';
  product: 'INTRADAY' | 'POSITIONAL' | 'DELIVERY';
  sttBuyPct: number;
  sttSellPct: number;
  exchangeTxnPct: number;
  sebiChargesPct: number;
  stampDutyBuyPct: number;
  stampDutySellPct: number;
  gstPct: number;
  depositoryCharges: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface CreateStatutoryChargesRequest {
  exchange: string;
  segment: string;
  product: string;
  sttBuyPct: number;
  sttSellPct: number;
  exchangeTxnPct: number;
  sebiChargesPct: number;
  stampDutyBuyPct: number;
  stampDutySellPct: number;
  gstPct: number;
  depositoryCharges: number;
}

// ==================== ALLOCATION MODELS ====================

export interface AllocationModel {
  name: string;
  capital: number;
  intradayCapital: number;
  positionalCapital: number;
  strategiesList: string[];
}

export interface CreateAllocationModelRequest {
  name: string;
  capital: number;
  intradayCapital: number;
  positionalCapital: number;
}

export interface AllocationModelStrategy {
  // Core fields (stored in DB)
  modelName?: string;
  strategyName: string;
  numOfLots: number;
  /**
   * Per-mapping overlap flag (stored). Excludes this (model, strategy) mapping from the
   * allocation-model total, independent of the strategy-level overlap flag. Use for the
   * same strategy mapped on multiple indices where only a subset run at once.
   */
  mappingOverlapCapital?: boolean;

  // Computed fields (populated by backend from P0 config)
  hedgingEnabled?: boolean;
  capitalPerLot?: number;
  capitalPerLotHedged?: number;
  capitalPerLotNaked?: number;
  totalCapital?: number;
  product?: 'INTRADAY' | 'POSITIONAL';
  /** Effective overlap = strategy-level OR mappingOverlapCapital; drives total exclusion. */
  isOverlapCapital?: boolean;
}

export interface AllocationModelDeletionImpact {
  modelName: string;
  userBrokersCount: number;
  affectedUserBrokers: string[];
  strategyMappingsCount: number;
  affectedStrategies: string[];
  dayAllocationConfigsCount: number;
}
