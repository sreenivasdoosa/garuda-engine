/**
 * User Alerts Service
 * API service for user's system alerts
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type { UserSystemAlert, AlertFiltersState } from '@/types/user-portal';
import type { SystemAlert } from '@/types/common';

// User portal alerts endpoints
const USER_ALERTS_ENDPOINTS = {
  LIST: '/api/v2/me/alerts',
  RECENT: '/api/v2/me/alerts/recent',
};

export const userAlertsService = {
  /**
   * Get alerts for current user
   */
  async getAlerts(filters?: AlertFiltersState): Promise<UserSystemAlert[]> {
    const params: Record<string, string> = {};

    if (filters?.level) params.alertLevel = filters.level;
    if (filters?.fromDate) params.startTime = filters.fromDate;
    if (filters?.toDate) params.endTime = filters.toDate;

    const response = await api.get<SystemAlert[]>(USER_ALERTS_ENDPOINTS.LIST, params);

    return response.map((alert) => ({
      id: `${alert.timestamp}-${alert.operation}`,
      timestamp: alert.timestamp,
      alertLevel: alert.alertLevel,
      entityType: alert.entityType,
      entityName: alert.entityName,
      operation: alert.operation,
      alertMessage: alert.alertMessage,
    }));
  },

  /**
   * Get recent alerts for current user (for notifications)
   */
  async getRecentAlerts(limit: number = 10): Promise<UserSystemAlert[]> {
    const response = await api.get<SystemAlert[]>(USER_ALERTS_ENDPOINTS.RECENT, {
      limit: String(limit),
    });

    return response.map((alert) => ({
      id: `${alert.timestamp}-${alert.operation}`,
      timestamp: alert.timestamp,
      alertLevel: alert.alertLevel,
      entityType: alert.entityType,
      entityName: alert.entityName,
      operation: alert.operation,
      alertMessage: alert.alertMessage,
    }));
  },
};
