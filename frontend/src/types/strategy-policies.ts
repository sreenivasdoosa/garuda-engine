/**
 * Strategy Policy Types
 * Reusable configuration policies for strategies
 */

// ==================== Order Fill Escalation Policy ====================

export interface OrderFillEscalationPolicy {
  id?: number;
  policyName: string;
  description?: string;
  escalationMode: 'NONE' | 'MARKET' | 'STEP_ESCALATION';
  escalationSeconds?: number;
  escalationSteps?: string; // JSON array of escalation steps
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateOrderFillPolicyRequest {
  policyName: string;
  description?: string;
  escalationMode: 'NONE' | 'MARKET' | 'STEP_ESCALATION';
  escalationSeconds?: number;
  escalationSteps?: string;
}

// ==================== Trailing SL Policy ====================

export interface TrailingSLPolicy {
  id?: number;
  policyName: string;
  description?: string;
  trailEnabled?: boolean;
  trailLogic?: string;
  trailType?: string;
  trailConfig?: string;  // JSON config for calculator parameters
  trailToCost?: boolean;
  combinedTrailEnabled?: boolean;
  combinedTrailLogic?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateTrailingSLPolicyRequest {
  policyName: string;
  description?: string;
  trailEnabled?: boolean;
  trailLogic?: string;
  trailType?: string;
  trailConfig?: string;  // JSON config for calculator parameters
  trailToCost?: boolean;
  combinedTrailEnabled?: boolean;
  combinedTrailLogic?: string;
}

// ==================== SL Target Policy ====================

export interface SLTargetPolicy {
  id?: number;
  policyName: string;
  description?: string;
  slPercentage?: number;
  targetPercentage?: number;
  combinedSLPercentage?: number;
  combinedTargetPercentage?: number;
  slTriggerToLimitGapPercentage?: number;
  slBufferPercentage?: number;
  riskCalculationMode?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateSLTargetPolicyRequest {
  policyName: string;
  description?: string;
  slPercentage?: number;
  targetPercentage?: number;
  combinedSLPercentage?: number;
  combinedTargetPercentage?: number;
  slTriggerToLimitGapPercentage?: number;
  slBufferPercentage?: number;
  riskCalculationMode?: string;
}

// ==================== Strike Selection Policy ====================

export interface StrikeSelectionPolicy {
  id?: number;
  policyName: string;
  description?: string;
  strikeType?: 'MoneyNess' | 'FixedPremium' | 'PremiumRange';
  strikeValue?: string;
  premiumLower?: number;
  premiumUpper?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateStrikePolicyRequest {
  policyName: string;
  description?: string;
  strikeType?: 'MoneyNess' | 'FixedPremium' | 'PremiumRange';
  strikeValue?: string;
  premiumLower?: number;
  premiumUpper?: number;
}

// ==================== Exit Policy ====================

export interface ExitPolicy {
  id?: number;
  policyName: string;
  description?: string;
  exitMode?: 'SAME_DAY' | 'DAYS_FROM_ENTRY' | 'DTE' | 'EXPIRY' | 'MINUTES_FROM_ENTRY';
  exitDays?: number;
  exitTime?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateExitPolicyRequest {
  policyName: string;
  description?: string;
  exitMode?: 'SAME_DAY' | 'DAYS_FROM_ENTRY' | 'DTE' | 'EXPIRY' | 'MINUTES_FROM_ENTRY';
  exitDays?: number;
  exitTime?: string;
}

// ==================== All Policies Summary ====================

export interface AllPoliciesSummary {
  orderFill: OrderFillEscalationPolicy[];
  trailingSL: TrailingSLPolicy[];
  slTarget: SLTargetPolicy[];
  strike: StrikeSelectionPolicy[];
  exit: ExitPolicy[];
}

// ==================== Policy Type Enum ====================

export type PolicyType = 'order-fill' | 'trailing-sl' | 'sl-target' | 'strike' | 'exit';

export const POLICY_TYPES: { value: PolicyType; label: string; description: string }[] = [
  { value: 'order-fill', label: 'Order Fill Escalation', description: 'Handles unfilled orders with configurable escalation steps' },
  { value: 'trailing-sl', label: 'Trailing SL', description: 'Trailing stop-loss configuration' },
  { value: 'sl-target', label: 'SL & Target', description: 'Stop-loss and target percentages' },
  { value: 'strike', label: 'Strike Selection', description: 'Option strike selection criteria' },
  { value: 'exit', label: 'Exit', description: 'Trade exit timing configuration' },
];
