/**
 * Exchange and Market type definitions
 * Covers exchanges, holidays, event days, and broker-exchange configurations
 */

// ==================== EXCHANGES ====================

export interface Exchange {
  exchange: string;            // Exchange code: "NSE", "BSE", "MCX"
  exchangeName: string;        // Full name
  segment?: string | null;     // "EQUITY", "FNO", "COMMODITY", "CURRENCY"
  timezone?: string;
  preMarketStart?: string;
  preMarketEnd?: string;
  marketOpen?: string;
  marketClose?: string;
  algoStartMinutesBeforeMarketOpen?: number;
  loginMinutesBeforeMarketOpen?: number;
  intradaySquareOffMinutesBeforeClose?: number;
  intradaySquareOffBlockMinutesBeforeClose?: number;
  positionalSquareOffMinutesBeforeClose?: number;
  postMarketWindowMinutes?: number;
  reportMinutesAfterClose?: number;
  billingMinutesAfterClose?: number;
  holidays?: string[];
  eventDays?: string[];
  weekendDays?: string[];
  isActive: boolean;
  historyCacheEnabled?: boolean;
  historyCacheSymbols?: string[] | null;
  symbolToOptionsWeekExpiryListMap?: Record<string, string[]>;
  symbolToOptionsMonthExpiryListMap?: Record<string, string[]>;
  symbolToFuturesWeekExpiryListMap?: Record<string, string[]>;
  symbolToFuturesMonthExpiryListMap?: Record<string, string[]>;
}

export interface CreateExchangeRequest {
  exchange: string;
  exchangeName: string;
  segment?: string | null;
  timezone?: string;
  preMarketStart?: string;
  preMarketEnd?: string;
  marketOpen?: string;
  marketClose?: string;
  algoStartMinutesBeforeMarketOpen?: number;
  loginMinutesBeforeMarketOpen?: number;
  intradaySquareOffMinutesBeforeClose?: number;
  intradaySquareOffBlockMinutesBeforeClose?: number;
  positionalSquareOffMinutesBeforeClose?: number;
  postMarketWindowMinutes?: number;
  reportMinutesAfterClose?: number;
  billingMinutesAfterClose?: number;
  weekendDays?: string[];
  isActive?: boolean;
  historyCacheEnabled?: boolean;
  historyCacheSymbols?: string[] | null;
}

export interface UpdateExchangeRequest extends Partial<CreateExchangeRequest> {}

// ==================== HOLIDAYS ====================

export interface Holiday {
  date: string;
  exchange: string;
  description?: string;
}

export interface CreateHolidayRequest {
  exchange: string;
  date: string;
  description?: string;
}

export interface UpdateHolidayRequest {
  description?: string;
}

// ==================== EVENT DAYS ====================

export interface EventDay {
  exchange?: string;
  eventDate: string;
  eventName: string;
  isBOCOBlocked: boolean;
  capitalPercentage: number;
}

export interface CreateEventDayRequest {
  exchange: string;
  eventDate: string;
  eventName: string;
  isBOCOBlocked?: boolean;
  capitalPercentage?: number;
}

// ==================== BROKER EXCHANGE CONFIG ====================

export interface BrokerExchangeConfig {
  brokerName: string;
  exchangeCode: string;
  loginMinutesBeforeMarketOpen: number;
  intradaySquareOffMinutesBeforeClose: number;
  intradaySquareOffBlockMinutesBeforeClose: number;
  positionalSquareOffMinutesBeforeClose: number;
  marketOrdersAllowed: boolean;
  // Per-segment market-protection buffers (V303). A value <= 0 means "unset" — the engine
  // falls back to its code default (limit buffer: equity 1 / futures 1 / options 15;
  // SL gap: equity 1 / futures 1 / options 18).
  limitOrderBufferPercentageEquity: number;
  limitOrderBufferPercentageFutures: number;
  limitOrderBufferPercentageOptions: number;
  slTriggerToLimitGapPercentageEquity: number;
  slTriggerToLimitGapPercentageFutures: number;
  slTriggerToLimitGapPercentageOptions: number;
  // Per-(broker, exchange) algo-tagging override of the broker-level globals
  naicCode?: string | null;
  algoId?: string | null;
}

export interface CreateBrokerExchangeConfigRequest {
  brokerName: string;
  exchangeCode: string;
  loginMinutesBeforeMarketOpen?: number;
  intradaySquareOffMinutesBeforeClose?: number;
  intradaySquareOffBlockMinutesBeforeClose?: number;
  positionalSquareOffMinutesBeforeClose?: number;
  marketOrdersAllowed?: boolean;
  limitOrderBufferPercentageEquity?: number;
  limitOrderBufferPercentageFutures?: number;
  limitOrderBufferPercentageOptions?: number;
  slTriggerToLimitGapPercentageEquity?: number;
  slTriggerToLimitGapPercentageFutures?: number;
  slTriggerToLimitGapPercentageOptions?: number;
  naicCode?: string | null;
  algoId?: string | null;
}
