/**
 * Billing and Brokerage Plans type definitions
 * Covers billing plans and brokerage plans
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

