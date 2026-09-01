/**
 * User Billing Service
 * API service for user's billing data
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type { UserBill, BillingSummary, DateRangeFilter } from '@/types/user-portal';

// User portal billing endpoints
const USER_BILLING_ENDPOINTS = {
  BILLS: '/api/v2/me/bills',
  SUMMARY: '/api/v2/me/billing/summary',
};

export const userBillingService = {
  /**
   * Get bills for current user
   */
  async getBills(dateRange?: DateRangeFilter): Promise<UserBill[]> {
    const params: Record<string, string> = {};
    if (dateRange?.fromDate) params.fromDate = dateRange.fromDate;
    if (dateRange?.toDate) params.toDate = dateRange.toDate;

    return api.get<UserBill[]>(USER_BILLING_ENDPOINTS.BILLS, params);
  },

  /**
   * Get billing summary for current user
   * Server calculates this from bills
   */
  async getBillingSummary(): Promise<BillingSummary> {
    return api.get<BillingSummary>(USER_BILLING_ENDPOINTS.SUMMARY);
  },
};
