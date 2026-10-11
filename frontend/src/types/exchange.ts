/**
 * Exchange and Market type definitions
 * Covers exchanges, holidays, event days, and broker-exchange configurations
 */

// ==================== EXCHANGES ====================

export interface Exchange {
  exchange: string;            // Exchange code: "NSE", "BSE", "MCX"
  exchangeName: string;        // Full name
  /** Which segments the venue lists: "EQUITY", "FNO", "COMMODITY", "CURRENCY". */
  segments?: string[];
  /** What the market calls those segments, as every broker files instruments: NSE, NFO, CDS. */
  segmentCodes?: string[];
  /** What the venue settles in. A P&L figure needs a unit. */
  currency?: string;
  timezone?: string;
  preMarketStart?: string;
  preMarketEnd?: string;
  marketOpen?: string;
  marketClose?: string;
  algoStartMinutesBeforeMarketOpen?: number;
  intradaySquareOffMinutesBeforeClose?: number;
  intradaySquareOffBlockMinutesBeforeClose?: number;
  postMarketWindowMinutes?: number;
  reportMinutesAfterClose?: number;
  holidays?: string[];
  eventDays?: string[];
  weekendDays?: string[];
  /** How long before the open the day is prepared. */
  dayInitMinutesBeforeMarketOpen?: number;
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
  segments?: string[];
  currency?: string;
  timezone?: string;
  preMarketStart?: string;
  preMarketEnd?: string;
  marketOpen?: string;
  marketClose?: string;
  algoStartMinutesBeforeMarketOpen?: number;
  intradaySquareOffMinutesBeforeClose?: number;
  intradaySquareOffBlockMinutesBeforeClose?: number;
  postMarketWindowMinutes?: number;
  reportMinutesAfterClose?: number;
  weekendDays?: string[];
  /** How long before the open the day is prepared. */
  dayInitMinutesBeforeMarketOpen?: number;
  isActive?: boolean;
  historyCacheEnabled?: boolean;
  historyCacheSymbols?: string[] | null;
}

export interface UpdateExchangeRequest extends Partial<CreateExchangeRequest> {}

/**
 * What a venue form may choose from, served by `GET /api/exchanges/options`.
 *
 * Asked for rather than kept here: these are the engine's own `Currency`,
 * `Segment` and weekday spellings, and a second copy of them in the UI drifts
 * the moment one gains a member — with the symptom being a venue the engine
 * then refuses to load.
 */
/**
 * One segment's hours as the engine will trade by them: its own where set,
 * the venue's otherwise. `inherited` says which.
 */
export interface ExchangeSegmentHours {
  segment: string;
  code: string;
  marketOpen: string | null;
  marketClose: string | null;
  ownMarketOpen: string | null;
  ownMarketClose: string | null;
  inherited: boolean;
}

export interface ExchangeOptions {
  currencies: string[];
  segments: string[];
  weekendDays: string[];
  /** Every IANA zone the server's tz database knows — the set `ZoneInfo` accepts. */
  timezones: string[];
}

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
  capitalPercentage: number;
}

export interface CreateEventDayRequest {
  exchange: string;
  eventDate: string;
  eventName: string;
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
