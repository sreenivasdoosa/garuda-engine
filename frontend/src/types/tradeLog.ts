// Trade-log types — per-event audit trail for a single trade's lifecycle.
// Backend source: TRADE_LOG table, TradeLogRepository, TradeLogServletV2.

export type TradeLogEventCategory =
  | 'ENTRY'
  | 'SL'
  | 'TARGET'
  | 'HEDGE'
  | 'EXIT'
  | 'ERROR'
  | 'MODIFY';

// Specific event types — kept loose (string) so the frontend doesn't need to
// be rebuilt every time a new backend event type is added. The filters
// endpoint returns the authoritative list for the UI dropdown.
export type TradeLogEventType = string;

export interface TradeLogEntry {
  id?: number;
  tradeId: string;
  username?: string;
  broker?: string;
  strategy?: string;
  tradingSymbol?: string;
  hedgeCorrelationId?: string;

  eventCategory?: TradeLogEventCategory;
  eventType?: TradeLogEventType;
  eventTimestamp?: string;

  orderId?: string;
  orderStatus?: string;
  orderType?: string;

  price?: number;
  quantity?: number;
  filledQuantity?: number;
  slPrice?: number;
  targetPrice?: number;

  message?: string;
  details?: string;
  errorMessage?: string;

  createdAt?: string;
}

export interface TradeLogPageResponse {
  entries: TradeLogEntry[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface TradeLogFilters {
  usernames: string[];
  brokers: string[];
  strategies: string[];
  tradingSymbols: string[];
  eventCategories: TradeLogEventCategory[];
  eventTypes: TradeLogEventType[];
}

// Query params sent to /api/v2/trade-log (paginated). All optional.
export interface TradeLogFilterParams {
  page?: number;
  pageSize?: number;
  tradeId?: string;
  username?: string;
  broker?: string;
  strategy?: string;
  tradingSymbol?: string;
  eventCategory?: string;
  eventType?: string;
  startTime?: string;
  endTime?: string;
  search?: string;
}
