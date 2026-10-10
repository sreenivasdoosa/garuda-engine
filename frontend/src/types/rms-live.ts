/**
 * Risk as garuda serves it: limits at a scope, the breach log, and the kill
 * switches. A limit row is scoped by its populated columns -- exchange,
 * symbol, trading client, segment -- and the gate takes the narrowest row
 * that applies, column by column. A null is "not set at this scope".
 */

export type RiskLevel = 'GLOBAL' | 'EXCHANGE' | 'SYMBOL' | 'CLIENT';
export type RiskSegment = 'EQUITY' | 'FUTURES' | 'OPTIONS';

export interface RiskRow {
  id: number;
  configLevel: RiskLevel;
  exchange: string | null;
  symbol: string | null;
  tradingClientId: string | null;
  tradingClient: string | null;
  broker: string | null;
  segmentType: RiskSegment | null;
  isActive: boolean;
  scope: string;
  /** Wire names of every limit this row sets. */
  setFields: string[];
  createdAt: string | null;
  updatedAt: string | null;
  [limit: string]: unknown;
}

export type RiskEdit = Record<string, unknown> & {
  exchange?: string | null;
  symbol?: string | null;
  tradingClientId?: string | null;
  segmentType?: string | null;
  isActive?: boolean;
};

export interface RiskField {
  column: string;
  kind: 'boolean' | 'integer' | 'decimal' | 'text';
  /** Whether a check in the gate reads this limit today. */
  enforced: boolean;
  /** The scopes at which this limit means something. */
  levels: RiskLevel[];
}

export interface RiskCatalog {
  fields: Record<string, RiskField>;
  groups: { name: string; fields: string[] }[];
  levels: RiskLevel[];
  segments: RiskSegment[];
  killLevels: KillLevel[];
  automaticSources: KillSource[];
}

export interface EffectiveRisk {
  segmentType: string | null;
  exchange: string | null;
  symbol: string | null;
  tradingClientId: string | null;
  config: Record<string, unknown>;
  sources: Record<string, string>;
  enforced: string[];
  layersInScope: number;
}

export interface RiskStatus {
  enabled: true;
  activeConfigRows: number;
  activeKillSwitchCount: number;
  breachesToday: number;
}

export interface Breach {
  id: number;
  breachTime: string | null;
  tradingClientId: string | null;
  tradingClient: string | null;
  broker: string | null;
  strategyName: string | null;
  tradingSymbol: string | null;
  exchange: string | null;
  breachType: string | null;
  breachCategory: string | null;
  breachDetails: string | null;
  actionTaken: string | null;
  currentValue: string | null;
  limitValue: string | null;
  severity: number;
}

export interface BreachPage {
  data: Breach[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
  summary: { highSeverity: number; uniqueClients: number };
}

export interface BreachFilters {
  breachTypes: string[];
  categories: string[];
  typesByCategory: Record<string, string[]>;
  severities: Record<string, number>;
}

export type KillLevel = 'GLOBAL' | 'EXCHANGE' | 'SYMBOL' | 'CLIENT';
export type KillSource = 'MANUAL' | 'DAILY_LOSS' | 'REJECTION_RATE' | 'VOLATILITY';

export interface KillSwitchEntry {
  key: string;
  level: KillLevel;
  exchange: string | null;
  symbol: string | null;
  tradingClientId: string | null;
  tradingClient: string | null;
  broker: string | null;
  reason: string | null;
  /** On, and stopping entries. Off is listed but stops nothing. */
  active: boolean;
  source: KillSource;
  createdDate: string;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface KillSwitchStatus {
  date: string;
  switches: KillSwitchEntry[];
  activeCount: number;
  typeStates: Record<string, boolean>;
  /** The reference raises switches on its own; garuda does not yet. */
  automaticSourcesBuilt: boolean;
}

export interface KillSwitchRequest {
  level: KillLevel;
  exchange?: string | null;
  symbol?: string | null;
  tradingClientId?: string | null;
  reason?: string | null;
}
