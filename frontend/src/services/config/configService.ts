import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { setRuntimeWsHost } from '@/config/env';
import { setClientSidePnl, setShowTerminalPnlChart, setAiClientConfig } from '@/config/featureFlags';

export interface OAuthConfig {
  authServiceUrl: string;
  clientId: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  logoutUrl: string;
  // Legacy/backward compatibility
  authorizeEndpoint?: string;
}

export interface ServerConfig {
  isPrepaid: boolean;
  billingEnabled?: boolean;
  supportedBrokers: string[];
  features: Record<string, boolean>;
  oauth?: OAuthConfig;
  deploymentMode?: 'DISTRIBUTED' | 'STANDALONE';
  authMode?: 'SSO' | 'LOCAL';
  /**
   * Trading asset-class mode this deployment supports (app.trading.mode).
   * Drives equity vs F&O UI gating. Absent = treat as BOTH.
   */
  tradingMode?: 'EQUITY' | 'FNO' | 'BOTH';
  /** Direct WebSocket host (server.ws.host) — absent when WS stays on the page origin. */
  wsHost?: string;
  /**
   * Phase-2 flag (userportal.clientside.pnl.enabled): user portal uses the client-side
   * PnL engine when true; absent/false = legacy terminal-summary behavior.
   */
  clientSidePnl?: boolean;
  /**
   * Show the intraday P&L chart on the client-side terminal. Server drives this off
   * `aggregated.pnl.snapshot.enabled` (the per-user snapshot writer); absent/false = hidden.
   * Applies to the terminal.
   */
  showTerminalPnlChart?: boolean;
  /** AI assistant client hints (server-enforced limits mirrored to the UI). */
  ai?: { maxQuestionChars?: number };
}

export interface SystemConfig {
  supportedBrokers: string[];
  strategies: string[];
  allocationModels: AllocationModel[];
}

export interface AllocationModel {
  id: string;
  name: string;
  description: string;
}

export interface FAQ {
  id: string;
  question: string;
  answer: string;
  category: string;
  order: number;
}

export interface BuildInfoComponent {
  app?: string;
  version?: string;
  githash?: string;
  buildtime?: string;
  builder?: string;
}

export interface BuildInfo {
  core: BuildInfoComponent;
  marketData: BuildInfoComponent;
}

export const configService = {
  /**
   * Get OAuth configuration from backend (public endpoint)
   */
  async getAuthConfig(): Promise<OAuthConfig> {
    return api.get<OAuthConfig>(API_ENDPOINTS.AUTH.CONFIG);
  },

  /**
   * Get public server configuration.
   * Side effect: publishes the server-pushed WebSocket host (wsHost) so
   * getWsHost() — and through it both WS connections plus the auth-cookie
   * domain scoping — use the instance's configured direct WS hostname.
   */
  async getServerConfig(): Promise<ServerConfig> {
    const config = await api.get<ServerConfig>(API_ENDPOINTS.CONFIG.PUBLIC);
    setRuntimeWsHost(config.wsHost);
    setClientSidePnl(config.clientSidePnl);
    setShowTerminalPnlChart(config.showTerminalPnlChart);
    setAiClientConfig(config.ai);
    return config;
  },

  /**
   * Get system configuration (authenticated)
   */
  async getSystemConfig(): Promise<SystemConfig> {
    return api.get<SystemConfig>(API_ENDPOINTS.CONFIG.SYSTEM);
  },

  /**
   * Update system configuration (admin only)
   */
  async updateConfig(data: Partial<SystemConfig>): Promise<SystemConfig> {
    return api.put<SystemConfig>(API_ENDPOINTS.CONFIG.SYSTEM, data);
  },

  /**
   * Get build info
   */
  async getBuildInfo(): Promise<BuildInfo> {
    return api.get<BuildInfo>(API_ENDPOINTS.UTILS.BUILD_INFO);
  },

  /**
   * Get FAQs
   */
  async getFAQs(): Promise<FAQ[]> {
    return api.get<FAQ[]>(API_ENDPOINTS.UTILS.FAQ);
  },

  /**
   * Get allocation models
   */
  async getAllocationModels(): Promise<AllocationModel[]> {
    return api.get<AllocationModel[]>(API_ENDPOINTS.UTILS.ALLOCATION_MODELS);
  },

  /**
   * Generate referral code
   */
  async generateReferralCode(data: { email: string }): Promise<{ code: string }> {
    return api.post(API_ENDPOINTS.UTILS.REFERRAL_CODE, data);
  },
};
