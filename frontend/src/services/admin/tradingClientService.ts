import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  TradingClient,
  TradingClientEdit,
  TradingClientLoginStarted,
} from '@/types/trading-client';

export const tradingClientService = {
  async getAll(): Promise<TradingClient[]> {
    return api.get<TradingClient[]>(API_ENDPOINTS.TRADING_CLIENTS.LIST);
  },

  async get(id: string): Promise<TradingClient> {
    return api.get<TradingClient>(API_ENDPOINTS.TRADING_CLIENTS.DETAILS(id));
  },

  async create(data: TradingClientEdit): Promise<TradingClient> {
    return api.post<TradingClient>(API_ENDPOINTS.TRADING_CLIENTS.LIST, data);
  },

  async update(id: string, data: TradingClientEdit): Promise<TradingClient> {
    return api.put<TradingClient>(API_ENDPOINTS.TRADING_CLIENTS.DETAILS(id), data);
  },

  async remove(id: string): Promise<void> {
    return api.delete(API_ENDPOINTS.TRADING_CLIENTS.DETAILS(id));
  },

  /** Operator-initiated, always. Returns the URL the browser goes to. */
  async login(id: string): Promise<TradingClientLoginStarted> {
    return api.post<TradingClientLoginStarted>(API_ENDPOINTS.TRADING_CLIENTS.LOGIN(id), {});
  },

  async logout(id: string): Promise<TradingClient> {
    return api.post<TradingClient>(API_ENDPOINTS.TRADING_CLIENTS.LOGOUT(id), {});
  },
};
