/**
 * Centralized export for all type definitions
 * Import from '@/types' to access any type across the application
 */

// Common types
export * from './common';

// Trading products (Product / TradableProduct / SquareOffProduct + labels) — single source of truth
export * from './product';

// User Management types
export * from './user_mgmt';

// Risk Management System types
export * from './rms';

// Help documentation types
export * from './help';

// Billing and Brokerage types
export * from './billing';

// Exchange and Market types
export * from './exchange';

// Reports and Trading Data types
export * from './reports';

// System and Administrative types
export * from './system';

// Broker types
export * from './broker';

// Email template and branding types
export * from './email';

// Terminal types
export * from './terminal';

// Strategy Engine types (event-driven engine)
// Note: Product, ExpiryType, TradableDay, TRADABLE_DAYS are already exported via ./strategy
export type {
  StrategyStatus,
  UnderlyingType,
  SignalAction,
  SignalStatus,
  StrategyTemplate,
  CreateStrategyTemplateRequest,
  UpdateStrategyTemplateRequest,
  StrategyDefinition,
  CreateStrategyDefinitionRequest,
  UpdateStrategyDefinitionRequest,
  UserStrategySubscription,
  CreateUserSubscriptionRequest,
  UpdateUserSubscriptionRequest,
  TranchSchedule,
  CreateTranchScheduleRequest,
  UpdateTranchScheduleRequest,
  ExternalSignal,
  CreateExternalSignalRequest,
  CancelSignalRequest,
  ExchangeEngineStatus,
  AllEnginesStatus,
  EngineStatus,
  ExchangeEngineMetrics,
  EngineMetrics,
  SignalCleanupResult,
  TranchStatus,
  StrategyStateSnapshot,
  StrategySummaryStats,
  UserSummaryStats,
  StrategyStateSummary,
  StrategyStateFilters,
} from './strategy-engine';
