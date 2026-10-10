import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  ActiveProviders,
  BorrowableClient,
  DataProvider,
  DataProviderEdit,
  InstrumentFileStatus,
  LoginStarted,
  TickerStatus,
} from '@/types/data-provider';

export const dataProvidersService = {
  /** Every provider the engine knows, configured or not. */
  async getAll(): Promise<DataProvider[]> {
    return api.get<DataProvider[]>(API_ENDPOINTS.DATA_PROVIDERS.LIST);
  },

  async getActive(): Promise<ActiveProviders> {
    return api.get<ActiveProviders>(API_ENDPOINTS.DATA_PROVIDERS.ACTIVE);
  },

  async setActive(data: Partial<ActiveProviders>): Promise<ActiveProviders> {
    return api.put<ActiveProviders>(API_ENDPOINTS.DATA_PROVIDERS.ACTIVE, data);
  },

  async save(provider: string, data: DataProviderEdit): Promise<DataProvider> {
    return api.put<DataProvider>(API_ENDPOINTS.DATA_PROVIDERS.DETAILS(provider), data);
  },

  async remove(provider: string): Promise<void> {
    return api.delete(API_ENDPOINTS.DATA_PROVIDERS.DETAILS(provider));
  },

  /** Operator-initiated, always. Returns a URL for the browser, or signs in. */
  async login(provider: string): Promise<LoginStarted> {
    return api.post<LoginStarted>(API_ENDPOINTS.DATA_PROVIDERS.LOGIN(provider), {});
  },

  async logout(provider: string): Promise<void> {
    return api.post(API_ENDPOINTS.DATA_PROVIDERS.LOGOUT(provider), {});
  },

  /** Trading clients this provider could borrow from — same broker, with a key. */
  async borrowable(provider: string): Promise<BorrowableClient[]> {
    return api.get<BorrowableClient[]>(API_ENDPOINTS.DATA_PROVIDERS.BORROWABLE(provider));
  },

  // -- the ticker ---------------------------------------------------------

  async ticker(): Promise<TickerStatus> {
    return api.get<TickerStatus>(API_ENDPOINTS.MARKET_DATA.TICKER);
  },

  async startTicker(): Promise<TickerStatus> {
    return api.post<TickerStatus>(API_ENDPOINTS.MARKET_DATA.TICKER_START, {});
  },

  async stopTicker(): Promise<TickerStatus> {
    return api.post<TickerStatus>(API_ENDPOINTS.MARKET_DATA.TICKER_STOP, {});
  },

  async restartTicker(): Promise<TickerStatus> {
    return api.post<TickerStatus>(API_ENDPOINTS.MARKET_DATA.TICKER_RESTART, {});
  },

  // -- the instrument files -----------------------------------------------

  async instrumentFiles(): Promise<InstrumentFileStatus[]> {
    return api.get<InstrumentFileStatus[]>(API_ENDPOINTS.MARKET_DATA.INSTRUMENTS);
  },

  /** Fetches the file whatever the cache says. Awaited: the operator is watching. */
  async downloadInstrumentFile(name: string): Promise<InstrumentFileStatus> {
    return api.post<InstrumentFileStatus>(API_ENDPOINTS.MARKET_DATA.INSTRUMENT_DOWNLOAD(name), {});
  },
};
