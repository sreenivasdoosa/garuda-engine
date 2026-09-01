/**
 * Broker types matching V2 API (BrokerDetails from server)
 */

/**
 * Broker entity from V2 API
 */
export interface Broker {
  name: string;
  displayName?: string;
  enabled: boolean;
  stopped: boolean;
  autoLogin: boolean;
  description?: string;
  provider?: string;
  useDealerAPIs: boolean;
  isBOCOBlocked: boolean;
  useCommonApp: boolean;
  commonAppKey?: string;
  commonAppSecret?: string;
  marketDataAppKey?: string;
  marketDataAppSecret?: string;
  serverUrl?: string;
  dataServerUrl?: string;
  xtremeAgentDestUrl?: string;
  totpEnabled: boolean;
  webSocketEnabled: boolean;
  apiVersion: number;
  availableApiVersions?: number[]; // Computed by server based on provider
  serverStartTime?: string; // HH:mm format, e.g. "08:00"
  serverStopTime?: string | null;  // HH:mm format, e.g. "16:00", null = 24x7
  // REST poll cadence (seconds) for the order-book / positions caches.
  // Used as-is regardless of WebSocket state — the cadence decision is the
  // admin's. > 0 = absolute interval for this broker (defaults 30 / 60);
  // 0 = the global defaults (orderbook.cache.interval.secs = 30 /
  // position.update.interval.secs = 60).
  orderUpdateIntervalSecs?: number;
  positionUpdateIntervalSecs?: number;
  // Exchange algo-tagging (global defaults; BrokerExchangeConfig overrides per exchange)
  naicCode?: string | null; // 3 digits: '1'(algo)/'0' + 2-digit exchange vendor code, e.g. "118"
  algoId?: string | null;   // exchange-approved algo id, e.g. "AA32"
  oauthUrl?: string | null; // OAuth login-page URL (individual-user OAuth login flows)
  hostLookupVersion?: string | null;  // XTS host-lookup version (provider=xts-hostlookup only)
  hostLookupPassword?: string | null; // XTS host-lookup access password (provider=xts-hostlookup only)
  hostLookupPath?: string | null;     // XTS host-lookup request path, e.g. /hostlookup (provider=xts-hostlookup only)
  ioSocketVersion?: string;            // socket.io client version for XTS sockets: "1.0.2" (default) or "2.x"
  // MTF funding-interest rate this broker charges, % per annum (e.g. 12 → 12%/yr).
  // 0 = no MTF interest tracked. Drives the separate mtfInterest figure on trades/EOD reports.
  mtfInterestRatePerAnnum?: number;
}

/**
 * Request to create a new broker
 */
export interface CreateBrokerRequest {
  name: string;
  enabled?: boolean;
  stopped?: boolean;
  autoLogin?: boolean;
  description?: string;
  provider?: string;
  useDealerAPIs?: boolean;
  isBOCOBlocked?: boolean;
  useCommonApp?: boolean;
  commonAppKey?: string;
  commonAppSecret?: string;
  marketDataAppKey?: string;
  marketDataAppSecret?: string;
  serverUrl?: string;
  dataServerUrl?: string;
  xtremeAgentDestUrl?: string;
  totpEnabled?: boolean;
  webSocketEnabled?: boolean;
  apiVersion?: number;
  serverStartTime?: string;
  serverStopTime?: string | null;
  orderUpdateIntervalSecs?: number;
  positionUpdateIntervalSecs?: number;
  naicCode?: string | null;
  algoId?: string | null;
  oauthUrl?: string | null;
  hostLookupVersion?: string | null;
  hostLookupPassword?: string | null;
  hostLookupPath?: string | null;
  ioSocketVersion?: string;
  mtfInterestRatePerAnnum?: number;
}

/**
 * Request to update an existing broker
 */
export interface UpdateBrokerRequest extends Partial<CreateBrokerRequest> {}

/**
 * Broker login rules - used for broker-specific login forms
 */
export interface BrokerLoginRules {
  broker: string;
  requiredFields: BrokerField[];
  optionalFields: BrokerField[];
  instructions: string[];
  loginUrl?: string;
}

export interface BrokerField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'email' | 'number';
  placeholder?: string;
  required: boolean;
  validation?: {
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

/**
 * Broker credentials for login
 */
export interface BrokerCredentials {
  broker: string;
  clientId: string;
  password?: string;
  apiKey?: string;
  apiSecret?: string;
  totp?: string;
  additionalFields?: Record<string, string>;
}

/**
 * Broker login status - matches backend UserBrokerLoginStatusDetails
 */
export interface BrokerLoginStatus {
  username: string;
  broker: string;
  clientID: string;
  isLoginSuccess: boolean;
  useApiOf?: string | null; // non-null = shares another account's session (does not log in on its own)
  passwordExpiryDays?: number;
  loginErrorMessage?: string;
  updatedOn?: number; // timestamp
  // Session data fields
  accessToken?: string;
  publicToken?: string;
  requestToken?: string;
  serverUrl?: string;
  sessionCreatedOn?: number; // timestamp
  agentUrl?: string;
}

/**
 * Broker funds information
 */
export interface BrokerFunds {
  broker: string;
  clientId: string;
  availableMargin: number;
  usedMargin: number;
  totalBalance: number;
  currency: string;
  lastUpdated: string;
}

/**
 * Snapshot of every table currently referencing a broker. Returned by
 * GET /api/v2/brokers/{name}/usage and embedded inside the 409 Conflict
 * body of DELETE /api/v2/brokers/{name} when blockers are present.
 *
 * - blockers   : tables with FK to BROKERS — non-zero values block delete
 * - historical : tables with no FK — non-zero values produce orphan rows
 */
export interface BrokerUsage {
  broker: string;
  blockers: Record<string, number>;
  historical: Record<string, number>;
  sampleUsers?: string[];
}
