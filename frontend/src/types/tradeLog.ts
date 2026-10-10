/**
 * The trade log: what the engine did with each trade, in order.
 *
 * One row per event, written by the engine as it happens and read back
 * here as the cross-trade log and as one trade's timeline. The event
 * vocabulary is the reference's, verbatim. Money crosses as strings.
 */

export type TradeLogEventCategory = 'ENTRY' | 'SL' | 'TARGET' | 'HEDGE' | 'EXIT' | 'ERROR' | 'MODIFY';

/** Kept loose: the filters endpoint carries the authoritative list. */
export type TradeLogEventType = string;

export interface TradeLogEntry {
  id: number;
  tradeId: string;
  tradingClientId: string;
  tradingClient: string | null;
  broker: string | null;
  strategy: string | null;
  tradingSymbol: string | null;
  hedgeCorrelationId: string | null;
  eventCategory: TradeLogEventCategory;
  eventType: TradeLogEventType;
  /** ISO 8601 with offset. */
  eventTimestamp: string | null;
  orderId: string | null;
  orderStatus: string | null;
  orderType: string | null;
  price: string | null;
  quantity: number | null;
  filledQuantity: number | null;
  slPrice: string | null;
  targetPrice: string | null;
  message: string | null;
  details: Record<string, unknown> | null;
  errorMessage: string | null;
  createdAt: string | null;
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
  /** The accounts the log actually has entries for. */
  tradingClients: { id: string; displayName: string; broker: string | null }[];
  strategies: string[];
  tradingSymbols: string[];
  eventCategories: TradeLogEventCategory[];
  eventTypes: TradeLogEventType[];
  typesByCategory: Record<string, TradeLogEventType[]>;
}

/** Query params for the paginated log. All optional. */
export interface TradeLogFilterParams {
  page?: number;
  pageSize?: number;
  tradeId?: string;
  tradingClientId?: string;
  strategy?: string;
  tradingSymbol?: string;
  eventCategory?: string;
  eventType?: string;
  /** A date (the venue's day) or a date and time. */
  startTime?: string;
  endTime?: string;
  search?: string;
}
