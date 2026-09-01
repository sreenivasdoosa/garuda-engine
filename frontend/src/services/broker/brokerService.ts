import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  Broker,
  BrokerLoginRules,
  BrokerCredentials,
  BrokerLoginStatus,
  BrokerFunds,
  BrokerUsage,
  CreateBrokerRequest,
  UpdateBrokerRequest,
} from '@/types/broker';

/**
 * Broker Service - V2 API
 * Endpoint: /api/v2/brokers
 */
export const brokerService = {
  /**
   * Get all brokers
   * GET /api/v2/brokers
   */
  async getAll(): Promise<Broker[]> {
    return api.get<Broker[]>(API_ENDPOINTS.V2_BROKERS.LIST);
  },

  /**
   * Get broker by name
   * GET /api/v2/brokers/{name}
   */
  async getByName(name: string): Promise<Broker> {
    return api.get<Broker>(API_ENDPOINTS.V2_BROKERS.DETAILS(name));
  },

  /**
   * Create new broker (admin only)
   * POST /api/v2/brokers
   */
  async create(data: CreateBrokerRequest): Promise<Broker> {
    return api.post<Broker>(API_ENDPOINTS.V2_BROKERS.BASE, data);
  },

  /**
   * Update broker (admin only)
   * PUT /api/v2/brokers/{name}
   */
  async update(name: string, data: UpdateBrokerRequest): Promise<Broker> {
    return api.put<Broker>(API_ENDPOINTS.V2_BROKERS.DETAILS(name), data);
  },

  /**
   * Delete broker (admin only)
   * DELETE /api/v2/brokers/{name}
   * Returns 409 Conflict with a {usage: BrokerUsage} body if any FK-protected
   * dependency rows still reference this broker.
   */
  async delete(name: string): Promise<void> {
    return api.delete(API_ENDPOINTS.V2_BROKERS.DETAILS(name));
  },

  /**
   * Pre-flight dependency check for the delete-broker UX.
   * GET /api/v2/brokers/{name}/usage
   */
  async getUsage(name: string): Promise<BrokerUsage> {
    return api.get<BrokerUsage>(`${API_ENDPOINTS.V2_BROKERS.DETAILS(name)}/usage`);
  },

  /**
   * Stop broker
   * PUT /api/v2/brokers/{name}/stop
   */
  async stop(name: string): Promise<void> {
    return api.put(API_ENDPOINTS.V2_BROKERS.STOP(name), {});
  },

  /**
   * Unstop broker
   * PUT /api/v2/brokers/{name}/unstop
   */
  async unstop(name: string): Promise<void> {
    return api.put(API_ENDPOINTS.V2_BROKERS.UNSTOP(name), {});
  },

  // Legacy V1 APIs for broker login/credentials (keep for now until migrated)

  /**
   * Get broker login rules
   */
  async getLoginRules(broker: string): Promise<BrokerLoginRules> {
    return api.get<BrokerLoginRules>(API_ENDPOINTS.BROKER.LOGIN_RULES, { broker });
  },

  /**
   * Add broker credentials for user
   */
  async addCredentials(data: BrokerCredentials): Promise<{ success: boolean }> {
    return api.post(API_ENDPOINTS.BROKER.BASE, data);
  },

  /**
   * Update broker credentials
   */
  async updateCredentials(data: BrokerCredentials): Promise<{ success: boolean }> {
    return api.put(API_ENDPOINTS.BROKER.BASE, data);
  },

  /**
   * Remove broker for user
   */
  async removeCredentials(broker: string): Promise<{ success: boolean }> {
    return api.delete(API_ENDPOINTS.BROKER.BASE, { broker });
  },

  /**
   * Get broker login status
   */
  async getLoginStatus(broker?: string): Promise<BrokerLoginStatus[]> {
    return api.get<BrokerLoginStatus[]>(API_ENDPOINTS.BROKER.LOGIN_STATUS, { broker });
  },

  /**
   * Get broker password (admin/clientmanager only)
   */
  async getPassword(username: string, broker: string): Promise<{ password: string }> {
    return api.get(API_ENDPOINTS.BROKER.PASSWORD, { username, broker });
  },

  /**
   * Get broker funds
   */
  async getFunds(broker?: string): Promise<BrokerFunds[]> {
    return api.get<BrokerFunds[]>(API_ENDPOINTS.BROKER.FUNDS, { broker });
  },

  /**
   * Trigger broker login
   */
  async triggerLogin(broker: string): Promise<{ success: boolean; message: string }> {
    return api.post(`${API_ENDPOINTS.BROKER.BASE}/${broker}/login`, {});
  },
};
