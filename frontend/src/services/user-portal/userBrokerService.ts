/**
 * User Broker Service
 * API service for user's broker operations
 * Uses /api/v2/me/* endpoints (no username needed - extracted from JWT)
 */

import { api } from '@/api/client';
import type {
  UserBrokerInfo,
  UserBrokerFunds,
  AddBrokerRequest,
  UpdateBrokerRequest,
  BrokerLoginResponse,
} from '@/types/user-portal';

// User portal endpoints - no username required, uses JWT token
const USER_BROKER_ENDPOINTS = {
  LIST: '/api/v2/me/brokers',
  DETAILS: (broker: string) => `/api/v2/me/brokers/${broker}`,
  FUNDS: (broker: string) => `/api/v2/me/brokers/${broker}/funds`,
  LOGIN: (broker: string) => `/api/v2/me/brokers/${broker}/login`,
  LOGIN_AUTO: (broker: string) => `/api/v2/me/brokers/${broker}/login/auto`,
  LOGIN_STATUS: (broker: string) => `/api/v2/me/brokers/${broker}/login/status`,
  LOGOUT: (broker: string) => `/api/v2/me/brokers/${broker}/logout`,
  ENABLE: (broker: string) => `/api/v2/me/brokers/${broker}/enable`,
  DISABLE: (broker: string) => `/api/v2/me/brokers/${broker}/disable`,
};

export const userBrokerService = {
  /**
   * Get all brokers for current user
   */
  async getBrokers(): Promise<UserBrokerInfo[]> {
    return api.get<UserBrokerInfo[]>(USER_BROKER_ENDPOINTS.LIST);
  },

  /**
   * Get broker details
   */
  async getBrokerDetails(broker: string): Promise<UserBrokerInfo> {
    return api.get<UserBrokerInfo>(USER_BROKER_ENDPOINTS.DETAILS(broker));
  },

  /**
   * Add a new broker
   */
  async addBroker(data: AddBrokerRequest): Promise<UserBrokerInfo> {
    // Transform UI field names to server field names
    const serverData = {
      broker: data.broker,
      clientID: data.clientId,
      clientPassword: data.password,
      clientPIN: data.pin,
      totpKey: data.totp,
      appKey: data.apiKey,
      appSecret: data.apiSecret,
    };
    return api.post<UserBrokerInfo>(USER_BROKER_ENDPOINTS.LIST, serverData);
  },

  /**
   * Update broker credentials
   */
  async updateBroker(broker: string, data: UpdateBrokerRequest): Promise<UserBrokerInfo> {
    // Transform UI field names to server field names
    const serverData: Record<string, string | undefined> = {};
    if (data.password !== undefined) serverData.clientPassword = data.password;
    if (data.pin !== undefined) serverData.clientPIN = data.pin;
    if (data.totp !== undefined) serverData.totpKey = data.totp;
    if (data.apiKey !== undefined) serverData.appKey = data.apiKey;
    if (data.apiSecret !== undefined) serverData.appSecret = data.apiSecret;
    return api.put<UserBrokerInfo>(USER_BROKER_ENDPOINTS.DETAILS(broker), serverData);
  },

  /**
   * Remove a broker
   */
  async removeBroker(broker: string): Promise<void> {
    return api.delete(USER_BROKER_ENDPOINTS.DETAILS(broker));
  },

  /**
   * Get login status for a broker
   */
  async getLoginStatus(broker: string): Promise<{ isLoggedIn: boolean; clientID?: string }> {
    return api.get<{ isLoggedIn: boolean; clientID?: string }>(
      USER_BROKER_ENDPOINTS.LOGIN_STATUS(broker)
    );
  },

  /**
   * Trigger auto-login for a broker
   */
  async autoLogin(broker: string): Promise<BrokerLoginResponse> {
    return api.post<BrokerLoginResponse>(USER_BROKER_ENDPOINTS.LOGIN_AUTO(broker), {});
  },

  /**
   * Get manual login URL (for OAuth-based brokers)
   */
  async getManualLoginUrl(broker: string): Promise<BrokerLoginResponse> {
    return api.get<BrokerLoginResponse>(USER_BROKER_ENDPOINTS.LOGIN(broker));
  },

  /**
   * Logout from a broker
   */
  async logout(broker: string): Promise<void> {
    return api.post(USER_BROKER_ENDPOINTS.LOGOUT(broker), {});
  },

  /**
   * Get funds for all user's brokers
   */
  async getAllFunds(): Promise<UserBrokerFunds[]> {
    const brokers = await this.getBrokers();
    const fundsPromises = brokers.map(async (b) => {
      try {
        const funds = await this.getFunds(b.broker);
        return funds;
      } catch {
        // Return empty funds if fetch fails
        return {
          broker: b.broker,
          totalMargin: 0,
          utilizedMargin: 0,
          availableMargin: 0,
        };
      }
    });
    return Promise.all(fundsPromises);
  },

  /**
   * Get funds for a specific broker
   */
  async getFunds(broker: string): Promise<UserBrokerFunds> {
    return api.get<UserBrokerFunds>(USER_BROKER_ENDPOINTS.FUNDS(broker));
  },

  /**
   * Enable a broker
   */
  async enableBroker(broker: string): Promise<void> {
    return api.put(USER_BROKER_ENDPOINTS.ENABLE(broker), {});
  },

  /**
   * Disable a broker
   */
  async disableBroker(broker: string): Promise<void> {
    return api.put(USER_BROKER_ENDPOINTS.DISABLE(broker), {});
  },
};
