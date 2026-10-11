/**
 * TypeScript types for Broker Instruments feature
 */

/**
 * One broker's instrument master, as the engine holds it. `supported` is
 * false for an enabled broker the engine builds no master for; the page
 * says so rather than offering a download that cannot happen.
 */
export interface BrokerInstrumentsStats {
  brokerName: string;
  supported: boolean;
  cacheLoaded: boolean;
  instrumentsCount: number;
  fileBytes: number | null;
  lastDownloadedTime: string | null;
  download: {
    name: string;
    loaded: boolean;
    count: number;
    cachedAt: string | null;
    lastAttemptAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    lastDownloaded: boolean;
    inProgress: boolean;
    isFromToday: boolean;
    isStale: boolean;
    skippedBecause: string | null;
  } | null;
}

/**
 * One instrument as the master lists it. `exchange` is the segment's code
 * (NSE, NFO, BSE, BFO, CDS, MCX) as every broker files it; `venue` is the
 * exchange the engine models. A strike is a price and crosses as a string.
 */
export interface InstrumentSearchResult {
  instrumentToken: string | null;
  instrumentId: string;
  tradingSymbol: string;
  exchange: string;
  venue: string;
  segment: string;
  name: string;
  instrumentType: string;
  strike: string | null;
  expiry: string | null;
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
  strike?: string;
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
