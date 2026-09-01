/**
 * Data providers: who supplies ticks, quotes and candles.
 *
 * A trading client places orders; a data provider supplies prices. Where the
 * vendor issues one app key for both — Zerodha, Fyers, Dhan — a provider
 * borrows a trading client's credentials rather than holding a copy, and then
 * there is one session: signing in on either page signs in both.
 */

/** Where a provider's credentials come from. */
export type CredentialSource = 'TRADING_CLIENT' | 'OWN';

/** How the operator logs it in. REDIRECT goes through the browser. */
export type LoginStyle = 'REDIRECT' | 'DIRECT';

export interface DataProvider {
  provider: string;
  enabled: boolean;
  credentialSource: CredentialSource;
  /** Set when it borrows a trading client's credentials. */
  tradingClientId: string | null;
  apiKey: string | null;
  /** The secret itself is never sent back — only whether one is stored. */
  hasApiSecret: boolean;
  clientId: string | null;
  redirectUrl: string | null;
  /** TrueData assigns these per subscription. */
  websocketPort: number | null;
  historyPort: number | null;
  quoteMinIntervalMs: number;
  historyMinIntervalMs: number;
  batchSize: number | null;
  loginStyle: LoginStyle;
  /** False for providers whose market-data keys are separate, or data-only. */
  canBorrowTradingClient: boolean;
  isLoggedIn: boolean;
  unusableBecause: string | null;
  updatedAt: string | null;
  /** False for a provider this engine knows but nobody has set up. */
  isConfigured: boolean;
}

/** Ticker and history are independent choices. */
export interface ActiveProviders {
  ticker: string | null;
  history: string | null;
}

export interface DataProviderEdit {
  enabled?: boolean;
  credentialSource?: CredentialSource;
  tradingClientId?: string | null;
  apiKey?: string | null;
  /** Send to set or change; omit to leave alone; empty string to clear. */
  apiSecret?: string;
  clientId?: string | null;
  redirectUrl?: string | null;
  websocketPort?: number | null;
  historyPort?: number | null;
  quoteMinIntervalMs?: number;
  historyMinIntervalMs?: number;
  batchSize?: number | null;
}

export interface LoginStarted {
  loginStyle: LoginStyle;
  /** Where to send the browser, for a REDIRECT provider. */
  url?: string;
  /** What to register in the vendor's console. */
  callbackPath?: string;
  isLoggedIn?: boolean;
}

/** A trading client a provider could take its credentials from. */
export interface BorrowableClient {
  id: string;
  displayName: string;
  clientId: string;
  broker: string;
}
