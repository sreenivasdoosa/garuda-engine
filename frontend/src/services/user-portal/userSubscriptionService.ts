/**
 * User Subscription Service
 * API service for user's strategy subscriptions
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type {
  UserStrategySubscription,
  CreateUserSubscriptionRequest,
  UpdateUserSubscriptionRequest,
} from '@/types/strategy-engine';

// User portal subscription endpoints
const USER_SUBSCRIPTION_ENDPOINTS = {
  LIST: '/api/v2/me/subscriptions',
  DETAILS: (id: number) => `/api/v2/me/subscriptions/${id}`,
  ACTIVATE: (id: number) => `/api/v2/me/subscriptions/${id}/activate`,
  DEACTIVATE: (id: number) => `/api/v2/me/subscriptions/${id}/deactivate`,
  STRATEGIES: '/api/v2/me/strategies',  // Strategies visible to user (own + public + subscribed SYSTEM)
  STRATEGIES_SUBSCRIBABLE: '/api/v2/me/strategies/subscribable',  // Strategies the user can self-subscribe to
};

export const userSubscriptionService = {
  /**
   * Get all subscriptions for current user
   */
  async getSubscriptions(): Promise<UserStrategySubscription[]> {
    return api.get<UserStrategySubscription[]>(USER_SUBSCRIPTION_ENDPOINTS.LIST);
  },

  /**
   * Get subscription details
   */
  async getSubscriptionDetails(id: number): Promise<UserStrategySubscription> {
    return api.get<UserStrategySubscription>(USER_SUBSCRIPTION_ENDPOINTS.DETAILS(id));
  },

  /**
   * Create a new subscription
   * Note: username is extracted from JWT on server side
   */
  async createSubscription(
    data: Omit<CreateUserSubscriptionRequest, 'username'>
  ): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(USER_SUBSCRIPTION_ENDPOINTS.LIST, data);
  },

  /**
   * Update subscription (capital, etc.)
   */
  async updateSubscription(
    id: number,
    data: UpdateUserSubscriptionRequest
  ): Promise<UserStrategySubscription> {
    return api.put<UserStrategySubscription>(USER_SUBSCRIPTION_ENDPOINTS.DETAILS(id), data);
  },

  /**
   * Delete a subscription
   */
  async deleteSubscription(id: number): Promise<void> {
    return api.delete(USER_SUBSCRIPTION_ENDPOINTS.DETAILS(id));
  },

  /**
   * Activate a subscription
   */
  async activateSubscription(id: number): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(USER_SUBSCRIPTION_ENDPOINTS.ACTIVATE(id), {});
  },

  /**
   * Deactivate a subscription
   */
  async deactivateSubscription(id: number): Promise<UserStrategySubscription> {
    return api.post<UserStrategySubscription>(USER_SUBSCRIPTION_ENDPOINTS.DEACTIVATE(id), {});
  },

  /**
   * Get strategies visible to the user (own + public + already-subscribed SYSTEM).
   * Includes SYSTEM-scope strategies the user is subscribed to (for display/scope lookup).
   */
  async getAvailableStrategies(): Promise<StrategyInfo[]> {
    return api.get<StrategyInfo[]>(USER_SUBSCRIPTION_ENDPOINTS.STRATEGIES);
  },

  /**
   * Get strategies the user can self-subscribe to (ACTIVE, USER-scope, own or public).
   * Excludes SYSTEM-scope strategies, which are admin-assigned only.
   * Use this for the "add subscription" strategy picker.
   */
  async getSubscribableStrategies(): Promise<StrategyInfo[]> {
    return api.get<StrategyInfo[]>(USER_SUBSCRIPTION_ENDPOINTS.STRATEGIES_SUBSCRIBABLE);
  },
};

/**
 * Simplified strategy info returned by user portal
 */
export interface StrategyInfo {
  strategyId: number;
  strategyName: string;
  displayName: string;
  displayOrder?: number;
  templateName: string;
  exchange: string;
  product: string;
  fnoSymbolName: string;
  capitalPerLot?: number;
  capitalPerLotHedged?: number;
  capitalPerLotNaked?: number;
  startTime: string;
  stopTime: string;
  status: string;
  isPublic: boolean;
  scope: 'SYSTEM' | 'USER';
  isOwner: string;  // username of owner
  // Risk allocation fields
  riskPercentage?: number;
  absoluteMaxRisk?: number;
  minRiskPercentage?: number;
  maxRiskPercentage?: number;
  // Equity fields (tradeMode === 'EQUITY'): leverage override bounds for the subscribe form
  tradeMode?: string;
  leverage?: number;
  minLeverage?: number;
  maxLeverage?: number;
  maxActivePositions?: number;
  // Watchlist binding: the subscribe form computes the capital grid for universe-driven strategies
  universeId?: number;
}
