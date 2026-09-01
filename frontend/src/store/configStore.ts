import { create } from 'zustand';
import type { Brand } from '@/types/common';
import { getBaseUrl } from '@/config/env';

/**
 * What the Console knows about the server it is talking to.
 *
 * The engine this was copied from ran several brands, two deployment modes,
 * an SSO option and a billing system, and this store answered questions about
 * all of them. Garuda is one product, self-hosted, with one local admin and
 * no billing, so most of those questions have one answer and are gone rather
 * than stubbed: a helper that always returns false is a branch nobody deletes.
 */

interface BrandConfig {
  name: string;
  productName: string;
  primaryColor: string;
  logoUrl: string;
}

const BRAND_CONFIG: BrandConfig = {
  name: 'garuda-engine',
  productName: 'Garuda Engine',
  primaryColor: '#3b82f6',
  logoUrl: '/logo.svg',
};

interface ServerConfig {
  supportedBrokers: string[];
  features: Record<string, boolean>;
  /** Which asset classes this deployment trades. */
  tradingMode?: 'EQUITY' | 'FNO' | 'BOTH';
}

interface ConfigState {
  serverHost: string;
  serverConfig: ServerConfig | null;
  brand: Brand;
  brandConfig: BrandConfig;
  supportedBrokers: string[];
  strategies: string[];

  getTradingMode: () => 'EQUITY' | 'FNO' | 'BOTH';
  supportsEquity: () => boolean;
  supportsFnO: () => boolean;
  isEquityOnly: () => boolean;

  initializeConfig: () => void;
  setServerConfig: (config: ServerConfig) => void;
  setSupportedBrokers: (brokers: string[]) => void;
  setStrategies: (strategies: string[]) => void;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  serverHost: '',
  serverConfig: null,
  brand: 'garuda-engine',
  brandConfig: BRAND_CONFIG,
  supportedBrokers: [],
  strategies: [],

  // Absent config is treated as BOTH.
  getTradingMode: () => get().serverConfig?.tradingMode ?? 'BOTH',
  supportsEquity: () => {
    const mode = get().serverConfig?.tradingMode ?? 'BOTH';
    return mode === 'EQUITY' || mode === 'BOTH';
  },
  supportsFnO: () => {
    const mode = get().serverConfig?.tradingMode ?? 'BOTH';
    return mode === 'FNO' || mode === 'BOTH';
  },
  isEquityOnly: () => get().serverConfig?.tradingMode === 'EQUITY',

  initializeConfig: () => {
    set({ serverHost: getBaseUrl(), brand: 'garuda-engine', brandConfig: BRAND_CONFIG });
    document.title = BRAND_CONFIG.productName;
    document.documentElement.style.setProperty('--brand-primary', BRAND_CONFIG.primaryColor);
  },

  setServerConfig: (config) => set({ serverConfig: config }),
  setSupportedBrokers: (brokers) => set({ supportedBrokers: brokers }),
  setStrategies: (strategies) => set({ strategies }),
}));
