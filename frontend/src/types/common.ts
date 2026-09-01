// Common type definitions

/** One brand. The type stays so callers keep compiling. */
export type Brand = 'garuda-engine';

export interface ApiResponse<T> {
  data: T;
  message?: string;
  success: boolean;
}

export interface ApiError {
  error: string;
  message?: string;
  statusCode?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface PaginationParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface SelectOption {
  value: string;
  label: string;
}

export type AlertLevel = 'CRITICAL' | 'WARNING' | 'INFO';

// Audience tier for a system alert. OPERATOR = surfaced on the default
// "Important Alerts" view and via WebSocket toast. DEVELOPER = persisted for
// debugging, hidden unless the Alerts page is toggled to "All".
export type AlertAudience = 'OPERATOR' | 'DEVELOPER';

// System Alert (from AlertManager - trading activity, login failures, etc.)
// Alerts with the same uniqueKey today coalesce into one row: `timestamp`
// advances to the latest occurrence, `firstOccurrenceTime` stays locked on
// the first, `occurrenceCount` increments. Alerts without a uniqueKey
// (genuinely one-shot events) always return `occurrenceCount === 1`.
export interface SystemAlert {
  timestamp: string;
  alertLevel: AlertLevel;
  entityType: string;
  entityName: string;
  operation: string;
  alertMessage: string;
  audience?: AlertAudience;
  uniqueKey?: string;
  firstOccurrenceTime?: string;
  occurrenceCount?: number;
}

// Paginated alerts response
export interface AlertsPageResponse {
  alerts: SystemAlert[];
  pagination: {
    page: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Alert filters available from server
export interface AlertFilters {
  operations: string[];
  entityTypes: string[];
  entityNames: string[];
  alertLevels: string[];
}

// Alert filter params for API requests
export interface AlertFilterParams {
  page?: number;
  pageSize?: number;
  alertLevel?: string;
  entityType?: string;
  entityName?: string;
  operation?: string;
  search?: string;
  startTime?: string;
  endTime?: string;
  // "important" (OPERATOR only) / "all" (both) / "developer" (DEVELOPER only).
  // Defaults server-side to "important".
  audience?: 'important' | 'all' | 'developer';
}

export type TradeStatus = 'ACTIVE' | 'COMPLETED' | 'CANCELLED' | 'PENDING' | 'REJECTED';

export type OrderType = 'BUY' | 'SELL';

export type PositionType = 'LONG' | 'SHORT';
