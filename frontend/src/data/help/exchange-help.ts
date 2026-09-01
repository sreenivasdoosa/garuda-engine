import type { HelpArticle } from '@/types/help';

const ex = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const exchangeHelpContent: Record<string, HelpArticle> = {
  // ==================== BASIC INFO ====================

  'exchange.code': ex({
    fieldKey: 'exchange.code',
    title: 'Exchange Code',
    category: 'Basic Info',
    description: [
      'A unique short code identifying the exchange. This is the primary key and is **immutable** after creation. It is referenced by symbols, instruments, holidays, event days, and all trading operations.',
      'Auto-converted to uppercase on input.',
    ],
    example: {
      title: 'Standard Exchange Codes',
      content:
        '`NSE` — National Stock Exchange (Equity & F&O)\n`BSE` — Bombay Stock Exchange\n`MCX` — Multi Commodity Exchange\n`CDS` — Currency Derivatives Segment\n`NCDEX` — National Commodity & Derivatives Exchange',
    },
    warning:
      'Cannot be changed after creation. All symbols, holidays, and event days are linked to this code.',
  }),

  'exchange.exchangeName': ex({
    fieldKey: 'exchange.exchangeName',
    title: 'Exchange Name',
    category: 'Basic Info',
    description: [
      'Full descriptive name of the exchange. Displayed in the UI for user-friendly identification alongside the exchange code.',
    ],
    example: {
      title: 'Examples',
      content:
        'For code `NSE`: "National Stock Exchange"\nFor code `MCX`: "Multi Commodity Exchange"',
    },
  }),

  'exchange.timezone': ex({
    fieldKey: 'exchange.timezone',
    title: 'Timezone',
    category: 'Basic Info',
    description: [
      'The timezone in which this exchange operates. All market timing calculations — market open/close, square-off times, algo start times — are computed relative to this timezone.',
      'Uses standard IANA timezone identifiers.',
    ],
    example: {
      title: 'Common Values',
      content:
        '`Asia/Kolkata` — For Indian exchanges (NSE, BSE, MCX, CDS). This is IST (UTC+5:30).',
    },
    defaultValue: 'Asia/Kolkata',
  }),

  'exchange.isActive': ex({
    fieldKey: 'exchange.isActive',
    title: 'Active',
    category: 'Basic Info',
    description: [
      'Controls whether the algo trading engine is **active** for this exchange. When active, the engine starts before market open, processes signals, and places orders.',
      'Deactivating an exchange **immediately stops the algo engine** for that exchange and sends a **CRITICAL alert**. Reactivating it starts the engine if the market is currently open, or schedules it for the next market open.',
    ],
    defaultValue: 'true',
    warning:
      'Deactivating an exchange stops all automated trading on that exchange immediately. Open positions are NOT automatically squared off.',
  }),

  'exchange.historyCacheEnabled': ex({
    fieldKey: 'exchange.historyCacheEnabled',
    title: 'History Cache Enabled',
    category: 'Basic Info',
    description: [
      'When enabled, the system caches historical candle data for configured symbols on this exchange. Cached data speeds up indicator calculations and backtesting by avoiding repeated API calls for historical data.',
    ],
    defaultValue: 'false',
  }),

  'exchange.weekendDays': ex({
    fieldKey: 'exchange.weekendDays',
    title: 'Weekend Days',
    category: 'Basic Info',
    description: [
      'The days of the week when this exchange does **not** trade. The system skips these days when scheduling algo operations, generating reports, and calculating billing periods.',
    ],
    example: {
      title: 'Common Configuration',
      content:
        'Indian exchanges (NSE, BSE, MCX): **Saturday** and **Sunday**.\nSome international exchanges may have different weekend patterns.',
    },
    defaultValue: 'Saturday, Sunday',
  }),

  // ==================== MARKET TIMING ====================

  'exchange.preMarketStart': ex({
    fieldKey: 'exchange.preMarketStart',
    title: 'Pre-Market Start',
    category: 'Market Timing',
    description: [
      'The time when the exchange\'s **pre-market session** begins. During pre-market, orders can be placed but are not executed until the regular market opens.',
      'Set to `null` if the exchange does not have a pre-market session (e.g., MCX).',
    ],
    example: {
      title: 'NSE Example',
      content:
        'NSE pre-market starts at `09:00:00` (9:00 AM IST). Orders placed between 9:00-9:08 AM participate in the opening price discovery auction.',
    },
    relatedFields: ['exchange.preMarketEnd', 'exchange.marketOpen'],
  }),

  'exchange.preMarketEnd': ex({
    fieldKey: 'exchange.preMarketEnd',
    title: 'Pre-Market End',
    category: 'Market Timing',
    description: [
      'The time when the exchange\'s pre-market session ends. After this, the system waits for regular market open.',
    ],
    example: {
      title: 'NSE Example',
      content:
        'NSE pre-market ends at `09:08:00` (9:08 AM IST). Between 9:08 and 9:15, there is a transition period before regular trading begins.',
    },
    relatedFields: ['exchange.preMarketStart', 'exchange.marketOpen'],
  }),

  'exchange.marketOpen': ex({
    fieldKey: 'exchange.marketOpen',
    title: 'Market Open',
    category: 'Market Timing',
    description: [
      'The time when regular trading begins on this exchange. This is the primary reference point for all algo timing calculations — login start, algo start, and early market grace periods are all calculated relative to this time.',
    ],
    example: {
      title: 'Common Open Times',
      content:
        '`NSE Equity & F&O`: 09:15:00 (9:15 AM IST)\n`MCX`: Various segments open at different times; commodity futures typically at 09:00:00.',
    },
    relatedFields: ['exchange.marketClose', 'exchange.loginMinutesBeforeMarketOpen', 'exchange.algoStartMinutesBeforeMarketOpen'],
  }),

  'exchange.marketClose': ex({
    fieldKey: 'exchange.marketClose',
    title: 'Market Close',
    category: 'Market Timing',
    description: [
      'The time when regular trading ends on this exchange. After this time, no new orders can be placed. Square-off and reporting timings are calculated relative to this time.',
    ],
    example: {
      title: 'Common Close Times',
      content:
        '`NSE Equity`: 15:30:00 (3:30 PM IST)\n`MCX Commodity`: 23:30:00 (11:30 PM IST) — note the late close for commodity markets.',
    },
    relatedFields: ['exchange.marketOpen', 'exchange.intradaySquareOffMinutesBeforeClose'],
  }),

  // ==================== ALGO CONFIGURATION ====================

  'exchange.algoStartMinutesBeforeMarketOpen': ex({
    fieldKey: 'exchange.algoStartMinutesBeforeMarketOpen',
    title: 'Algo Start (mins before open)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **before market open** the algo trading engine starts up. The engine needs lead time to initialize strategies, load configurations, subscribe to market data, and prepare for trading.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `90` (default). For NSE opening at 9:15 AM, the engine starts at 7:45 AM. This gives 90 minutes for initialization, data loading, and system health checks.',
    },
    defaultValue: '90',
    relatedFields: ['exchange.loginMinutesBeforeMarketOpen', 'exchange.marketOpen'],
  }),

  'exchange.loginMinutesBeforeMarketOpen': ex({
    fieldKey: 'exchange.loginMinutesBeforeMarketOpen',
    title: 'Login Start (mins before open)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **before market open** the system begins automatic broker login for all users with auto-login enabled. The login window starts at this time.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `60` (default). For NSE opening at 9:15 AM, auto-login starts at 8:15 AM. All users with auto-login enabled will have their broker sessions established by market open.',
    },
    defaultValue: '60',
    relatedFields: ['exchange.algoStartMinutesBeforeMarketOpen', 'exchange.marketOpen'],
  }),

  'exchange.postMarketWindowMinutes': ex({
    fieldKey: 'exchange.postMarketWindowMinutes',
    title: 'Post-Market Window (mins)',
    category: 'Algo Configuration',
    description: [
      'Duration in minutes of the **post-market window** after market close. During this window, the system continues to monitor positions, process pending callbacks, and handle any post-market activities.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `60`. For NSE closing at 3:30 PM, the post-market window extends to 4:30 PM. After 4:30 PM, the system transitions to end-of-day mode.',
    },
    defaultValue: '60',
    relatedFields: ['exchange.marketClose', 'exchange.reportMinutesAfterClose'],
  }),

  'exchange.intradaySquareOffMinutesBeforeClose': ex({
    fieldKey: 'exchange.intradaySquareOffMinutesBeforeClose',
    title: 'Intraday Square-Off (mins before close)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **before market close** the system automatically squares off (closes) all **intraday/MIS positions**. This ensures MIS positions are closed before the exchange\'s own square-off deadline.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `20`. For NSE closing at 3:30 PM, MIS square-off starts at 3:10 PM. All MIS positions are closed with market orders. This gives a buffer before the exchange\'s forced square-off (typically 3:15-3:20 PM).',
    },
    defaultValue: '20',
    relatedFields: ['exchange.intradaySquareOffBlockMinutesBeforeClose', 'exchange.marketClose'],
    warning:
      'Setting too close to market close risks positions being squared off by the exchange at potentially worse prices.',
  }),

  'exchange.intradaySquareOffBlockMinutesBeforeClose': ex({
    fieldKey: 'exchange.intradaySquareOffBlockMinutesBeforeClose',
    title: 'Intraday Block (mins before close)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **before market close** the system **blocks new MIS (intraday) orders**. After this time, no new intraday positions can be opened — only exit orders are allowed.',
      'This prevents new MIS positions from being opened too close to the square-off time, which could result in immediate forced closure.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `10`. For NSE closing at 3:30 PM, new MIS orders are blocked after 3:20 PM. Existing MIS positions can still be exited. The intraday square-off at 3:10 PM (from `intradaySquareOffMinutesBeforeClose = 20`) would have already started closing positions.',
    },
    defaultValue: '10',
    relatedFields: ['exchange.intradaySquareOffMinutesBeforeClose', 'exchange.marketClose'],
  }),

  'exchange.positionalSquareOffMinutesBeforeClose': ex({
    fieldKey: 'exchange.positionalSquareOffMinutesBeforeClose',
    title: 'Positional Square-Off (mins before close)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **before market close** the system squares off **positional/NRML positions** that are marked for same-day exit. Not all positional positions are affected — only those flagged for square-off by strategy rules.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `30`. For NSE closing at 3:30 PM, positional square-off starts at 3:00 PM for positions that need to be closed today based on strategy exit rules.',
    },
    defaultValue: '30',
    relatedFields: ['exchange.intradaySquareOffMinutesBeforeClose', 'exchange.marketClose'],
  }),

  'exchange.reportMinutesAfterClose': ex({
    fieldKey: 'exchange.reportMinutesAfterClose',
    title: 'Report Generation (mins after close)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **after market close** the system generates end-of-day P&L reports and trade summaries. The delay allows all pending order fills and settlement data to be received before report generation.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `15`. For NSE closing at 3:30 PM, EOD reports are generated at 3:45 PM. This gives 15 minutes for all pending order updates from the broker to be processed.',
    },
    defaultValue: '15',
    relatedFields: ['exchange.billingMinutesAfterClose', 'exchange.postMarketWindowMinutes'],
  }),

  'exchange.billingMinutesAfterClose': ex({
    fieldKey: 'exchange.billingMinutesAfterClose',
    title: 'Billing Generation (mins after close)',
    category: 'Algo Configuration',
    description: [
      'How many minutes **after market close** the system runs billing calculations. Scheduled after report generation to ensure all P&L data is finalized before billing.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `30`. For NSE closing at 3:30 PM, billing runs at 4:00 PM. This is after the EOD report at 3:45 PM (`reportMinutesAfterClose = 15`), ensuring P&L numbers are final.',
    },
    defaultValue: '30',
    relatedFields: ['exchange.reportMinutesAfterClose'],
  }),

  // ==================== HOLIDAYS ====================

  'holiday.date': ex({
    fieldKey: 'holiday.date',
    title: 'Holiday Date',
    category: 'Holidays',
    description: [
      'The date of the exchange holiday in **YYYY-MM-DD** format. On holiday dates, the exchange is closed and the algo engine does **not** start. No trading operations are attempted.',
      'Each holiday is specific to an exchange — a holiday on NSE does not automatically apply to MCX or other exchanges.',
    ],
    example: {
      title: 'Example',
      content:
        '`2024-01-26` — Republic Day (NSE, BSE closed)\n`2024-08-15` — Independence Day (NSE, BSE closed)\n`2024-11-01` — Diwali (NSE regular session closed, but Muhurat trading may be a Special Trading Day)',
    },
  }),

  'holiday.description': ex({
    fieldKey: 'holiday.description',
    title: 'Holiday Description',
    category: 'Holidays',
    description: [
      'A short description or name for the holiday. Used for display purposes in the UI and reports.',
    ],
    example: {
      title: 'Examples',
      content:
        '"Republic Day", "Independence Day", "Diwali", "Christmas", "Good Friday", "Mahatma Gandhi Jayanti"',
    },
  }),

  // ==================== EVENT DAYS ====================

  'eventDay.eventDate': ex({
    fieldKey: 'eventDay.eventDate',
    title: 'Event Date',
    category: 'Event Days',
    description: [
      'The date of the special event in **YYYY-MM-DD** format. Event days are trading days with **special conditions** — the exchange is open, but trading parameters may be adjusted.',
    ],
    example: {
      title: 'Common Event Types',
      content:
        'Weekly/monthly F&O expiry days, Union Budget day, RBI policy announcements, election result days, Muhurat trading sessions.',
    },
  }),

  'eventDay.eventName': ex({
    fieldKey: 'eventDay.eventName',
    title: 'Event Name',
    category: 'Event Days',
    description: [
      'A descriptive name for the event. Used for display in the UI and to identify what makes this day special.',
    ],
    example: {
      title: 'Examples',
      content:
        '"Weekly Expiry", "Monthly Expiry", "Budget Day", "RBI Policy", "Muhurat Trading", "Election Results"',
    },
  }),


  'eventDay.capitalPercentage': ex({
    fieldKey: 'eventDay.capitalPercentage',
    title: 'Capital Percentage',
    category: 'Event Days',
    description: [
      'The percentage of normal capital to deploy on this event day. Ranges from **0** (no trading) to **100** (full capital). This allows reducing exposure on volatile or uncertain days.',
      'Individual users and strategies can **override** this global setting via the Strategy Config and User Config tabs.',
      'The value is clamped between 0 and 100 by the server.',
    ],
    example: {
      title: 'Example Scenarios',
      content:
        '**Budget Day**: Set to `50` — only 50% of normal capital is deployed, reducing risk during high-uncertainty events.\n**Monthly Expiry**: Set to `75` — slightly reduced capital due to higher volatility near expiry.\n**Normal Expiry**: Keep at `100` — full capital deployed.',
    },
    defaultValue: '100 (full capital)',
    warning:
      'Setting to `0` effectively blocks all strategy entries for that day. Exit orders for existing positions are still allowed.',
  }),
};
