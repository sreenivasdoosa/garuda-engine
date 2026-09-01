/**
 * Admin Service - Uses V2 API endpoints
 * Updated to use V2 API endpoints instead of legacy ADMIN endpoints
 */
import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type { User } from '@/types/user_mgmt';
import type { AuditLog, AuditLogFilter } from '@/types/system';
import type { PaginatedResponse, PaginationParams } from '@/types/common';

export interface AnalyticsData {
  totalUsers: number;
  activeUsers: number;
  newUsersThisMonth: number;
  totalTrades: number;
  totalPnl: number;
  activeStrategies: number;
  activeBrokers: number;
  revenue: {
    thisMonth: number;
    lastMonth: number;
    growth: number;
  };
  userGrowth: Array<{ date: string; count: number }>;
  tradeVolume: Array<{ date: string; count: number; pnl: number }>;
  strategyUsage: Array<{ strategy: string; users: number; trades: number }>;
  brokerUsage: Array<{ broker: string; users: number }>;
}

export interface SystemHealth {
  status: 'healthy' | 'degraded' | 'down';
  services: Array<{
    name: string;
    status: 'up' | 'down';
    latency?: number;
    lastChecked: string;
  }>;
  uptime: number;
  lastRestart: string;
}

export interface AdminUserFilter {
  search?: string;
  role?: string;
  isActive?: boolean;
  broker?: string;
  strategy?: string;
}

export const adminService = {
  /**
   * Get all users (V2 API)
   */
  async getUsers(
    params?: AdminUserFilter & PaginationParams
  ): Promise<PaginatedResponse<User>> {
    const response = await api.get<User[]>(API_ENDPOINTS.V2_USERS.LIST, params as Record<string, unknown>);
    // V2 API returns array directly, wrap in paginated response
    const pageSize = params?.pageSize || response.length || 1;
    return {
      data: response,
      total: response.length,
      page: params?.page || 1,
      pageSize,
      totalPages: Math.ceil(response.length / pageSize),
    };
  },

  /**
   * Get user by username (V2 API)
   */
  async getUserById(username: string): Promise<User> {
    return api.get<User>(API_ENDPOINTS.V2_USERS.DETAILS(username));
  },

  /**
   * Update user (V2 API)
   */
  async updateUser(username: string, data: Partial<User>): Promise<User> {
    return api.put<User>(API_ENDPOINTS.V2_USERS.DETAILS(username), data);
  },

  /**
   * Suspend user (V2 API)
   */
  async suspendUser(username: string): Promise<{ success: boolean }> {
    await api.put(API_ENDPOINTS.V2_USERS.SUSPEND(username), {});
    return { success: true };
  },

  /**
   * Activate user (V2 API)
   */
  async activateUser(username: string): Promise<{ success: boolean }> {
    await api.put(API_ENDPOINTS.V2_USERS.ACTIVATE(username), {});
    return { success: true };
  },

  /**
   * Reset user password - Note: V2 API may not have this endpoint
   * Keeping for compatibility, but may need adjustment
   */
  async resetUserPassword(username: string): Promise<{ success: boolean; temporaryPassword: string }> {
    // V2 API doesn't have reset password endpoint, use legacy or implement differently
    return api.post(`${API_ENDPOINTS.V2_USERS.DETAILS(username)}/reset-password`, {});
  },

  /**
   * Get audit logs (V2 API)
   */
  async getAuditLogs(params?: AuditLogFilter & PaginationParams): Promise<PaginatedResponse<AuditLog>> {
    // The V2 list endpoint is server-paginated and returns the standard
    // `{ data, pagination }` envelope. Map it to this legacy paginated shape.
    const res = await api.get<{ data: AuditLog[]; pagination: { page: number; pageSize: number; totalCount: number; totalPages: number } }>(
      API_ENDPOINTS.V2_AUDIT_LOGS.LIST,
      params as Record<string, unknown>,
    );
    return {
      data: res.data,
      total: res.pagination.totalCount,
      page: res.pagination.page,
      pageSize: res.pagination.pageSize,
      totalPages: res.pagination.totalPages,
    };
  },

  /**
   * Get analytics data
   * Note: V2 API may not have a dedicated analytics endpoint
   * This may need to aggregate data from multiple endpoints
   */
  async getAnalytics(_params?: {
    fromDate?: string;
    toDate?: string;
  }): Promise<AnalyticsData> {
    // Placeholder - V2 API doesn't have analytics endpoint
    // Return mock data or aggregate from other endpoints
    console.warn('Analytics endpoint not available in V2 API');
    return {
      totalUsers: 0,
      activeUsers: 0,
      newUsersThisMonth: 0,
      totalTrades: 0,
      totalPnl: 0,
      activeStrategies: 0,
      activeBrokers: 0,
      revenue: { thisMonth: 0, lastMonth: 0, growth: 0 },
      userGrowth: [],
      tradeVolume: [],
      strategyUsage: [],
      brokerUsage: [],
    };
  },

  /**
   * Get system health
   * Note: V2 API may not have this endpoint
   */
  async getSystemHealth(): Promise<SystemHealth> {
    // Placeholder - V2 API doesn't have system health endpoint
    console.warn('System health endpoint not available in V2 API');
    return {
      status: 'healthy',
      services: [],
      uptime: 0,
      lastRestart: new Date().toISOString(),
    };
  },

  /**
   * Export users data
   * Note: V2 API may not have export endpoint
   */
  async exportUsers(format: 'csv' | 'xlsx'): Promise<Blob> {
    return api.get<Blob>(`${API_ENDPOINTS.V2_USERS.LIST}/export`, { format });
  },
};
