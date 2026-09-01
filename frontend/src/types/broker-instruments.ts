/**
 * TypeScript types for Broker Instruments feature
 */

/**
 * Broker instrument statistics
 */
export interface BrokerInstrumentsStats {
  brokerName: string;
  originalFileSize: number;
  normalizedFileSize: number;
  instrumentsCount: number;
  lastDownloadedTime: string | null;
  cacheLoaded: boolean;
}

/**
 * Instrument search result
 */
export interface InstrumentSearchResult {
  instrumentToken: string;
  tradingSymbol: string;
  exchange: string;
  name: string;
  instrumentType: string;
  strike: number;
  expiry: string;
  lotSize: number;
}

/**
 * Instrument lookup result
 */
export interface InstrumentLookupResult {
  found: boolean;
  instrument: InstrumentSearchResult | null;
}

/**
 * Expiry list result
 */
export interface ExpiryListResult {
  exchange: string;
  symbol: string;
  instrumentType: string;
  expiries: string[];
}

/**
 * Search parameters
 */
export interface InstrumentSearchParams {
  [key: string]: unknown;
  q: string;
  limit?: number;
}

/**
 * Lookup parameters
 */
export interface InstrumentLookupParams {
  [key: string]: unknown;
  exchange: string;
  symbol: string;
  instrumentType?: string;
  expiry?: string;
  strike?: number;
}

/**
 * Expiries request parameters
 */
export interface ExpiriesParams {
  [key: string]: unknown;
  exchange: string;
  symbol: string;
  instrumentType?: string;
}
