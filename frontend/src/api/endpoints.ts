export const API_ENDPOINTS = {

  // User (self)
  USER: {
    BASE: '/api/user',
    DETAILS: '/api/user',
    PASSWORD: '/api/user/password',
    NOTES: '/api/user-notes',
    ALERTS: '/api/user-alerts',
    PAYMENTS: '/api/user-payments',
    PLANS: '/api/user-plans',
  },

  // Brokers (public)
  BROKER: {
    BASE: '/api/brokers',
    LIST: '/api/brokers',
    DETAILS: (id: string) => `/api/brokers/${id}`,
    PASSWORD: '/api/broker/password',
    LOGIN_RULES: '/api/utils/broker/login/rules',
    LOGIN_STATUS: '/api/broker/login/status',
    FUNDS: '/api/broker/funds',
  },


  // Trades
  TRADE: {
    BASE: '/api/trades',
    LIST: '/api/trades',
    ACTIVE: '/api/trades/active',
    HISTORY: '/api/trades/history',
    DETAILS: (id: string) => `/api/trades/${id}`,
    POSITIONS: '/api/positions',
    SQUARE_OFF: '/api/trades/squareoff',
  },


  // Reports
  REPORTS: {
    DAYWISE: '/api/reports/daywise',
    MONTHLY: '/api/reports/monthly',
    STRATEGY_WISE: '/api/reports/strategy',
    USER_WISE: '/api/reports/user',
    EXPORT: '/api/reports/export',
  },

  // Configuration
  CONFIG: {
    SYSTEM: '/api/config',
    PUBLIC: '/api/public/config',
  },

  // Utilities
  UTILS: {
    FAQ: '/api/utils/faq',
    ALLOCATION_MODELS: '/api/allocationmodels',
    REFERRAL_CODE: '/api/public/referralcode/generate',
    BUILD_INFO: '/api/build-info',
  },

  // Local Auth (Standalone mode)
  AUTH: {
    LOGIN: '/api/auth/login',
    CHANGE_PASSWORD: '/api/auth/change-password',
    PROFILE: '/api/auth/profile',
    UPDATE_PROFILE: '/api/auth/profile',  // PUT
    CONFIG: '/api/auth/config',
  },

  // User Auth Management (Standalone mode admin)
  USER_AUTH: {
    BASE: '/api/user-auth',
    LIST: '/api/user-auth',
    DETAILS: (username: string) => `/api/user-auth/${username}`,
    RESET_PASSWORD: (username: string) => `/api/user-auth/${username}/reset-password`,
    TOGGLE_ACTIVE: (username: string) => `/api/user-auth/${username}/toggle-active`,
  },

  // ==================== V2 API ENDPOINTS ====================

  // V2 Users Management
  USERS: {
    BASE: '/api/users',
    LIST: '/api/users',
    DETAILS: (username: string) => `/api/users/${username}`,
    ACTIVATE: (username: string) => `/api/users/${username}/activate`,
    SUSPEND: (username: string) => `/api/users/${username}/suspend`,
    CLOSE: (username: string) => `/api/users/${username}/close`,
    SET_PASSWORD: (username: string) => `/api/users/${username}/set-password`,
  },

  // V2 User Brokers
  USER_BROKERS: {
    LIST_ALL: '/api/user-brokers',
    LIST: (username: string) => `/api/user-brokers/${username}`,
    DETAILS: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}`,
    ENABLE: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/enable`,
    DISABLE: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/disable`,
    ASSIGN_SEAT: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/assign-seat`,
    REMOVE_SEAT: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/remove-seat`,
    ASSIGN_LICENSE: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/assign-license`,
    REMOVE_LICENSE: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/remove-license`,
    LOGIN: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/login`,
    LOGIN_AUTO: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/login/auto`,
    LOGIN_STATUS: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/login/status`,
    LOGOUT: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/logout`,
    AGENT_HEALTH: (username: string, broker: string) => `/api/user-brokers/${username}/${broker}/agent-health`,
  },

  // V2 User Capital
  USER_CAPITAL: {
    BASE: '/api/user-capital-maps',
  },


  // V2 User Bills
  USER_BILLS: {
    BASE: '/api/user-bills',
    BY_USER: (username: string) => `/api/user-bills/${username}`,
    RECONCILE: '/api/user-bills/reconcile',
  },

  // V2 User Broker Login Status
  USER_BROKER_LOGIN_STATUS: {
    BASE: '/api/user-broker-login-status',
  },

  // V2 User Broker Socket (WebSocket connection) Status
  USER_BROKER_SOCKET_STATUS: {
    BASE: '/api/user-broker-socket-status',
  },

  // V2 User Broker Agents (Xtreme Agent Health tab listing)
  USER_BROKER_AGENTS: {
    BASE: '/api/user-broker-agents',
  },

  // V2 User Margins
  USER_MARGINS: {
    BASE: '/api/user-margins',
  },

  // V2 User Alerts (legacy - personal user alerts)
  USER_ALERTS: {
    BASE: '/api/user-alerts',
  },

  // V2 System Alerts (for bell icon and alerts page)
  ALERTS: {
    BASE: '/api/alerts',
    RECENT: '/api/alerts/recent',
    SINCE: '/api/alerts/since',
    FILTERS: '/api/alerts/filters',
    ALL: '/api/alerts/all',
  },

  TRADE_LOG: {
    BASE: '/api/trade-log',
    FILTERS: '/api/trade-log/filters',
    BY_TRADE: (tradeId: string) => `/api/trade-log/trade/${encodeURIComponent(tradeId)}`,
  },

  // V2 Analytics
  ANALYTICS: {
    USERS: '/api/analytics/users',
    USERS_GROWTH: '/api/analytics/users/growth',
    BROKERS: '/api/analytics/brokers',
    STRATEGIES: '/api/analytics/strategies',
    CAPITAL: '/api/analytics/capital',
    CAPITAL_DISTRIBUTION: '/api/analytics/capital/distribution',
    MARGINS: '/api/analytics/margins',
    BILLING: '/api/analytics/billing',
    BILLING_REVENUE: '/api/analytics/billing/revenue',
    TRADES: '/api/analytics/trades',
    TRADES_EOD_SUMMARY: '/api/analytics/trades/eod-summary',
    TRADES_PNL: '/api/analytics/trades/pnl',
    TRADES_BY_STRATEGY: '/api/analytics/trades/by-strategy',
    TRADES_DISTRIBUTION: '/api/analytics/trades/distribution',
    // Strategy Performance Analytics
    STRATEGY_PERFORMANCE: '/api/analytics/strategy-performance',
    STRATEGY_PERFORMANCE_DETAILED: '/api/analytics/strategy-performance/detailed',
    STRATEGY_PERFORMANCE_BY_PRODUCT: '/api/analytics/strategy-performance/by-product',
    STRATEGY_PERFORMANCE_CUMULATIVE: '/api/analytics/strategy-performance/cumulative',
    STRATEGY_PERFORMANCE_MONTHLY: '/api/analytics/strategy-performance/monthly',
    STRATEGY_PERFORMANCE_DAILY: '/api/analytics/strategy-performance/daily',
    // User Performance Analytics
    USER_PERFORMANCE: '/api/analytics/user-performance',
    USER_PERFORMANCE_DETAILED: '/api/analytics/user-performance/detailed',
    USER_PERFORMANCE_CUMULATIVE: '/api/analytics/user-performance/cumulative',
    USER_PERFORMANCE_MONTHLY: '/api/analytics/user-performance/monthly',
    USER_PERFORMANCE_DAILY: '/api/analytics/user-performance/daily',
    USER_PERFORMANCE_STRATEGIES: '/api/analytics/user-performance/strategies',
    BROKER_PERFORMANCE_DETAILED: '/api/analytics/broker-performance/detailed',
    BROKER_PERFORMANCE_DAILY: '/api/analytics/broker-performance/daily',
    BROKER_PERFORMANCE_USERS: '/api/analytics/broker-performance/users',
  },

  // V2 Brokers
  BROKERS: {
    BASE: '/api/brokers',
    LIST: '/api/brokers',
    DETAILS: (name: string) => `/api/brokers/${name}`,
    STOP: (name: string) => `/api/brokers/${name}/stop`,
    UNSTOP: (name: string) => `/api/brokers/${name}/unstop`,
  },

  // V2 Brokerage Plans
  BROKERAGE_PLANS: {
    BASE: '/api/brokerage-plans',
    LIST: '/api/brokerage-plans',
    DETAILS: (name: string) => `/api/brokerage-plans/${name}`,
  },

  // V2 Brokerage Plan Rates
  BROKERAGE_PLAN_RATES: {
    BASE: '/api/brokerage-plan-rates',
    LIST: '/api/brokerage-plan-rates',
    BY_PLAN: (planName: string) => `/api/brokerage-plan-rates/${planName}`,
    DETAILS: (planName: string, segment: string, product: string) =>
      `/api/brokerage-plan-rates/${planName}/${segment}/${product}`,
  },

  // V2 Statutory Charges
  STATUTORY_CHARGES: {
    BASE: '/api/statutory-charges',
    LIST: '/api/statutory-charges',
    DETAILS: (exchange: string, segment: string, product: string) =>
      `/api/statutory-charges/${exchange}/${segment}/${product}`,
    OVERRIDES: '/api/statutory-charges/overrides',
    OVERRIDE_DETAILS: (broker: string, exchange: string, segment: string, product: string) =>
      `/api/statutory-charges/overrides/${broker}/${exchange}/${segment}/${product}`,
  },

  // V2 Broker Exchange Configs
  BROKER_EXCHANGE_CONFIGS: {
    BASE: '/api/broker-exchange-configs',
    LIST: '/api/broker-exchange-configs',
    BY_BROKER: (broker: string) => `/api/broker-exchange-configs/${broker}`,
    DETAILS: (broker: string, exchange: string) => `/api/broker-exchange-configs/${broker}/${exchange}`,
  },

  // V2 Broker Strategy Configs
  BROKER_STRATEGY_CONFIGS: {
    BASE: '/api/broker-strategy-configs',
    DETAILS: (broker: string, strategy: string) => `/api/broker-strategy-configs/${broker}/${strategy}`,
  },

  // V2 Broker API Stats
  BROKER_API_STATS: {
    BASE: '/api/broker-api-stats',
  },

  // V2 Exchanges
  EXCHANGES: {
    BASE: '/api/exchanges',
    LIST: '/api/exchanges',
    MARKET_STATUS: '/api/exchanges/market-status',
    OPTIONS: '/api/exchanges/options',
    DETAILS: (code: string) => `/api/exchanges/${code}`,
  },

  // V2 Holidays
  HOLIDAYS: {
    BASE: '/api/holidays',
    BY_EXCHANGE: (exchange: string) => `/api/holidays/${exchange}`,
    DELETE: (exchange: string, date: string) => `/api/holidays/${exchange}/${date}`,
  },

  // V2 Market Data Sync
  MARKET_DATA_SYNC: {
    STATUS: '/api/market-data-sync/status',
    TRIGGER: '/api/market-data-sync/trigger',
  },

  // V2 Event Days
  EVENT_DAYS: {
    BY_EXCHANGE: (exchange: string) => `/api/event-days/${exchange}`,
    DETAILS: (exchange: string, eventDate: string) => `/api/event-days/${exchange}/${eventDate}`,
  },

  // V2 Special Trading Days
  SPECIAL_TRADING_DAYS: {
    ALL: '/api/special-trading-days',
    BY_EXCHANGE: (exchange: string) => `/api/special-trading-days/${exchange}`,
    DETAILS: (exchange: string, date: string) => `/api/special-trading-days/${exchange}/${date}`,
  },

  // V2 Mock Trading Days (read-only — managed in the market-data admin)
  MOCK_TRADING_DAYS: {
    ALL: '/api/mock-trading-days',
    BY_EXCHANGE: (exchange: string) => `/api/mock-trading-days/${exchange}`,
  },

  // V2 Strategy Event Day Actions
  STRATEGY_EVENT_DAY_ACTIONS: {
    ALL: '/api/strategy-event-day-actions',
    BASE: (strategyName: string) => `/api/strategy-event-day-actions/${strategyName}`,
  },


  // V2 Strategy Days Allocation Configs
  STRATEGY_DAYS_ALLOCATION: {
    BASE: '/api/strategy-days-allocation-configs',
    DETAILS: (strategy: string, allocationModel: string) => `/api/strategy-days-allocation-configs/${strategy}/${allocationModel}`,
  },

  // V2 RMS Config (Hierarchical RMS system)
  RMS_CONFIG: {
    BASE: '/api/rms-config',
    LIST: '/api/rms-config',
    DETAILS: (id: number) => `/api/rms-config/${id}`,
    BY_LEVEL: (level: string) => `/api/rms-config/level/${level}`,
    BY_SEGMENT: (segment: string) => `/api/rms-config/segment/${segment}`,
    BREACHES: '/api/rms-config/breaches',
    BREACHES_TODAY: '/api/rms-config/breaches/today',
    BREACH_FILTERS: '/api/rms-config/breach-filters',
    FIELD_APPLICABILITY: '/api/rms-config/field-applicability',
    USER_STATES: '/api/rms-config/user-states',
    KILL_SWITCH: '/api/rms-config/kill-switch',
    KILL_SWITCH_USER: (username: string, broker: string) => `/api/rms-config/kill-switch/${username}/${broker}`,
    KILL_SWITCH_DEACTIVATE: '/api/rms-config/kill-switch/deactivate',
    KILL_SWITCH_REMOVE: '/api/rms-config/kill-switch/remove',
    KILL_SWITCH_REMOVE_ALL: '/api/rms-config/kill-switch/remove-all',
    KILL_SWITCH_TYPE: '/api/rms-config/kill-switch-type',
    STOP_BROKER: (broker: string) => `/api/rms-config/stop-broker/${broker}`,
    STATUS: '/api/rms-config/status',
    ENABLE: '/api/rms-config/enable',
    DISABLE: '/api/rms-config/disable',
    RESET_DAILY: '/api/rms-config/reset-daily',
    CLEAR_CACHE: '/api/rms-config/clear-cache',
    DAILY_STATS: '/api/rms-config/daily-stats',
    EFFECTIVE: '/api/rms-config/effective',
    EXPORT: '/api/rms-config/transfer/export',
    IMPORT_PREVIEW: '/api/rms-config/transfer/import/preview',
    IMPORT_APPLY: '/api/rms-config/transfer/import/apply',
  },

  // V2 Allocation Models
  ALLOCATION_MODELS: {
    BASE: '/api/allocation-models',
    LIST: '/api/allocation-models',
    DETAILS: (name: string) => `/api/allocation-models/${name}`,
    STRATEGIES: (name: string) => `/api/allocation-models/${name}/strategies`,
    STRATEGY_DETAILS: (name: string, strategy: string) => `/api/allocation-models/${name}/strategies/${strategy}`,
    DELETION_IMPACT: (name: string) => `/api/allocation-models/${name}/deletion-impact`,
    RENAME: (name: string) => `/api/allocation-models/${name}/rename`,
    SYNC_USER_ALLOCATIONS: (name: string) => `/api/allocation-models/${name}/sync-user-allocations`,
  },

  // V2 FAQs
  FAQS: {
    BASE: '/api/faqs',
    LIST: '/api/faqs',
    DETAILS: (sno: number) => `/api/faqs/${sno}`,
    SEARCH: (term: string) => `/api/faqs?search=${encodeURIComponent(term)}`,
  },

  // V2 Billing Plans
  BILLING_PLANS: {
    BASE: '/api/billing-plans',
    LIST: '/api/billing-plans',
    DETAILS: (name: string) => `/api/billing-plans/${name}`,
  },

  // V2 Audit Logs
  AUDIT_LOGS: {
    BASE: '/api/audit-logs',
    LIST: '/api/audit-logs',
    ENTITY_TYPES: '/api/audit-logs/entity-types',
    BY_ENTITY: (type: string, id: string) => `/api/audit-logs/entity/${type}/${id}`,
    BY_USER: (username: string) => `/api/audit-logs/user/${username}`,
  },

  // V2 Trades
  TRADES: {
    BASE: '/api/trades',
    BY_TYPE: (type: string) => `/api/trades/${type}`,
    RECOMPUTE_CHARGES: '/api/trades/recompute-charges',
    RECOMPUTE_CHARGES_STATUS: '/api/trades/recompute-charges/status',
  },

  // V2 Mock Cleanup (Administration → Mock Cleanup). GET (list) + DELETE (clean) on BASE; POST terminalize.
  MOCK_CLEANUP: {
    BASE: '/api/mock-cleanup',
    TERMINALIZE: '/api/mock-cleanup/terminalize',
  },

  // V2 EOD PnL Reports
  EOD_PNL: {
    BASE: '/api/eod-pnl-reports',
    // Distinct (strategyName, product) present in the caller's scoped EOD reports — for the reports
    // strategy filter, unioned with the catalog so disabled/removed strategies remain filterable.
    STRATEGIES: '/api/eod-pnl-reports/strategies',
  },

  // V2 Positional daily-MTM recompute (sysadmin): rebuild the broker-basis positional report over a
  // date range from stored trades + captured closes. Dry-run previews; apply writes. Background job.
  POSITIONAL_MTM: {
    RECOMPUTE: '/api/positional-mtm-recompute',
    RECOMPUTE_STATUS: '/api/positional-mtm-recompute/status',
  },

  // V2 Manual EOD job run (sysadmin): trigger, per exchange, the same post-market EOD sequence the
  // auto worker runs. Gated on the configured post-market time + per-exchange single-flight.
  EOD_JOB_RUN: {
    RUN: '/api/eod-job-run',
    STATUS: '/api/eod-job-run/status',
    EXCHANGES: '/api/eod-job-run/exchanges',
  },

  // V2 Capital Change History
  CAPITAL_HISTORY: {
    BASE: '/api/capital-change-history',
  },

  // V2 Unaccounted PnL
  UNACCOUNTED_PNL: {
    BASE: '/api/unaccounted-pnl',
  },

  // V2 System Status (read-only admin observability dashboard)
  SYSTEM_STATUS: {
    STATUS: '/api/system-status',
    HEALTH_CHECK: '/api/system-status/health-check',
    INIT_TIMELINE: '/api/system-status/init-timeline',
  },

  // V2 Data Retention (Administration → Data Retention). Same path for GET (status poll) + POST (start).
  DATA_RETENTION: {
    LIVE_TRADE_ARCHIVE: '/api/data-retention/live-trade-archive',
  },

  // V2 Cache Management
  CACHE: {
    STATS: '/api/cache/stats',
    CLEAR_ROLES: '/api/cache/roles',
    CLEAR_CORE: '/api/cache/core',
    CLEAR_CORE_BY_NAME: (name: string) => `/api/cache/core/${name}`,
    CLEAR_ALL: '/api/cache/all',
  },

  // V2 License Info
  LICENSE_INFO: '/api/license-info',
  LICENSE_OWNER: '/api/license-info/owner-licenses',
  LICENSE_REQUEST: '/api/license-info/request-licenses',
  LICENSE_CANCEL: '/api/license-info/cancel-licenses',

  // V2 System Config
  SYSTEM_CONFIG: {
    BASE: '/api/system-config',
    LIST: '/api/system-config',
    DETAILS: (key: string) => `/api/system-config/${key}`,
  },

  // V2 Strategy Config Tree (hierarchical configuration)
  STRATEGY_CONFIG_TREE: {
    BASE: '/api/strategy-config-tree',
    LIST: '/api/strategy-config-tree',
    DETAILS: (id: number) => `/api/strategy-config-tree/${id}`,
    BY_STRATEGY: (strategyName: string) => `/api/strategy-config-tree/strategy/${strategyName}`,
    EFFECTIVE: '/api/strategy-config-tree/effective',
    DAY_CONDITIONS: '/api/strategy-config-tree/day-conditions',
    BASE_CONFIGS: '/api/strategy-config-tree/base',
    STRATEGY_NAMES: '/api/strategy-config-tree/strategy-names',
    EXISTS: '/api/strategy-config-tree/exists',
    CATALOG: '/api/strategy-config-tree/catalog',
  },

  // V2 Strategy Policies (reusable configuration policies)
  STRATEGY_POLICIES: {
    BASE: '/api/strategy-policies',
    ALL: '/api/strategy-policies',
    ORDER_FILL: {
      LIST: '/api/strategy-policies/order-fill',
      DETAILS: (id: number) => `/api/strategy-policies/order-fill/${id}`,
    },
    TRAILING_SL: {
      LIST: '/api/strategy-policies/trailing-sl',
      DETAILS: (id: number) => `/api/strategy-policies/trailing-sl/${id}`,
    },
    SL_TARGET: {
      LIST: '/api/strategy-policies/sl-target',
      DETAILS: (id: number) => `/api/strategy-policies/sl-target/${id}`,
    },
    STRIKE: {
      LIST: '/api/strategy-policies/strike',
      DETAILS: (id: number) => `/api/strategy-policies/strike/${id}`,
    },
    EXIT: {
      LIST: '/api/strategy-policies/exit',
      DETAILS: (id: number) => `/api/strategy-policies/exit/${id}`,
    },
  },

  // V2 Symbols
  SYMBOLS: {
    BASE: '/api/symbols',
    LIST: '/api/symbols',
    DETAILS: (symbol: string) => `/api/symbols/${encodeURIComponent(symbol)}`,
    BY_EXCHANGE: (exchange: string) => `/api/symbols?exchange=${encodeURIComponent(exchange)}`,
    BROKERS: (symbol: string) => `/api/symbols/${encodeURIComponent(symbol)}/brokers`,
    BROKER_DETAILS: (symbol: string, broker: string) => `/api/symbols/${encodeURIComponent(symbol)}/brokers/${encodeURIComponent(broker)}`,
  },

  // V2 Symbol Broker Configs (all configs across symbols)
  SYMBOL_BROKER_CONFIGS: {
    BASE: '/api/symbol-broker-configs',
    LIST: '/api/symbol-broker-configs',
    BY_SYMBOL: (symbol: string) => `/api/symbol-broker-configs/${encodeURIComponent(symbol)}`,
    BY_BROKER: (broker: string) => `/api/symbol-broker-configs?broker=${encodeURIComponent(broker)}`,
    DETAILS: (symbol: string, broker: string) => `/api/symbol-broker-configs/${encodeURIComponent(symbol)}/${encodeURIComponent(broker)}`,
  },
  // V2 Strategy Engine (Per-Exchange)
  ENGINE: {
    // Engine Control
    BASE: '/api/engine',
    STATUS: '/api/engine/status',  // All exchanges status
    STATUS_EXCHANGE: (exchange: string) => `/api/engine/status/${exchange}`,
    METRICS: (exchange: string) => `/api/engine/metrics/${exchange}`,
    START: (exchange: string) => `/api/engine/start/${exchange}`,
    STOP: (exchange: string) => `/api/engine/stop/${exchange}`,
    RELOAD: (exchange: string) => `/api/engine/reload/${exchange}`,
    DRYRUN_ENABLE: (exchange: string) => `/api/engine/dryrun/${exchange}/enable`,
    DRYRUN_DISABLE: (exchange: string) => `/api/engine/dryrun/${exchange}/disable`,
    SHUTDOWN_ALL: '/api/engine/shutdown',
  },

  // Mock-trading session toggle (admin-controlled, used for NSE/BSE
  // weekend / holiday mock sessions). Backed by MockSessionServletV2.
  ENGINE_MOCK: {
    STATUS: '/api/engine/mock/status',
    START:  '/api/engine/mock/start',
    STOP:   '/api/engine/mock/stop',
  },

  ENGINE_TEMPLATES: {
    BASE: '/api/engine/templates',
    LIST: '/api/engine/templates',
    ACTIVE: '/api/engine/templates/active',
    DETAILS: (name: string) => `/api/engine/templates/${name}`,
  },

  ENGINE_DEFINITIONS: {
    BASE: '/api/engine/definitions',
    LIST: '/api/engine/definitions',
    ACTIVE: '/api/engine/definitions/active',
    // W4: live template derivation — the form describes intent, the server says which engine runs it.
    RESOLVE_TEMPLATE: '/api/engine/definitions/resolve-template',
    DETAILS: (id: number) => `/api/engine/definitions/${id}`,
    BY_NAME: (name: string) => `/api/engine/definitions/name/${name}`,
    CHANGE_STATUS: (id: number, status: string) => `/api/engine/definitions/${id}/status/${status}`,
    EXPORT: '/api/engine/definitions/transfer/export',
    IMPORT_PREVIEW: '/api/engine/definitions/transfer/import/preview',
    IMPORT_APPLY: '/api/engine/definitions/transfer/import/apply',
  },

  // Minimal SYSTEM-scope strategy catalog for admin-console filter dropdowns (subscriptions, reports,
  // analytics). Management-gated (admin/supervisor), not tied to any one tool permission.
  STRATEGY_CATALOG: {
    BASE: '/api/strategy-catalog',
  },

  ENGINE_SUBSCRIPTIONS: {
    BASE: '/api/engine/subscriptions',
    LIST: '/api/engine/subscriptions',
    ACTIVE: '/api/engine/subscriptions/active',
    DETAILS: (id: number) => `/api/engine/subscriptions/${id}`,
    BY_USER: (username: string) => `/api/engine/subscriptions/user/${username}`,
    BY_STRATEGY: (strategyName: string) => `/api/engine/subscriptions/strategy/${strategyName}`,
    SIGNALS: '/api/engine/subscriptions/signals',
    ACTIVATE: (id: number) => `/api/engine/subscriptions/${id}/activate`,
    DEACTIVATE: (id: number) => `/api/engine/subscriptions/${id}/deactivate`,
  },

  ENGINE_SIGNALS: {
    BASE: '/api/engine/signals',
    LIST: '/api/engine/signals',
    PENDING: '/api/engine/signals/pending',
    RECENT: '/api/engine/signals/recent',
    DETAILS: (id: number) => `/api/engine/signals/${id}`,
    BY_SOURCE: (source: string) => `/api/engine/signals/source/${source}`,
    CANCEL: (id: number) => `/api/engine/signals/${id}/cancel`,
    CLEANUP: '/api/engine/signals/cleanup',
  },

  ENGINE_STATES: {
    BASE: '/api/engine/strategy-states',
    LIST: '/api/engine/strategy-states',
    SUMMARY: '/api/engine/strategy-states/summary',
    DETAILS: (username: string, strategy: string, broker: string) =>
      `/api/engine/strategy-states/${username}/${strategy}/${broker}`,
  },

  ENGINE_BREAKOUT_WATCHES: {
    BASE: '/api/engine/breakout-watches',
    LIST: '/api/engine/breakout-watches',
    SUMMARY: '/api/engine/breakout-watches/summary',
    DETAILS: (id: number) => `/api/engine/breakout-watches/${id}`,
    BY_USER: (username: string) => `/api/engine/breakout-watches?username=${username}`,
    BY_USER_BROKER: (username: string, broker: string) =>
      `/api/engine/breakout-watches?username=${username}&broker=${broker}`,
    BY_STRATEGY: (strategy: string) => `/api/engine/breakout-watches?strategy=${strategy}`,
  },

  // Data providers: who supplies ticks, quotes and candles.
  // Strategies as garuda serves them: definitions, rules, subscriptions. Served.
  STRATEGIES: {
    CATALOG: '/api/engine/catalog',
    DEFINITIONS: '/api/engine/definitions',
    DEFINITION: (id: number) => `/api/engine/definitions/${id}`,
    STATUS: (id: number, status: string) => `/api/engine/definitions/${id}/status/${status}`,
    RULES: (name: string) => `/api/engine/indicator-rules/${encodeURIComponent(name)}`,
    SUBSCRIPTIONS: '/api/engine/subscriptions',
    SUBSCRIPTION: (id: number) => `/api/engine/subscriptions/${id}`,
    ACTIVATE: (id: number) => `/api/engine/subscriptions/${id}/activate`,
    DEACTIVATE: (id: number) => `/api/engine/subscriptions/${id}/deactivate`,
  },

  // The Terminal as garuda serves it: per trading client. Served.
  LIVE_TERMINAL: {
    SUMMARIES: '/api/terminal/summaries',
    ALERTS: '/api/terminal/alerts',
    DETAILS: (id: string) => `/api/terminal/clients/${encodeURIComponent(id)}`,
    BROKER_POSITIONS: (id: string) =>
      `/api/terminal/clients/${encodeURIComponent(id)}/broker-positions`,
    MARGINS: (id: string) => `/api/terminal/clients/${encodeURIComponent(id)}/margins`,
    SQUARE_OFF: (id: string) => `/api/terminal/clients/${encodeURIComponent(id)}/square-off`,
    SQUARE_OFF_TRADE: (id: string, tradeId: string) =>
      `/api/terminal/clients/${encodeURIComponent(id)}/trades/${encodeURIComponent(tradeId)}/square-off`,
  },

  // Trading clients: the accounts orders go to. Served.
  TRADING_CLIENTS: {
    LIST: '/api/trading-clients',
    DETAILS: (id: string) => `/api/trading-clients/${encodeURIComponent(id)}`,
    LOGIN: (id: string) => `/api/trading-clients/${encodeURIComponent(id)}/login`,
    LOGOUT: (id: string) => `/api/trading-clients/${encodeURIComponent(id)}/logout`,
  },

  DATA_PROVIDERS: {
    BASE: '/api/data-providers',
    LIST: '/api/data-providers',
    ACTIVE: '/api/data-providers/active',
    DETAILS: (provider: string) => `/api/data-providers/${provider}`,
    LOGIN: (provider: string) => `/api/data-providers/${provider}/login`,
    LOGOUT: (provider: string) => `/api/data-providers/${provider}/logout`,
    BORROWABLE: (provider: string) => `/api/data-providers/${provider}/borrowable`,
  },

  // Stock universes (equity watchlists). Backed by StockUniverseServletV2.
  ENGINE_UNIVERSES: {
    BASE: '/api/engine/universes',
    LIST: '/api/engine/universes',
    ACTIVE: '/api/engine/universes/active',
    DETAILS: (id: number) => `/api/engine/universes/${id}`,
  },

  ENGINE_SCHEDULES: {
    BASE: '/api/engine/schedules',
    LIST: '/api/engine/schedules',
    DETAILS: (id: number) => `/api/engine/schedules/${id}`,
    BY_STRATEGY: (strategyName: string) => `/api/engine/schedules/strategy/${strategyName}`,
  },

  ENGINE_INDICATOR_RULES: {
    BASE: '/api/engine/indicator-rules',
    LIST: '/api/engine/indicator-rules',
    BY_STRATEGY: (strategyName: string) => `/api/engine/indicator-rules/${strategyName}`,
  },

  ENGINE_INDICATOR_DIRECTION_RULES: {
    BASE: '/api/engine/indicator-direction-rules',
    BY_STRATEGY: (strategyName: string) => `/api/engine/indicator-direction-rules/${strategyName}`,
  },

  // V2 Testing
  TESTING: {
    BASE: '/api/testing',
    SIGNAL: '/api/testing/signal',
    STRATEGIES: '/api/testing/strategies',
    RESET_STRATEGY_STATE: '/api/testing/reset-strategy-state',
    UPDATE_STRATEGY_STATE: '/api/testing/update-strategy-state',
    CLEAR_STRATEGY_STATE: '/api/testing/clear-strategy-state',
    PLACE_ORDER: '/api/testing/place-order',
    MODIFY_ORDER: '/api/testing/modify-order',
    CANCEL_ORDER: '/api/testing/cancel-order',
    TRIGGER_DB_BACKUP: '/api/testing/trigger-db-backup',
    CLEAR_CANDLES_HISTORY: '/api/testing/clear-candles-history',
  },

  // V2 Broker Instruments
  BROKER_INSTRUMENTS: {
    BASE: '/api/broker-instruments',
    LIST: '/api/broker-instruments',
    DETAILS: (broker: string) => `/api/broker-instruments/${broker}`,
    SEARCH: (broker: string) => `/api/broker-instruments/${broker}/search`,
    LOOKUP: (broker: string) => `/api/broker-instruments/${broker}/lookup`,
    EXPIRIES: (broker: string) => `/api/broker-instruments/${broker}/expiries`,
    DOWNLOAD: (broker: string) => `/api/broker-instruments/${broker}/download`,
  },

  // ==================== MARKET DATA ENDPOINTS (Standalone mode) ====================

  MARKET_DATA: {
    // Public APIs
    QUOTES: '/api/market-data/quotes',
    OHLC: '/api/market-data/ohlc',
    HISTORY: '/api/market-data/history',
    STRADDLE_HISTORY: '/api/market-data/history/straddle',
    IV_HISTORY: '/api/market-data/history/iv',
    PCR_HISTORY: '/api/market-data/history/pcr',
    STRADDLE_TICKS: '/api/market-data/sticks',
    IV_TICKS: '/api/market-data/ivticks',
    PCR_TICKS: '/api/market-data/pcrticks',
    SIGNALS: '/api/market-data/signals',
    HEALTH: '/api/market-data/health',
    INDICES: '/api/market-data/indices',
    EXPIRIES: '/api/market-data/expiries',

    // Admin - Signal Config
    ADMIN_RULES: '/api/market-data/admin/rules',
    ADMIN_RULES_DETAILS: (id: number) => `/api/market-data/admin/rules/${id}`,
    ADMIN_STRATEGY_RULES: '/api/market-data/admin/strategy-rules',

    // Admin - Data Management
    ADMIN_EXCHANGES: '/api/market-data/admin/exchanges',
    ADMIN_EXCHANGES_DETAILS: (code: string) => `/api/market-data/admin/exchanges/${code}`,
    ADMIN_SYMBOLS: '/api/market-data/admin/symbols',
    ADMIN_SYMBOLS_DETAILS: (symbol: string) => `/api/market-data/admin/symbols/${symbol}`,
    ADMIN_HOLIDAYS: '/api/market-data/admin/holidays',
    ADMIN_SPECIAL_TRADING_DAYS: '/api/market-data/admin/special-trading-days',

    // Admin - Monitoring
    ADMIN_AUDIT_LOGS: '/api/market-data/admin/audit-logs',
    ADMIN_CONFIG: '/api/market-data/admin/config',
    ADMIN_CONFIG_DETAILS: (property: string) => `/api/market-data/admin/config/${property}`,
    ADMIN_SIGNAL_OUTPUTS: '/api/market-data/admin/signal-outputs',
    ADMIN_WEBSOCKET_SESSIONS: '/api/market-data/admin/websocket-sessions',
    ADMIN_STATUS: '/api/market-data/admin/status',
    ADMIN_INSTRUMENTS: '/api/market-data/admin/instruments',

    // The ticker, and the instrument files. Served.
    TICKER: '/api/market-data/ticker',
    TICKER_START: '/api/market-data/ticker/start',
    TICKER_STOP: '/api/market-data/ticker/stop',
    TICKER_RESTART: '/api/market-data/ticker/restart',
    INSTRUMENTS: '/api/market-data/instruments',
    INSTRUMENT_DOWNLOAD: (name: string) =>
      `/api/market-data/instruments/${encodeURIComponent(name)}/download`,

    // WebSocket
    SOCKET: '/api/market-data/socket',

    // Data Providers
    PROVIDERS_STATUS: '/api/market-data/providers/status',
    PROVIDERS_ZERODHA_LOGIN_URL: '/api/market-data/providers/zerodha/login-url',
    PROVIDERS_XTS_LOGIN: '/api/market-data/providers/xts/login',
  },
  // V2 Email Templates
  EMAIL_TEMPLATES: {
    LIST: '/api/email-templates',
    DETAILS: (key: string) => `/api/email-templates/${encodeURIComponent(key)}`,
    DEFAULTS: (key: string) => `/api/email-templates/${encodeURIComponent(key)}/defaults`,
    RESET: (key: string) => `/api/email-templates/${encodeURIComponent(key)}/reset`,
    ACTION: (key: string, action: string) => `/api/email-templates/${encodeURIComponent(key)}/${action}`,
  },

  // V2 Email Branding
  EMAIL_BRANDING: {
    BASE: '/api/email-branding',
  },

  // V2 Email Preferences
  EMAIL_PREFERENCES: {
    SELF: '/api/me/email-preferences',
    AVAILABLE_CATEGORIES: '/api/email-preferences/available-categories',
    FOR_USER: (username: string) => `/api/email-preferences/${encodeURIComponent(username)}`,
  },
} as const;
