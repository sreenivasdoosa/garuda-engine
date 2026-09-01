// Stock universe (watchlist) types — equity strategies bind to a universe.
// Maps to: the reference engine
// API: /api/v2/engine/universes

export type UniverseType = 'PREDEFINED_INDEX' | 'CUSTOM';

export interface StockUniverse {
  universeId?: number;
  name: string;
  universeType: UniverseType;
  /** For PREDEFINED_INDEX: the NSE index key (NIFTY50, FNO, NIFTY500, ...). */
  indexKey?: string;
  exchange: string;          // e.g. NSE
  isActive: boolean;
  source?: string;           // NSE_CSV | MANUAL
  lastRefreshedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Constituent trading symbols (populated on detail fetch). */
  members?: string[];
}

export interface CreateStockUniverseRequest {
  name: string;
  universeType?: UniverseType;
  indexKey?: string;
  exchange?: string;
  isActive?: boolean;
  members?: string[];
}

export interface UpdateStockUniverseRequest {
  name?: string;
  exchange?: string;
  source?: string;
  isActive?: boolean;
  members?: string[];
}
