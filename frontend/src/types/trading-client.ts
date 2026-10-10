/**
 * Trading clients: the broker accounts orders are routed to.
 *
 * One operator owns every account here, so a trading client is the account
 * itself: a display name, a broker, the broker's own id for it, and what
 * logging in to it needs. Every login starts with the operator pressing a
 * button; nothing here stores a password.
 */

export type BrokerCode = 'ZERODHA' | 'FYERS' | 'DHAN' | 'KOTAK';

export interface TradingClient {
  /** Fixed at creation from the display name; what every trade carries. */
  id: string;
  displayName: string;
  broker: BrokerCode | string;
  clientId: string;
  enabled: boolean;
  apiKey: string | null;
  /** The secret itself is never sent back — only whether one is stored. */
  hasApiSecret: boolean;
  /** Path the vendor sends the browser back to; prefix with this origin. */
  callbackPath: string;
  /** The source address the broker whitelisted for this account's trading APIs. */
  staticIp: string | null;
  isPro: boolean;
  /** null inherits the broker's own setting. */
  useDealerApis: boolean | null;
  websocketEnabled: boolean;
  /** Another account whose broker session this one rides on. */
  usesCredentialsOf: string | null;
  /** Whose session the tick feed and quotes use, when no provider is nominated. */
  isMarketDataSource: boolean;
  loginStyle: 'REDIRECT' | 'UNSUPPORTED';
  canLogin: boolean;
  isLoggedIn: boolean;
  loginError: string | null;
  passwordExpiryDays: number | null;
  sessionCreatedOn: string | null;
  lastLoginAttemptAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface TradingClientEdit {
  displayName?: string;
  broker?: string;
  clientId?: string;
  enabled?: boolean;
  apiKey?: string | null;
  /** Send to set or change; omit to leave alone; empty string to clear. */
  apiSecret?: string;
  staticIp?: string | null;
  isPro?: boolean;
  useDealerApis?: boolean | null;
  websocketEnabled?: boolean;
  usesCredentialsOf?: string | null;
  isMarketDataSource?: boolean;
}

export interface TradingClientLoginStarted {
  loginStyle: 'REDIRECT';
  url: string;
  callbackPath: string;
}
