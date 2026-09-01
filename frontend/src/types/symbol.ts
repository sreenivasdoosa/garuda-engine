/**
 * Symbol Management Types
 * Types for symbols and symbol broker configurations
 * Matches backend: SymbolInfo, SymbolBrokerInfo
 */

// SymbolInfo - represents a trading symbol
// Note: Most fields are synced from market-data service (read-only)
// Editable fields: maxOptionChainLevels, straddleMaxPremiumDiff, hedgeStrikeRoundingMultiple
export interface Symbol {
  symbol: string;
  exchange: string;
  /** Segment discriminator: F&O underlying (default/legacy) vs NSE cash-equity stock. */
  segment?: 'FNO' | 'NSE_EQ';
  indexSymbol?: string; // Index symbol for mapping (e.g., "Nifty 50" for symbol "NIFTY")
  isIndex: boolean;
  strikeGap: number;
  freezeLimitQty: number;
  maxOptionChainLevels: number; // Core-only field, editable
  straddleMaxPremiumDiff: number; // Max CE-PE premium diff for straddle selection, editable
  hedgeStrikeRoundingMultiple: number; // Rounding multiple for hedge strikes (e.g., 100, 500), 0 = use strikeGap only
  hasOptionsWeeklyExpiry: boolean;
  hasOptionsMonthlyExpiry: boolean;
  hasFuturesWeeklyExpiry: boolean;
  hasFuturesMonthlyExpiry: boolean;
  contractMultiplier: number; // Units per lot (e.g., CRUDEOIL=100 barrels), synced from market-data
}

// Create symbol request (not used - symbols come from market-data)
export interface CreateSymbolRequest {
  symbol: string;
  exchange: string;
  indexSymbol?: string;
  isIndex?: boolean;
  strikeGap?: number;
  freezeLimitQty?: number;
  maxOptionChainLevels?: number;
  straddleMaxPremiumDiff?: number;
  hedgeStrikeRoundingMultiple?: number;
  contractMultiplier?: number;
  hasOptionsWeeklyExpiry?: boolean;
  hasOptionsMonthlyExpiry?: boolean;
  hasFuturesWeeklyExpiry?: boolean;
  hasFuturesMonthlyExpiry?: boolean;
}

// Update symbol request
// Enterprise: only maxOptionChainLevels, straddleMaxPremiumDiff, hedgeStrikeRoundingMultiple
// Broker: all fields editable
export type UpdateSymbolRequest = Partial<CreateSymbolRequest>;

// Symbol broker configuration type (broker-specific settings for a symbol)
export interface SymbolBrokerConfig {
  symbol: string;
  broker: string;
  freezeLimitQty: number;
}

// Create symbol broker config request
export interface CreateSymbolBrokerConfigRequest {
  symbol: string;
  broker: string;
  freezeLimitQty?: number;
}

// Update symbol broker config request
export interface UpdateSymbolBrokerConfigRequest {
  freezeLimitQty?: number;
}
