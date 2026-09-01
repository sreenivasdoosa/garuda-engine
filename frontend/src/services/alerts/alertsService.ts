import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { SystemAlert, AlertsPageResponse, AlertFilters, AlertFilterParams } from '@/types/common';

export const alertsService = {
  /**
   * Get recent alerts for bell icon in header.
   * Returns the most recent alerts up to the specified limit.
   * Optionally filter by alertLevel (e.g., 'CRITICAL').
   */
  async getRecentAlerts(limit: number = 50, alertLevel?: string): Promise<SystemAlert[]> {
    const params = new URLSearchParams();
    params.append('limit', String(limit));
    if (alertLevel) {
      params.append('alertLevel', alertLevel);
    }
    return api.get<SystemAlert[]>(`${API_ENDPOINTS.V2_ALERTS.RECENT}?${params.toString()}`);
  },

  /**
   * Get alerts since a specific timestamp (for polling/auto-refresh).
   * Returns only alerts newer than the given timestamp.
   */
  async getAlertsSince(timestamp: string): Promise<SystemAlert[]> {
    return api.get<SystemAlert[]>(`${API_ENDPOINTS.V2_ALERTS.SINCE}?timestamp=${encodeURIComponent(timestamp)}`);
  },

  /**
   * Get paginated alerts with filters and search.
   */
  async getAlerts(params: AlertFilterParams = {}): Promise<AlertsPageResponse> {
    const queryParams = new URLSearchParams();

    if (params.page) queryParams.append('page', String(params.page));
    if (params.pageSize) queryParams.append('pageSize', String(params.pageSize));
    if (params.alertLevel) queryParams.append('alertLevel', params.alertLevel);
    if (params.entityType) queryParams.append('entityType', params.entityType);
    if (params.entityName) queryParams.append('entityName', params.entityName);
    if (params.operation) queryParams.append('operation', params.operation);
    if (params.search) queryParams.append('search', params.search);
    if (params.startTime) queryParams.append('startTime', params.startTime);
    if (params.endTime) queryParams.append('endTime', params.endTime);
    if (params.audience) queryParams.append('audience', params.audience);

    const queryString = queryParams.toString();
    const url = queryString ? `${API_ENDPOINTS.V2_ALERTS.BASE}?${queryString}` : API_ENDPOINTS.V2_ALERTS.BASE;

    return api.get<AlertsPageResponse>(url);
  },

  /**
   * Get available filter options (operations, entity types, alert levels).
   */
  async getFilters(): Promise<AlertFilters> {
    return api.get<AlertFilters>(API_ENDPOINTS.V2_ALERTS.FILTERS);
  },
};
