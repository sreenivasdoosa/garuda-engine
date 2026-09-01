import type { HelpArticle } from '@/types/help';

const broker = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const brokerHelpContent: Record<string, HelpArticle> = {
  // ==================== BASIC INFORMATION ====================

  'broker.name': broker({
    fieldKey: 'broker.name',
    title: 'Name',
    category: 'Basic Information',
    description: [
      'Unique identifier for the broker in the system. Used as the primary key in the database and referenced by all user-broker connections, instruments, and order routing.',
      'The name is **immutable** after creation. All user-broker mappings, brokerage plans, and instrument data are linked to this name.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Use the broker\'s standard identifier. Examples: `zerodha`, `fyers`, `iifl`, `dhan`. For multiple accounts with the same provider, use suffixes: `zerodha_primary`, `zerodha_secondary`.',
    },
    warning:
      'Cannot be changed after creation. Deleting a broker removes all associated user-broker connections and instrument data.',
  }),

  'broker.provider': broker({
    fieldKey: 'broker.provider',
    title: 'Provider',
    category: 'Basic Information',
    description: [
      'The underlying technology provider or API platform this broker uses. This determines which **API integration module** the system uses for order placement, data feeds, and authentication.',
      'Brokers using the same provider share the same API integration code. For example, multiple XTS-based brokers use the `xts-*` provider prefix.',
    ],
    example: {
      title: 'Known Providers',
      content:
        '`xts-*` prefix — Uses the XTS (Exchange Trading System) APIs, used by brokers like IIFL and others using the XTS platform. The system selects the appropriate API module based on this field.',
    },
  }),

  'broker.apiVersion': broker({
    fieldKey: 'broker.apiVersion',
    title: 'API Version',
    category: 'Basic Information',
    description: [
      'The API version to use when communicating with this broker. Different versions may support different features, order types, or authentication flows.',
      'Available versions depend on the broker\'s provider. When the API version is changed, the system **clears the OrderManager cache** to ensure the new version\'s API formats are used.',
    ],
    example: {
      title: 'Version Differences',
      content:
        'For XTS providers: **V1** and **V2** are available. V2 may offer additional order types or improved performance. The available versions are auto-populated based on the broker\'s provider.',
    },
    defaultValue: '1',
    warning:
      'Changing the API version while the broker is active may cause in-flight orders to fail. Change during non-trading hours.',
  }),

  'broker.description': broker({
    fieldKey: 'broker.description',
    title: 'Description',
    category: 'Basic Information',
    description: [
      'A free-text display name or description for the broker. Shown in the UI alongside the broker name for easier identification.',
    ],
  }),

  // ==================== SERVER CONFIGURATION ====================

  'broker.serverUrl': broker({
    fieldKey: 'broker.serverUrl',
    title: 'Server URL',
    category: 'Server Configuration',
    description: [
      'The base URL for the broker\'s **trading API** server. All order placement, modification, and cancellation requests are sent to this endpoint.',
      'Can be overridden for testing purposes (e.g., pointing to a sandbox/staging environment).',
    ],
    example: {
      title: 'Examples',
      content:
        'Zerodha Production: `https://api.kite.trade`\nXTS Production: `https://ttblaze.iifl.com`\nSandbox: `https://sandbox.kite.trade` (for testing)',
    },
  }),

  'broker.dataServerUrl': broker({
    fieldKey: 'broker.dataServerUrl',
    title: 'Data Server URL',
    category: 'Server Configuration',
    description: [
      'The base URL for the broker\'s **market data API** server, if it is separate from the trading server. Some brokers have dedicated endpoints for historical data, quotes, and market depth.',
      'When not set, the system uses the main `serverUrl` for both trading and data requests.',
    ],
    defaultValue: 'Empty (uses serverUrl)',
    relatedFields: ['broker.serverUrl'],
  }),

  // ==================== MARKET DATA CREDENTIALS ====================

  'broker.marketDataAppKey': broker({
    fieldKey: 'broker.marketDataAppKey',
    title: 'Market Data App Key',
    category: 'Market Data',
    description: [
      'API key specifically for the **market data** feed, if the broker requires separate credentials for data access vs trading. Some brokers provide separate app credentials for their data APIs.',
    ],
    relatedFields: ['broker.marketDataAppSecret'],
  }),

  'broker.marketDataAppSecret': broker({
    fieldKey: 'broker.marketDataAppSecret',
    title: 'Market Data App Secret',
    category: 'Market Data',
    description: [
      'API secret paired with the Market Data App Key. Used to authenticate market data API requests independently from trading API requests.',
      'This is a sensitive credential — it is stored encrypted and sanitized in non-admin API responses.',
    ],
    relatedFields: ['broker.marketDataAppKey'],
  }),

  'broker.oauthUrl': broker({
    fieldKey: 'broker.oauthUrl',
    title: 'OAuth Login URL',
    category: 'Authentication',
    description: [
      'The broker login-page URL used for **individual-user OAuth login** flows. The user is redirected to `{OAuth Login URL}?client_id={api key}`, logs in on the broker page, and the redirect back to our callback URL carries the auth code which is exchanged for an access token.',
      'For **Noren/Kambala** brokers the code exchange uses `GenAcsTok` with a `SHA-256(api_key + secret_key + code)` checksum. The callback URL `https://{our-host}/api/broker/login/{broker-name}` must be registered with the broker against the api key.',
      'Leave **empty** when the broker has no OAuth login (e.g. dealer-only setups) — users then cannot use the interactive Login button for this broker.',
    ],
    relatedFields: ['broker.serverUrl'],
  }),

  // ==================== EXCHANGE ALGO TAGGING ====================

  'broker.naicCode': broker({
    fieldKey: 'broker.naicCode',
    title: 'NAIC Code',
    category: 'Exchange Algo Tagging',
    description: [
      'Exchange algo-tagging identifier sent on every order (currently consumed by **Noren/Kambala**-based brokers). A **3-digit code**: the first digit is `1` for algo orders (`0` for non-algo), and the last 2 digits are the **vendor code issued by the exchange** (single-digit vendor codes are zero-padded, e.g. vendor code 8 → `08`).',
      'This is the **broker-level global default**. A per-exchange override can be set on the Broker Config page (Broker + Exchange) when the exchange-issued vendor code differs between NSE/BSE/MCX.',
      'When left **empty**, the field is omitted from order payloads entirely — useful before the exchange registration completes (e.g. UAT).',
    ],
    example: {
      title: 'Example',
      content: 'Vendor code `18` issued by the exchange + algo flag `1` → enter `118`.',
    },
    relatedFields: ['broker.algoId'],
  }),

  'broker.algoId': broker({
    fieldKey: 'broker.algoId',
    title: 'Algo ID',
    category: 'Exchange Algo Tagging',
    description: [
      'The **exchange-approved algo ID** for the registered algorithm (SEBI algo framework), sent alongside the NAIC Code on every order (currently consumed by **Noren/Kambala**-based brokers). Obtained through the broker when the algo strategy is registered with the exchange.',
      'This is the **broker-level global default**; a per-exchange override is available on the Broker Config page. When left **empty**, the field is omitted from order payloads entirely.',
    ],
    example: {
      title: 'Example',
      content: 'Exchange approves the algo with id `AA32` → enter `AA32`.',
    },
    relatedFields: ['broker.naicCode'],
  }),

  // ==================== COMMON APP SETTINGS ====================

  'broker.useCommonApp': broker({
    fieldKey: 'broker.useCommonApp',
    title: 'Use Common App',
    category: 'Common App',
    description: [
      'When enabled, **all users** connected to this broker share a single set of API credentials (the common app key and secret) instead of each user providing their own.',
      'This simplifies user onboarding — users only need to provide their broker client ID and login credentials, not individual API keys.',
    ],
    example: {
      title: 'When to Use',
      content:
        'Enable for brokers where you control a single API app and all users trade through it. Disable for brokers where each user has their own registered API app (common with Zerodha Kite Connect).',
    },
    warning:
      'Common app means shared rate limits across ALL users of this broker. If you have many users, individual apps may be better to avoid rate limit collisions.',
    relatedFields: ['broker.commonAppKey', 'broker.commonAppSecret'],
  }),

  'broker.commonAppKey': broker({
    fieldKey: 'broker.commonAppKey',
    title: 'Common App Key',
    category: 'Common App',
    description: [
      'The shared API key used by all users connected to this broker when `Use Common App` is enabled. This key is registered once at the broker\'s developer portal.',
      'Only visible and applicable when `useCommonApp` is checked.',
    ],
    relatedFields: ['broker.useCommonApp', 'broker.commonAppSecret'],
  }),

  'broker.commonAppSecret': broker({
    fieldKey: 'broker.commonAppSecret',
    title: 'Common App Secret',
    category: 'Common App',
    description: [
      'The shared API secret paired with the Common App Key. Used by all users of this broker for authentication when `Use Common App` is enabled.',
      'Stored encrypted and sanitized in non-admin API responses.',
    ],
    relatedFields: ['broker.useCommonApp', 'broker.commonAppKey'],
  }),

  // ==================== FEATURE FLAGS ====================

  'broker.enabled': broker({
    fieldKey: 'broker.enabled',
    title: 'Enabled',
    category: 'Feature Flags',
    description: [
      'Controls whether this broker is **operational** in the system. When disabled, no orders can be placed through this broker and no login attempts are made.',
      'Disabling a broker also removes its instruments instance from memory. Re-enabling creates a fresh instruments instance and reloads instrument data.',
    ],
    warning:
      'Disabling a broker while users have open positions does NOT square off those positions. Manage open positions before disabling.',
    relatedFields: ['broker.autoLogin'],
  }),

  'broker.autoLogin': broker({
    fieldKey: 'broker.autoLogin',
    title: 'Auto Login',
    category: 'Feature Flags',
    description: [
      'Whether this broker supports **automatic session creation** before market open. When enabled at the broker level, individual user-broker connections can opt in to auto-login.',
      'This is a broker-level capability flag. Even if enabled here, each user must also have auto-login enabled and valid credentials configured in their user-broker settings.',
    ],
    relatedFields: ['broker.enabled', 'broker.totpEnabled'],
  }),

  'broker.totpEnabled': broker({
    fieldKey: 'broker.totpEnabled',
    title: 'TOTP Enabled',
    category: 'Feature Flags',
    description: [
      'Indicates that this broker requires **TOTP (Time-based One-Time Password)** for login authentication. When enabled, users must provide their TOTP secret key in their user-broker settings for auto-login to work.',
      'Most Indian brokers now require TOTP as a mandatory second factor for API login.',
    ],
    relatedFields: ['broker.autoLogin'],
  }),

  'broker.webSocketEnabled': broker({
    fieldKey: 'broker.webSocketEnabled',
    title: 'WebSocket',
    category: 'Feature Flags',
    description: [
      'Whether this broker supports **WebSocket** connections for real-time market data streaming. When enabled at the broker level, individual user-broker connections can enable WebSocket for live tick data.',
    ],
    relatedFields: ['broker.enabled'],
  }),

  'broker.orderUpdateIntervalSecs': broker({
    fieldKey: 'broker.orderUpdateIntervalSecs',
    title: 'Order Update Interval (secs)',
    category: 'Server Configuration',
    description: [
      'How often (in seconds) the backend polls this broker\'s **order book** over REST. The configured value is used **as-is regardless of WebSocket state** — connected, disconnected, streaming or not — so the polling cadence is entirely your decision.',
      'WebSocket order updates (where the broker provides them) still apply **instantly** in parallel; this poll is the unconditional catch-all that reconciles anything a socket dropped or never pushed.',
      'Set **0** to use the global default (`orderbook.cache.interval.secs`, 30s). A 5-second minimum-fetch throttle always applies underneath, and forced refreshes (square-off pre-checks, exit-rejection refresh) bypass this interval.',
    ],
    defaultValue: '30',
    relatedFields: ['broker.positionUpdateIntervalSecs', 'broker.webSocketEnabled'],
  }),

  'broker.positionUpdateIntervalSecs': broker({
    fieldKey: 'broker.positionUpdateIntervalSecs',
    title: 'Position Update Interval (secs)',
    category: 'Server Configuration',
    description: [
      'How often (in seconds) the backend polls this broker\'s **positions** over REST. The configured value is used **as-is regardless of WebSocket state** — the polling cadence is entirely your decision.',
      'Some broker sockets never push position updates at all (**Dhan**\'s stream carries order events only), so for those brokers this poll is the *only* source of broker-position freshness — keep it reasonably tight.',
      'Set **0** to use the global default (`position.update.interval.secs`, 60s). The 5-second minimum-fetch throttle and the event-driven forced refreshes (entry fill, exit RMS rejection) operate independently of this interval.',
    ],
    defaultValue: '60',
    relatedFields: ['broker.orderUpdateIntervalSecs', 'broker.webSocketEnabled'],
  }),

  'broker.useDealerAPIs': broker({
    fieldKey: 'broker.useDealerAPIs',
    title: 'Use Dealer APIs',
    category: 'Feature Flags',
    description: [
      'When enabled, the system uses **dealer-level APIs** for order placement instead of standard client APIs. Dealer APIs are typically available to institutional clients and offer features like placing orders on behalf of clients.',
    ],
    defaultValue: 'false',
  }),

  'broker.isBOCOBlocked': broker({
    fieldKey: 'broker.isBOCOBlocked',
    title: 'BOCO Blocked',
    category: 'Feature Flags',
    description: [
      'When enabled, **Bracket Orders (BO)** and **Cover Orders (CO)** are blocked for this broker. These are special order types that include built-in stop-loss and/or target levels.',
      'Some brokers temporarily or permanently disable BO/CO during volatile market conditions or for specific segments.',
    ],
    example: {
      title: 'When This Applies',
      content:
        'During highly volatile sessions (e.g., budget day, election results), exchanges or brokers may block BO/CO orders. Enable this flag to prevent the system from attempting these order types.',
    },
    defaultValue: 'false',
  }),

  'broker.mtfInterestRatePerAnnum': broker({
    fieldKey: 'broker.mtfInterestRatePerAnnum',
    title: 'MTF Interest Rate (% per annum)',
    category: 'Broker Configuration',
    description: [
      'The **funding interest rate** this broker charges on **MTF (Margin Trading Facility)** carry positions, as a percent per annum (e.g. `12` = 12%/year).',
      'Interest accrues daily on the **funded value** — the portion of the position the broker finances: `fundedValue = positionValue × (1 − 1/leverage)`; `dailyInterest = fundedValue × rate/100/365`. It is tracked as a **separate figure** (`mtfInterest`) on trades and EOD reports, never folded into charges or net P&L.',
      'Set to `0` when the broker does not offer MTF or you do not want interest tracked.',
    ],
    example: {
      title: 'Example',
      content: '₹1,00,000 MTF position at 4× leverage, 18%/yr: funded value = ₹75,000, daily interest ≈ ₹36.99. Held 30 days ≈ ₹1,109.',
    },
    defaultValue: '0',
  }),
};
