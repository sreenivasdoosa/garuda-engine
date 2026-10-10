import { api } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  AccountDetails,
  AccountSummary,
  BrokerPositionRow,
  MarginsRow,
  SquareOffOutcome,
  SquareOffScope,
  TerminalAlert,
} from '@/types/terminal-live';

/** The Terminal as garuda serves it. Keyed by trading client, never by user. */
export const liveTerminalService = {
  async summaries(): Promise<AccountSummary[]> {
    return api.get<AccountSummary[]>(API_ENDPOINTS.LIVE_TERMINAL.SUMMARIES);
  },

  async alerts(): Promise<TerminalAlert[]> {
    return api.get<TerminalAlert[]>(API_ENDPOINTS.LIVE_TERMINAL.ALERTS);
  },

  async details(id: string): Promise<AccountDetails> {
    return api.get<AccountDetails>(API_ENDPOINTS.LIVE_TERMINAL.DETAILS(id));
  },

  /** The broker's own view, fetched now. Never on the broadcast. */
  async brokerPositions(id: string): Promise<BrokerPositionRow[]> {
    return api.get<BrokerPositionRow[]>(API_ENDPOINTS.LIVE_TERMINAL.BROKER_POSITIONS(id));
  },

  async margins(id: string): Promise<MarginsRow> {
    return api.get<MarginsRow>(API_ENDPOINTS.LIVE_TERMINAL.MARGINS(id));
  },

  async squareOff(
    id: string,
    scope: SquareOffScope,
    strategies?: string[],
  ): Promise<SquareOffOutcome> {
    return api.post<SquareOffOutcome>(API_ENDPOINTS.LIVE_TERMINAL.SQUARE_OFF(id), {
      product: scope,
      strategies: strategies ?? null,
    });
  },

  async squareOffTrade(id: string, tradeId: string): Promise<SquareOffOutcome> {
    return api.post<SquareOffOutcome>(API_ENDPOINTS.LIVE_TERMINAL.SQUARE_OFF_TRADE(id, tradeId), {});
  },
};
