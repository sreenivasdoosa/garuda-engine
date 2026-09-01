export const API_ENDPOINTS = {
  // Authentication (SSO via auth service)
  AUTH: {
    CONFIG: '/api/v2/auth/config',
    TOKEN: '/api/v2/auth/token',
    REFRESH: '/api/v2/auth/refresh',
    USERINFO: '/api/v2/auth/userinfo',
  },

  // User (self)
  USER: {
    BASE: '/apis/user',
    DETAILS: '/apis/user',
    PASSWORD: '/apis/user/password',
    NOTES: '/api/v2/user-notes',
    ALERTS: '/api/v2/user-alerts',
    PAYMENTS: '/api/v2/user-payments',
    PLANS: '/api/v2/user-plans',
  },

  // Brokers (public)
  BROKER: {
    BASE: '/apis/brokers',
    LIST: '/apis/brokers',
    DETAILS: (id: string) => `/apis/brokers/${id}`,
    PASSWORD: '/apis/broker/password',
    LOGIN_RULES: '/apis/utils/broker/login/rules',
    LOGIN_STATUS: '/apis/broker/login/status',
    FUNDS: '/apis/broker/funds',
  },

  // Strategies (public)
  STRATEGY: {
    BASE: '/apis/strategies',
    LIST: '/apis/strategies',
    DETAILS: (id: string) => `/apis/strategies/${id}`,
  },

  // Trades
  TRADE: {
    BASE: '/apis/trades',
    LIST: '/apis/trades',
    ACTIVE: '/apis/trades/active',
    HISTORY: '/apis/trades/history',
    DETAILS: (id: string) => `/apis/trades/${id}`,
    POSITIONS: '/apis/positions',
    SQUARE_OFF: '/apis/trades/squareoff',
  },

  // Plans & Billing
  BILLING: {
    BILLS: '/apis/bills',
    BILL_DETAILS: (id: string) => `/apis/bills/${id}`,
    PAYMENTS: '/apis/payments',
    PLANS: '/apis/plans',
    BROKERAGE_PLANS: '/apis/brokerage/plans',
    BILLING_PLANS: '/apis/billing/plans',
  },

  // Reports
  REPORTS: {
    DAYWISE: '/apis/reports/daywise',
    MONTHLY: '/apis/reports/monthly',
    STRATEGY_WISE: '/apis/reports/strategy',
    USER_WISE: '/apis/reports/user',
    EXPORT: '/apis/reports/export',
  },

  // Configuration
  CONFIG: {
    SYSTEM: '/apis/config',
    PUBLIC: '/api/v2/public/config',
  },

  // Utilities
  UTILS: {
    FAQ: '/apis/utils/faq',
    ALLOCATION_MODELS: '/apis/allocationmodels',
    REFERRAL_CODE: '/apis/public/referralcode/generate',
    BUILD_INFO: '/api/v2/build-info',
  },

  // Local Auth (Standalone mode)
  LOCAL_AUTH: {
    LOGIN: '/api/v2/auth/local/login',
    CHANGE_PASSWORD: '/api/v2/auth/local/change-password',
    PROFILE: '/api/v2/auth/local/profile',
    UPDATE_PROFILE: '/api/v2/auth/local/profile',  // PUT
    CONFIG: '/api/v2/auth/local/config',
  },

  // User Auth Management (Standalone mode admin)
  V2_USER_AUTH: {
    BASE: '/api/v2/user-auth',
    LIST: '/api/v2/user-auth',
    DETAILS: (username: string) => `/api/v2/user-auth/${username}`,
    RESET_PASSWORD: (username: string) => `/api/v2/user-auth/${username}/reset-password`,
    TOGGLE_ACTIVE: (username: string) => `/api/v2/user-auth/${username}/toggle-active`,
  },

  // ==================== V2 API ENDPOINTS ====================

  // V2 Users Management
  V2_USERS: {
    BASE: '/api/v2/users',
    LIST: '/api/v2/users',
    DETAILS: (username: string) => `/api/v2/users/${username}`,
    ACTIVATE: (username: string) => `/api/v2/users/${username}/activate`,
    SUSPEND: (username: string) => `/api/v2/users/${username}/suspend`,
    CLOSE: (username: string) => `/api/v2/users/${username}/close`,
    SET_PASSWORD: (username: string) => `/api/v2/users/${username}/set-password`,
  },

  // V2 User Brokers
  V2_USER_BROKERS: {
    LIST_ALL: '/api/v2/user-brokers',
    LIST: (username: string) => `/api/v2/user-brokers/${username}`,
    DETAILS: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}`,
    ENABLE: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/enable`,
    DISABLE: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/disable`,
    ASSIGN_SEAT: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/assign-seat`,
    REMOVE_SEAT: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/remove-seat`,
    ASSIGN_LICENSE: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/assign-license`,
    REMOVE_LICENSE: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/remove-license`,
    LOGIN: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/login`,
    LOGIN_AUTO: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/login/auto`,
    LOGIN_STATUS: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/login/status`,
    LOGOUT: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/logout`,
    AGENT_HEALTH: (username: string, broker: string) => `/api/v2/user-brokers/${username}/${broker}/agent-health`,
  },

  // V2 User Capital
  V2_USER_CAPITAL: {
    BASE: '/api/v2/user-capital-maps',
  },

  // V2 User Event Day Actions
  V2_USER_EVENT_DAY_ACTIONS: {
    ALL: '/api/v2/user-event-day-actions',
    BASE: (username: string) => `/api/v2/user-event-day-actions/${username}`,
  },

  // V2 User Bills
  V2_USER_BILLS: {
    BASE: '/api/v2/user-bills',
    BY_USER: (username: string) => `/api/v2/user-bills/${username}`,
    RECONCILE: '/api/v2/user-bills/reconcile',
  },

  // V2 User Broker Login Status
  V2_USER_BROKER_LOGIN_STATUS: {
    BASE: '/api/v2/user-broker-login-status',
  },

  // V2 User Broker Socket (WebSocket connection) Status
  V2_USER_BROKER_SOCKET_STATUS: {
    BASE: '/api/v2/user-broker-socket-status',
  },

  // V2 User Broker Agents (Xtreme Agent Health tab listing)
  V2_USER_BROKER_AGENTS: {
    BASE: '/api/v2/user-broker-agents',
  },

  // V2 User Margins
  V2_USER_MARGINS: {
    BASE: '/api/v2/user-margins',
  },

  // V2 User Alerts (legacy - personal user alerts)
  V2_USER_ALERTS: {
    BASE: '/api/v2/user-alerts',
  },

  // V2 System Alerts (for bell icon and alerts page)
  V2_ALERTS: {
    BASE: '/api/v2/alerts',
    RECENT: '/api/v2/alerts/recent',
    SINCE: '/api/v2/alerts/since',
    FILTERS: '/api/v2/alerts/filters',
    ALL: '/api/v2/alerts/all',
  },

  V2_TRADE_LOG: {
    BASE: '/api/v2/trade-log',
    FILTERS: '/api/v2/trade-log/filters',
    BY_TRADE: (tradeId: string) => `/api/v2/trade-log/trade/${encodeURIComponent(tradeId)}`,
  },

  // V2 Analytics
  V2_ANALYTICS: {
    USERS: '/api/v2/analytics/users',
    USERS_GROWTH: '/api/v2/analytics/users/growth',
    BROKERS: '/api/v2/analytics/brokers',
    STRATEGIES: '/api/v2/analytics/strategies',
    CAPITAL: '/api/v2/analytics/capital',
    CAPITAL_DISTRIBUTION: '/api/v2/analytics/capital/distribution',
    MARGINS: '/api/v2/analytics/margins',
    BILLING: '/api/v2/analytics/billing',
    BILLING_REVENUE: '/api/v2/analytics/billing/revenue',
    TRADES: '/api/v2/analytics/trades',
    TRADES_EOD_SUMMARY: '/api/v2/analytics/trades/eod-summary',
    TRADES_PNL: '/api/v2/analytics/trades/pnl',
    TRADES_BY_STRATEGY: '/api/v2/analytics/trades/by-strategy',
    TRADES_DISTRIBUTION: '/api/v2/analytics/trades/distribution',
    // Strategy Performance Analytics
    STRATEGY_PERFORMANCE: '/api/v2/analytics/strategy-performance',
    STRATEGY_PERFORMANCE_DETAILED: '/api/v2/analytics/strategy-performance/detailed',
    STRATEGY_PERFORMANCE_BY_PRODUCT: '/api/v2/analytics/strategy-performance/by-product',
    STRATEGY_PERFORMANCE_CUMULATIVE: '/api/v2/analytics/strategy-performance/cumulative',
    STRATEGY_PERFORMANCE_MONTHLY: '/api/v2/analytics/strategy-performance/monthly',
    STRATEGY_PERFORMANCE_DAILY: '/api/v2/analytics/strategy-performance/daily',
    // User Performance Analytics
    USER_PERFORMANCE: '/api/v2/analytics/user-performance',
    USER_PERFORMANCE_DETAILED: '/api/v2/analytics/user-performance/detailed',
    USER_PERFORMANCE_CUMULATIVE: '/api/v2/analytics/user-performance/cumulative',
    USER_PERFORMANCE_MONTHLY: '/api/v2/analytics/user-performance/monthly',
    USER_PERFORMANCE_DAILY: '/api/v2/analytics/user-performance/daily',
    USER_PERFORMANCE_STRATEGIES: '/api/v2/analytics/user-performance/strategies',
    BROKER_PERFORMANCE_DETAILED: '/api/v2/analytics/broker-performance/detailed',
    BROKER_PERFORMANCE_DAILY: '/api/v2/analytics/broker-performance/daily',
    BROKER_PERFORMANCE_USERS: '/api/v2/analytics/broker-performance/users',
  },

  // V2 Brokers
  V2_BROKERS: {
    BASE: '/api/v2/brokers',
    LIST: '/api/v2/brokers',
    DETAILS: (name: string) => `/api/v2/brokers/${name}`,
    STOP: (name: string) => `/api/v2/brokers/${name}/stop`,
    UNSTOP: (name: string) => `/api/v2/brokers/${name}/unstop`,
  },

  // V2 Brokerage Plans
  V2_BROKERAGE_PLANS: {
    BASE: '/api/v2/brokerage-plans',
    LIST: '/api/v2/brokerage-plans',
    DETAILS: (name: string) => `/api/v2/brokerage-plans/${name}`,
  },

  // V2 Brokerage Plan Rates
  V2_BROKERAGE_PLAN_RATES: {
    BASE: '/api/v2/brokerage-plan-rates',
    LIST: '/api/v2/brokerage-plan-rates',
    BY_PLAN: (planName: string) => `/api/v2/brokerage-plan-rates/${planName}`,
    DETAILS: (planName: string, segment: string, product: string) =>
      `/api/v2/brokerage-plan-rates/${planName}/${segment}/${product}`,
  },

  // V2 Statutory Charges
  V2_STATUTORY_CHARGES: {
    BASE: '/api/v2/statutory-charges',
    LIST: '/api/v2/statutory-charges',
    DETAILS: (exchange: string, segment: string, product: string) =>
      `/api/v2/statutory-charges/${exchange}/${segment}/${product}`,
    OVERRIDES: '/api/v2/statutory-charges/overrides',
    OVERRIDE_DETAILS: (broker: string, exchange: string, segment: string, product: string) =>
      `/api/v2/statutory-charges/overrides/${broker}/${exchange}/${segment}/${product}`,
  },

  // V2 AI analytics assistant
  V2_AI: {
    ANALYZE: '/api/v2/ai/analyze',
    RESULT: (requestId: number) => `/api/v2/ai/result/${requestId}`,
    USAGE: '/api/v2/ai/usage',
  },

  // V2 Broker Exchange Configs
  V2_BROKER_EXCHANGE_CONFIGS: {
    BASE: '/api/v2/broker-exchange-configs',
    LIST: '/api/v2/broker-exchange-configs',
    BY_BROKER: (broker: string) => `/api/v2/broker-exchange-configs/${broker}`,
    DETAILS: (broker: string, exchange: string) => `/api/v2/broker-exchange-configs/${broker}/${exchange}`,
  },

  // V2 Broker Strategy Configs
  V2_BROKER_STRATEGY_CONFIGS: {
    BASE: '/api/v2/broker-strategy-configs',
    DETAILS: (broker: string, strategy: string) => `/api/v2/broker-strategy-configs/${broker}/${strategy}`,
  },

  // V2 Broker API Stats
  V2_BROKER_API_STATS: {
    BASE: '/api/v2/broker-api-stats',
  },

  // V2 Exchanges
  V2_EXCHANGES: {
    BASE: '/api/v2/exchanges',
    LIST: '/api/v2/exchanges',
    MARKET_STATUS: '/api/v2/exchanges/market-status',
    DETAILS: (code: string) => `/api/v2/exchanges/${code}`,
    HOLIDAYS: (code: string) => `/api/v2/exchanges/${code}/holidays`,
    EVENT_DAYS: (code: string) => `/api/v2/exchanges/${code}/event-days`,
  },

  // V2 Holidays
  V2_HOLIDAYS: {
    BASE: '/api/v2/holidays',
    BY_EXCHANGE: (exchange: string) => `/api/v2/holidays/${exchange}`,
    DELETE: (exchange: string, date: string) => `/api/v2/holidays/${exchange}/${date}`,
  },

  // V2 Market Data Sync
  V2_MARKET_DATA_SYNC: {
    STATUS: '/api/v2/market-data-sync/status',
    TRIGGER: '/api/v2/market-data-sync/trigger',
  },

  // V2 Event Days
  V2_EVENT_DAYS: {
    BY_EXCHANGE: (exchange: string) => `/api/v2/event-days/${exchange}`,
    DETAILS: (exchange: string, eventDate: string) => `/api/v2/event-days/${exchange}/${eventDate}`,
  },

  // V2 Special Trading Days
  V2_SPECIAL_TRADING_DAYS: {
    ALL: '/api/v2/special-trading-days',
    BY_EXCHANGE: (exchange: string) => `/api/v2/special-trading-days/${exchange}`,
    DETAILS: (exchange: string, date: string) => `/api/v2/special-trading-days/${exchange}/${date}`,
  },

  // V2 Mock Trading Days (read-only — managed in the market-data admin)
  V2_MOCK_TRADING_DAYS: {
    ALL: '/api/v2/mock-trading-days',
    BY_EXCHANGE: (exchange: string) => `/api/v2/mock-trading-days/${exchange}`,
  },

  // V2 Strategy Event Day Actions
  V2_STRATEGY_EVENT_DAY_ACTIONS: {
    ALL: '/api/v2/strategy-event-day-actions',
    BASE: (strategyName: string) => `/api/v2/strategy-event-day-actions/${strategyName}`,
  },

  // V2 Product Event Day Actions
  V2_PRODUCT_EVENT_DAY_ACTIONS: {
    ALL: '/api/v2/product-event-day-actions',
    BASE: (product: string) => `/api/v2/product-event-day-actions/${product}`,
  },

  // V2 Strategy Days Allocation Configs
  V2_STRATEGY_DAYS_ALLOCATION: {
    BASE: '/api/v2/strategy-days-allocation-configs',
    DETAILS: (strategy: string, allocationModel: string) => `/api/v2/strategy-days-allocation-configs/${strategy}/${allocationModel}`,
  },

  // V2 RMS Config (Hierarchical RMS system)
  V2_RMS_CONFIG: {
    BASE: '/api/v2/rms-config',
    LIST: '/api/v2/rms-config',
    DETAILS: (id: number) => `/api/v2/rms-config/${id}`,
    BY_LEVEL: (level: string) => `/api/v2/rms-config/level/${level}`,
    BY_SEGMENT: (segment: string) => `/api/v2/rms-config/segment/${segment}`,
    BREACHES: '/api/v2/rms-config/breaches',
    BREACHES_TODAY: '/api/v2/rms-config/breaches/today',
    BREACH_FILTERS: '/api/v2/rms-config/breach-filters',
    FIELD_APPLICABILITY: '/api/v2/rms-config/field-applicability',
    USER_STATES: '/api/v2/rms-config/user-states',
    KILL_SWITCH: '/api/v2/rms-config/kill-switch',
    KILL_SWITCH_USER: (username: string, broker: string) => `/api/v2/rms-config/kill-switch/${username}/${broker}`,
    KILL_SWITCH_DEACTIVATE: '/api/v2/rms-config/kill-switch/deactivate',
    KILL_SWITCH_REMOVE: '/api/v2/rms-config/kill-switch/remove',
    KILL_SWITCH_REMOVE_ALL: '/api/v2/rms-config/kill-switch/remove-all',
    KILL_SWITCH_TYPE: '/api/v2/rms-config/kill-switch-type',
    STOP_BROKER: (broker: string) => `/api/v2/rms-config/stop-broker/${broker}`,
    STATUS: '/api/v2/rms-config/status',
    ENABLE: '/api/v2/rms-config/enable',
    DISABLE: '/api/v2/rms-config/disable',
    RESET_DAILY: '/api/v2/rms-config/reset-daily',
    CLEAR_CACHE: '/api/v2/rms-config/clear-cache',
    DAILY_STATS: '/api/v2/rms-config/daily-stats',
    EFFECTIVE: '/api/v2/rms-config/effective',
    EXPORT: '/api/v2/rms-config/transfer/export',
    IMPORT_PREVIEW: '/api/v2/rms-config/transfer/import/preview',
    IMPORT_APPLY: '/api/v2/rms-config/transfer/import/apply',
  },

  // V2 Allocation Models
  V2_ALLOCATION_MODELS: {
    BASE: '/api/v2/allocation-models',
    LIST: '/api/v2/allocation-models',
    DETAILS: (name: string) => `/api/v2/allocation-models/${name}`,
    STRATEGIES: (name: string) => `/api/v2/allocation-models/${name}/strategies`,
    STRATEGY_DETAILS: (name: string, strategy: string) => `/api/v2/allocation-models/${name}/strategies/${strategy}`,
    DELETION_IMPACT: (name: string) => `/api/v2/allocation-models/${name}/deletion-impact`,
    RENAME: (name: string) => `/api/v2/allocation-models/${name}/rename`,
    SYNC_USER_ALLOCATIONS: (name: string) => `/api/v2/allocation-models/${name}/sync-user-allocations`,
  },

  // V2 FAQs
  V2_FAQS: {
    BASE: '/api/v2/faqs',
    LIST: '/api/v2/faqs',
    DETAILS: (sno: number) => `/api/v2/faqs/${sno}`,
    SEARCH: (term: string) => `/api/v2/faqs?search=${encodeURIComponent(term)}`,
  },

  // V2 Billing Plans
  V2_BILLING_PLANS: {
    BASE: '/api/v2/billing-plans',
    LIST: '/api/v2/billing-plans',
    DETAILS: (name: string) => `/api/v2/billing-plans/${name}`,
  },

  // V2 Audit Logs
  V2_AUDIT_LOGS: {
    BASE: '/api/v2/audit-logs',
    LIST: '/api/v2/audit-logs',
    ENTITY_TYPES: '/api/v2/audit-logs/entity-types',
    BY_ENTITY: (type: string, id: string) => `/api/v2/audit-logs/entity/${type}/${id}`,
    BY_USER: (username: string) => `/api/v2/audit-logs/user/${username}`,
  },

  // V2 Trades
  V2_TRADES: {
    BASE: '/api/v2/trades',
    BY_TYPE: (type: string) => `/api/v2/trades/${type}`,
    RECOMPUTE_CHARGES: '/api/v2/trades/recompute-charges',
    RECOMPUTE_CHARGES_STATUS: '/api/v2/trades/recompute-charges/status',
  },

  // V2 Mock Cleanup (Administration → Mock Cleanup). GET (list) + DELETE (clean) on BASE; POST terminalize.
  V2_MOCK_CLEANUP: {
    BASE: '/api/v2/mock-cleanup',
    TERMINALIZE: '/api/v2/mock-cleanup/terminalize',
  },

  // V2 EOD PnL Reports
  V2_EOD_PNL: {
    BASE: '/api/v2/eod-pnl-reports',
    // Distinct (strategyName, product) present in the caller's scoped EOD reports — for the reports
    // strategy filter, unioned with the catalog so disabled/removed strategies remain filterable.
    STRATEGIES: '/api/v2/eod-pnl-reports/strategies',
  },

  // V2 Positional daily-MTM recompute (sysadmin): rebuild the broker-basis positional report over a
  // date range from stored trades + captured closes. Dry-run previews; apply writes. Background job.
  V2_POSITIONAL_MTM: {
    RECOMPUTE: '/api/v2/positional-mtm-recompute',
    RECOMPUTE_STATUS: '/api/v2/positional-mtm-recompute/status',
  },

  // V2 Manual EOD job run (sysadmin): trigger, per exchange, the same post-market EOD sequence the
  // auto worker runs. Gated on the configured post-market time + per-exchange single-flight.
  V2_EOD_JOB_RUN: {
    RUN: '/api/v2/eod-job-run',
    STATUS: '/api/v2/eod-job-run/status',
    EXCHANGES: '/api/v2/eod-job-run/exchanges',
  },

  // V2 Capital Change History
  V2_CAPITAL_HISTORY: {
    BASE: '/api/v2/capital-change-history',
  },

  // V2 Unaccounted PnL
  V2_UNACCOUNTED_PNL: {
    BASE: '/api/v2/unaccounted-pnl',
  },

  // V2 System Status (read-only admin observability dashboard)
  V2_SYSTEM_STATUS: {
    STATUS: '/api/v2/system-status',
    HEALTH_CHECK: '/api/v2/system-status/health-check',
    INIT_TIMELINE: '/api/v2/system-status/init-timeline',
  },

  // V2 Data Retention (Administration → Data Retention). Same path for GET (status poll) + POST (start).
  V2_DATA_RETENTION: {
    LIVE_TRADE_ARCHIVE: '/api/v2/data-retention/live-trade-archive',
  },

  // V2 Cache Management
  V2_CACHE: {
    STATS: '/api/v2/cache/stats',
    CLEAR_ROLES: '/api/v2/cache/roles',
    CLEAR_CORE: '/api/v2/cache/core',
    CLEAR_CORE_BY_NAME: (name: string) => `/api/v2/cache/core/${name}`,
    REFRESH_AI_SCHEMA: '/api/v2/cache/ai-schema',
    CLEAR_ALL: '/api/v2/cache/all',
  },

  // V2 License Info
  V2_LICENSE_INFO: '/api/v2/license-info',
  V2_LICENSE_OWNER: '/api/v2/license-info/owner-licenses',
  V2_LICENSE_REQUEST: '/api/v2/license-info/request-licenses',
  V2_LICENSE_CANCEL: '/api/v2/license-info/cancel-licenses',

  // V2 System Config
  V2_SYSTEM_CONFIG: {
    BASE: '/api/v2/system-config',
    LIST: '/api/v2/system-config',
    DETAILS: (key: string) => `/api/v2/system-config/${key}`,
  },

  // V2 Strategy Config Tree (hierarchical configuration)
  V2_STRATEGY_CONFIG_TREE: {
    BASE: '/api/v2/strategy-config-tree',
    LIST: '/api/v2/strategy-config-tree',
    DETAILS: (id: number) => `/api/v2/strategy-config-tree/${id}`,
    BY_STRATEGY: (strategyName: string) => `/api/v2/strategy-config-tree/strategy/${strategyName}`,
    EFFECTIVE: '/api/v2/strategy-config-tree/effective',
    DAY_CONDITIONS: '/api/v2/strategy-config-tree/day-conditions',
    BASE_CONFIGS: '/api/v2/strategy-config-tree/base',
    STRATEGY_NAMES: '/api/v2/strategy-config-tree/strategy-names',
    EXISTS: '/api/v2/strategy-config-tree/exists',
  },

  // V2 Strategy Policies (reusable configuration policies)
  V2_STRATEGY_POLICIES: {
    BASE: '/api/v2/strategy-policies',
    ALL: '/api/v2/strategy-policies',
    ORDER_FILL: {
      LIST: '/api/v2/strategy-policies/order-fill',
      DETAILS: (id: number) => `/api/v2/strategy-policies/order-fill/${id}`,
    },
    TRAILING_SL: {
      LIST: '/api/v2/strategy-policies/trailing-sl',
      DETAILS: (id: number) => `/api/v2/strategy-policies/trailing-sl/${id}`,
    },
    SL_TARGET: {
      LIST: '/api/v2/strategy-policies/sl-target',
      DETAILS: (id: number) => `/api/v2/strategy-policies/sl-target/${id}`,
    },
    STRIKE: {
      LIST: '/api/v2/strategy-policies/strike',
      DETAILS: (id: number) => `/api/v2/strategy-policies/strike/${id}`,
    },
    EXIT: {
      LIST: '/api/v2/strategy-policies/exit',
      DETAILS: (id: number) => `/api/v2/strategy-policies/exit/${id}`,
    },
  },

  // V2 Symbols
  V2_SYMBOLS: {
    BASE: '/api/v2/symbols',
    LIST: '/api/v2/symbols',
    DETAILS: (symbol: string) => `/api/v2/symbols/${encodeURIComponent(symbol)}`,
    BY_EXCHANGE: (exchange: string) => `/api/v2/symbols?exchange=${encodeURIComponent(exchange)}`,
    BROKERS: (symbol: string) => `/api/v2/symbols/${encodeURIComponent(symbol)}/brokers`,
    BROKER_DETAILS: (symbol: string, broker: string) => `/api/v2/symbols/${encodeURIComponent(symbol)}/brokers/${encodeURIComponent(broker)}`,
  },

  // V2 Symbol Broker Configs (all configs across symbols)
  V2_SYMBOL_BROKER_CONFIGS: {
    BASE: '/api/v2/symbol-broker-configs',
    LIST: '/api/v2/symbol-broker-configs',
    BY_SYMBOL: (symbol: string) => `/api/v2/symbol-broker-configs/${encodeURIComponent(symbol)}`,
    BY_BROKER: (broker: string) => `/api/v2/symbol-broker-configs?broker=${encodeURIComponent(broker)}`,
    DETAILS: (symbol: string, broker: string) => `/api/v2/symbol-broker-configs/${encodeURIComponent(symbol)}/${encodeURIComponent(broker)}`,
  },
  // V2 Strategy Engine (Per-Exchange)
  V2_ENGINE: {
    // Engine Control
    BASE: '/api/v2/engine',
    STATUS: '/api/v2/engine/status',  // All exchanges status
    STATUS_EXCHANGE: (exchange: string) => `/api/v2/engine/status/${exchange}`,
    METRICS: (exchange: string) => `/api/v2/engine/metrics/${exchange}`,
    START: (exchange: string) => `/api/v2/engine/start/${exchange}`,
    STOP: (exchange: string) => `/api/v2/engine/stop/${exchange}`,
    RELOAD: (exchange: string) => `/api/v2/engine/reload/${exchange}`,
    DRYRUN_ENABLE: (exchange: string) => `/api/v2/engine/dryrun/${exchange}/enable`,
    DRYRUN_DISABLE: (exchange: string) => `/api/v2/engine/dryrun/${exchange}/disable`,
    SHUTDOWN_ALL: '/api/v2/engine/shutdown',
  },

  // Mock-trading session toggle (admin-controlled, used for NSE/BSE
  // weekend / holiday mock sessions). Backed by MockSessionServletV2.
  V2_ENGINE_MOCK: {
    STATUS: '/api/v2/engine/mock/status',
    START:  '/api/v2/engine/mock/start',
    STOP:   '/api/v2/engine/mock/stop',
  },

  V2_ENGINE_TEMPLATES: {
    BASE: '/api/v2/engine/templates',
    LIST: '/api/v2/engine/templates',
    ACTIVE: '/api/v2/engine/templates/active',
    DETAILS: (name: string) => `/api/v2/engine/templates/${name}`,
  },

  V2_ENGINE_DEFINITIONS: {
    BASE: '/api/v2/engine/definitions',
    LIST: '/api/v2/engine/definitions',
    ACTIVE: '/api/v2/engine/definitions/active',
    // W4: live template derivation — the form describes intent, the server says which engine runs it.
    RESOLVE_TEMPLATE: '/api/v2/engine/definitions/resolve-template',
    DETAILS: (id: number) => `/api/v2/engine/definitions/${id}`,
    BY_NAME: (name: string) => `/api/v2/engine/definitions/name/${name}`,
    CHANGE_STATUS: (id: number, status: string) => `/api/v2/engine/definitions/${id}/status/${status}`,
    EXPORT: '/api/v2/engine/definitions/transfer/export',
    IMPORT_PREVIEW: '/api/v2/engine/definitions/transfer/import/preview',
    IMPORT_APPLY: '/api/v2/engine/definitions/transfer/import/apply',
  },

  // Minimal SYSTEM-scope strategy catalog for admin-console filter dropdowns (subscriptions, reports,
  // analytics). Management-gated (admin/supervisor), not tied to any one tool permission.
  V2_STRATEGY_CATALOG: {
    BASE: '/api/v2/strategy-catalog',
  },

  V2_ENGINE_SUBSCRIPTIONS: {
    BASE: '/api/v2/engine/subscriptions',
    LIST: '/api/v2/engine/subscriptions',
    ACTIVE: '/api/v2/engine/subscriptions/active',
    DETAILS: (id: number) => `/api/v2/engine/subscriptions/${id}`,
    BY_USER: (username: string) => `/api/v2/engine/subscriptions/user/${username}`,
    BY_STRATEGY: (strategyName: string) => `/api/v2/engine/subscriptions/strategy/${strategyName}`,
    SIGNALS: '/api/v2/engine/subscriptions/signals',
    ACTIVATE: (id: number) => `/api/v2/engine/subscriptions/${id}/activate`,
    DEACTIVATE: (id: number) => `/api/v2/engine/subscriptions/${id}/deactivate`,
  },

  V2_ENGINE_SIGNALS: {
    BASE: '/api/v2/engine/signals',
    LIST: '/api/v2/engine/signals',
    PENDING: '/api/v2/engine/signals/pending',
    RECENT: '/api/v2/engine/signals/recent',
    DETAILS: (id: number) => `/api/v2/engine/signals/${id}`,
    BY_SOURCE: (source: string) => `/api/v2/engine/signals/source/${source}`,
    CANCEL: (id: number) => `/api/v2/engine/signals/${id}/cancel`,
    CLEANUP: '/api/v2/engine/signals/cleanup',
  },

  V2_ENGINE_STATES: {
    BASE: '/api/v2/engine/strategy-states',
    LIST: '/api/v2/engine/strategy-states',
    SUMMARY: '/api/v2/engine/strategy-states/summary',
    DETAILS: (username: string, strategy: string, broker: string) =>
      `/api/v2/engine/strategy-states/${username}/${strategy}/${broker}`,
  },

  V2_ENGINE_BREAKOUT_WATCHES: {
    BASE: '/api/v2/engine/breakout-watches',
    LIST: '/api/v2/engine/breakout-watches',
    SUMMARY: '/api/v2/engine/breakout-watches/summary',
    DETAILS: (id: number) => `/api/v2/engine/breakout-watches/${id}`,
    BY_USER: (username: string) => `/api/v2/engine/breakout-watches?username=${username}`,
    BY_USER_BROKER: (username: string, broker: string) =>
      `/api/v2/engine/breakout-watches?username=${username}&broker=${broker}`,
    BY_STRATEGY: (strategy: string) => `/api/v2/engine/breakout-watches?strategy=${strategy}`,
  },

  // Stock universes (equity watchlists). Backed by StockUniverseServletV2.
  V2_ENGINE_UNIVERSES: {
    BASE: '/api/v2/engine/universes',
    LIST: '/api/v2/engine/universes',
    ACTIVE: '/api/v2/engine/universes/active',
    DETAILS: (id: number) => `/api/v2/engine/universes/${id}`,
  },

  V2_ENGINE_SCHEDULES: {
    BASE: '/api/v2/engine/schedules',
    LIST: '/api/v2/engine/schedules',
    DETAILS: (id: number) => `/api/v2/engine/schedules/${id}`,
    BY_STRATEGY: (strategyName: string) => `/api/v2/engine/schedules/strategy/${strategyName}`,
  },

  V2_ENGINE_INDICATOR_RULES: {
    BASE: '/api/v2/engine/indicator-rules',
    LIST: '/api/v2/engine/indicator-rules',
    BY_STRATEGY: (strategyName: string) => `/api/v2/engine/indicator-rules/${strategyName}`,
  },

  V2_ENGINE_INDICATOR_DIRECTION_RULES: {
    BASE: '/api/v2/engine/indicator-direction-rules',
    BY_STRATEGY: (strategyName: string) => `/api/v2/engine/indicator-direction-rules/${strategyName}`,
  },

  // V2 Testing
  V2_TESTING: {
    BASE: '/api/v2/testing',
    SIGNAL: '/api/v2/testing/signal',
    STRATEGIES: '/api/v2/testing/strategies',
    RESET_STRATEGY_STATE: '/api/v2/testing/reset-strategy-state',
    UPDATE_STRATEGY_STATE: '/api/v2/testing/update-strategy-state',
    CLEAR_STRATEGY_STATE: '/api/v2/testing/clear-strategy-state',
    PLACE_ORDER: '/api/v2/testing/place-order',
    MODIFY_ORDER: '/api/v2/testing/modify-order',
    CANCEL_ORDER: '/api/v2/testing/cancel-order',
    TRIGGER_DB_BACKUP: '/api/v2/testing/trigger-db-backup',
    CLEAR_CANDLES_HISTORY: '/api/v2/testing/clear-candles-history',
  },

  // V2 Broker Instruments
  V2_BROKER_INSTRUMENTS: {
    BASE: '/api/v2/broker-instruments',
    LIST: '/api/v2/broker-instruments',
    DETAILS: (broker: string) => `/api/v2/broker-instruments/${broker}`,
    SEARCH: (broker: string) => `/api/v2/broker-instruments/${broker}/search`,
    LOOKUP: (broker: string) => `/api/v2/broker-instruments/${broker}/lookup`,
    EXPIRIES: (broker: string) => `/api/v2/broker-instruments/${broker}/expiries`,
    DOWNLOAD: (broker: string) => `/api/v2/broker-instruments/${broker}/download`,
  },

  // ==================== MARKET DATA ENDPOINTS (Standalone mode) ====================

  MARKET_DATA: {
    // Public APIs
    QUOTES: '/api/v2/market-data/quotes',
    OHLC: '/api/v2/market-data/ohlc',
    HISTORY: '/api/v2/market-data/history',
    STRADDLE_HISTORY: '/api/v2/market-data/history/straddle',
    IV_HISTORY: '/api/v2/market-data/history/iv',
    PCR_HISTORY: '/api/v2/market-data/history/pcr',
    STRADDLE_TICKS: '/api/v2/market-data/sticks',
    IV_TICKS: '/api/v2/market-data/ivticks',
    PCR_TICKS: '/api/v2/market-data/pcrticks',
    SIGNALS: '/api/v2/market-data/signals',
    HEALTH: '/api/v2/market-data/health',
    INDICES: '/api/v2/market-data/indices',
    EXPIRIES: '/api/v2/market-data/expiries',

    // Admin - Signal Config
    ADMIN_RULES: '/api/v2/market-data/admin/rules',
    ADMIN_RULES_DETAILS: (id: number) => `/api/v2/market-data/admin/rules/${id}`,
    ADMIN_STRATEGY_RULES: '/api/v2/market-data/admin/strategy-rules',

    // Admin - Data Management
    ADMIN_EXCHANGES: '/api/v2/market-data/admin/exchanges',
    ADMIN_EXCHANGES_DETAILS: (code: string) => `/api/v2/market-data/admin/exchanges/${code}`,
    ADMIN_SYMBOLS: '/api/v2/market-data/admin/symbols',
    ADMIN_SYMBOLS_DETAILS: (symbol: string) => `/api/v2/market-data/admin/symbols/${symbol}`,
    ADMIN_HOLIDAYS: '/api/v2/market-data/admin/holidays',
    ADMIN_SPECIAL_TRADING_DAYS: '/api/v2/market-data/admin/special-trading-days',

    // Admin - Monitoring
    ADMIN_AUDIT_LOGS: '/api/v2/market-data/admin/audit-logs',
    ADMIN_CONFIG: '/api/v2/market-data/admin/config',
    ADMIN_CONFIG_DETAILS: (property: string) => `/api/v2/market-data/admin/config/${property}`,
    ADMIN_SIGNAL_OUTPUTS: '/api/v2/market-data/admin/signal-outputs',
    ADMIN_WEBSOCKET_SESSIONS: '/api/v2/market-data/admin/websocket-sessions',
    ADMIN_STATUS: '/api/v2/market-data/admin/status',
    ADMIN_INSTRUMENTS: '/api/v2/market-data/admin/instruments',

    // Ticker control
    START_TICKER: '/api/v2/market-data/start/ticker',
    STOP_TICKER: '/api/v2/market-data/stop/ticker',
    RESTART_TICKER: '/api/v2/market-data/restart/ticker',
    SWITCH_TICKER: '/api/v2/market-data/switch/ticker',
    SWITCH_HISTORY: '/api/v2/market-data/switch/history',

    // WebSocket
    SOCKET: '/api/v2/market-data/socket',

    // Data Providers
    PROVIDERS_STATUS: '/api/v2/market-data/providers/status',
    PROVIDERS_ZERODHA_LOGIN_URL: '/api/v2/market-data/providers/zerodha/login-url',
    PROVIDERS_XTS_LOGIN: '/api/v2/market-data/providers/xts/login',
  },
  // V2 Email Templates
  V2_EMAIL_TEMPLATES: {
    LIST: '/api/v2/email-templates',
    DETAILS: (key: string) => `/api/v2/email-templates/${encodeURIComponent(key)}`,
    DEFAULTS: (key: string) => `/api/v2/email-templates/${encodeURIComponent(key)}/defaults`,
    RESET: (key: string) => `/api/v2/email-templates/${encodeURIComponent(key)}/reset`,
    ACTION: (key: string, action: string) => `/api/v2/email-templates/${encodeURIComponent(key)}/${action}`,
  },

  // V2 Email Branding
  V2_EMAIL_BRANDING: {
    BASE: '/api/v2/email-branding',
  },

  // V2 Email Preferences
  V2_EMAIL_PREFERENCES: {
    SELF: '/api/v2/me/email-preferences',
    AVAILABLE_CATEGORIES: '/api/v2/email-preferences/available-categories',
    FOR_USER: (username: string) => `/api/v2/email-preferences/${encodeURIComponent(username)}`,
  },
} as const;
