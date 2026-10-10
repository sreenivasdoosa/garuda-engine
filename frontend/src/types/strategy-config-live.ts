/**
 * Strategy configuration as garuda serves it: rows at four scopes -- base,
 * day, tranche, tranche and day -- merged per column by the engine, most
 * specific value winning. A null is "not set at this scope", never "set to
 * nothing".
 */

export interface ConfigRow {
  id: number;
  strategyName: string;
  tranchNumber: number | null;
  dayCondition: string | null;
  priority: number;
  scope: string;
  description: string | null;
  /** Wire names of every setting this row sets. */
  setFields: string[];
  createdAt: string | null;
  updatedAt: string | null;
  [setting: string]: unknown;
}

export type ConfigEdit = Record<string, unknown> & {
  strategyName?: string;
  tranchNumber?: number | null;
  dayCondition?: string | null;
  description?: string | null;
};

export interface ConfigField {
  column: string;
  kind: 'boolean' | 'integer' | 'decimal' | 'text';
  readByEngine: boolean;
  baseOnly: boolean;
  choices: string[];
}

export interface ConfigCatalog {
  fields: Record<string, ConfigField>;
  groups: { name: string; fields: string[] }[];
  dayConditions: { code: string; name: string }[];
}

export interface ConfiguredStrategy {
  strategyName: string;
  displayName: string | null;
  status: string;
  startTime: string | null;
  rows: number;
}

export interface EffectiveConfig {
  strategyName: string;
  tranchNumber: number;
  dayConditions: string[];
  values: Record<string, unknown>;
  sources: Record<
    string,
    { tranchNumber: number | null; dayCondition: string | null; priority: number; scope: string }
  >;
  layersInScope: number;
}
