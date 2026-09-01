import type { HelpArticle } from '@/types/help';

const bc = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const brokerConfigHelpContent: Record<string, HelpArticle> = {
  // ==================== BROKER EXCHANGE CONFIG ====================

  'brokerExchangeConfig.broker': bc({
    fieldKey: 'brokerExchangeConfig.broker',
    title: 'Broker',
    category: 'Broker Exchange Config',
    description: [
      'The **broker** for this exchange configuration. Each broker-exchange combination has its own set of timing and order parameters.',
      'The broker must be one of the configured brokers in the system.',
    ],
    relatedFields: ['brokerExchangeConfig.exchange'],
    warning: 'Cannot be changed after creation. To change the broker, delete and recreate the config.',
  }),

  'brokerExchangeConfig.exchange': bc({
    fieldKey: 'brokerExchangeConfig.exchange',
    title: 'Exchange',
    category: 'Broker Exchange Config',
    description: [
      'The **exchange** this configuration applies to. Together with the broker, this forms the unique key for the configuration.',
      'The exchange must be one of the configured exchanges in the system (e.g., NFO, BFO, MCX).',
    ],
    relatedFields: ['brokerExchangeConfig.broker'],
    warning: 'Cannot be changed after creation.',
  }),

  'brokerExchangeConfig.loginMinutesBeforeMarketOpen': bc({
    fieldKey: 'brokerExchangeConfig.loginMinutesBeforeMarketOpen',
    title: 'Login Minutes Before Market Open',
    category: 'Broker Exchange Config',
    description: [
      'Number of **minutes before market open** at which the system initiates automatic broker login. The engine calculates the login time as: `marketOpenTime - loginMinutes`.',
      'Setting this too low may not leave enough time for login + data subscription before market opens. Setting it too high wastes API session time.',
    ],
    defaultValue: '30',
    example: {
      title: 'Example',
      content:
        'Exchange NFO opens at 9:15 AM. With loginMinutes = 30, the system starts broker login at 8:45 AM. This gives 30 minutes for authentication, WebSocket connection, and instrument subscription.',
    },
  }),

  'brokerExchangeConfig.intradaySquareOffMinutesBeforeClose': bc({
    fieldKey: 'brokerExchangeConfig.intradaySquareOffMinutesBeforeClose',
    title: 'Intraday Square-off Minutes Before Close',
    category: 'Broker Exchange Config',
    description: [
      'Number of **minutes before market close** at which the engine starts squaring off **intraday (MIS)** positions. The square-off time is calculated as: `marketCloseTime - squareOffMinutes`.',
      'This is the "soft" square-off — the engine will attempt to close positions gracefully with limit orders. See also the "block" square-off for the hard cutoff.',
    ],
    defaultValue: '15',
    example: {
      title: 'Example',
      content:
        'Exchange closes at 3:30 PM. With squareOffMinutes = 15, intraday positions start closing at 3:15 PM. Orders are placed as limit orders with the configured buffer percentage.',
    },
    relatedFields: [
      'brokerExchangeConfig.intradaySquareOffBlockMinutesBeforeClose',
      'brokerExchangeConfig.limitOrderBufferPercentageOptions',
    ],
  }),

  'brokerExchangeConfig.intradaySquareOffBlockMinutesBeforeClose': bc({
    fieldKey: 'brokerExchangeConfig.intradaySquareOffBlockMinutesBeforeClose',
    title: 'Intraday Square-off Block Minutes',
    category: 'Broker Exchange Config',
    description: [
      'Number of **minutes before market close** at which the engine **blocks new intraday entries** and forces remaining open positions to close. This is the "hard" cutoff after the soft square-off.',
      'Must be less than the soft square-off minutes. Any positions still open at this time are closed aggressively (market orders if allowed, or aggressive limit orders).',
    ],
    defaultValue: '10',
    example: {
      title: 'Example',
      content:
        'Soft square-off at 3:15 PM (15 mins before close). Block square-off at 3:20 PM (10 mins before close). Between 3:15-3:20, the engine tries graceful exit. After 3:20, no new entries allowed and remaining positions are force-closed.',
    },
    relatedFields: ['brokerExchangeConfig.intradaySquareOffMinutesBeforeClose'],
    warning:
      'Must be less than the intraday square-off minutes. Setting this too close to market close risks positions not being squared off in time.',
  }),

  'brokerExchangeConfig.positionalSquareOffMinutesBeforeClose': bc({
    fieldKey: 'brokerExchangeConfig.positionalSquareOffMinutesBeforeClose',
    title: 'Positional Square-off Minutes Before Close',
    category: 'Broker Exchange Config',
    description: [
      'Number of **minutes before market close** at which the engine starts squaring off **positional (NRML/CNC)** positions that are marked for exit today.',
      'This applies to positional strategies that need to close positions before end of day (e.g., expiry day exits). Overnight carry positions are not affected.',
    ],
    defaultValue: '15',
    example: {
      title: 'Example',
      content:
        'Exchange closes at 3:30 PM. With positionalSquareOff = 15, positional exit orders start at 3:15 PM. This is typically set to the same or slightly higher value than intraday square-off.',
    },
  }),

  'brokerExchangeConfig.limitOrderBufferPercentageEquity': bc({
    fieldKey: 'brokerExchangeConfig.limitOrderBufferPercentageEquity',
    title: 'Limit Order Buffer % — Equity',
    category: 'Broker Exchange Config',
    description: [
      'How far past the live price an **equity** MARKET order is priced when it is converted to a marketable LIMIT order (market protection). Buy limit = `LTP × (1 + buffer%)`, sell limit = `LTP × (1 - buffer%)`.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **1%**.',
      'Equity stays tight on purpose — a wide options-sized buffer on a ₹1,300 stock prices the order absurdly far from the market.',
    ],
    defaultValue: '1 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Buffer = 1%. INFY LTP = ₹1,500. A BUY MARKET order goes to the broker as a LIMIT at ₹1,515; a SELL MARKET order goes as a LIMIT at ₹1,485.',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageFutures',
      'brokerExchangeConfig.limitOrderBufferPercentageOptions',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity',
    ],
  }),

  'brokerExchangeConfig.limitOrderBufferPercentageFutures': bc({
    fieldKey: 'brokerExchangeConfig.limitOrderBufferPercentageFutures',
    title: 'Limit Order Buffer % — Futures',
    category: 'Broker Exchange Config',
    description: [
      'How far past the live price a **futures** MARKET order is priced when it is converted to a marketable LIMIT order. Buy limit = `LTP × (1 + buffer%)`, sell limit = `LTP × (1 - buffer%)`.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **1%**.',
      'Futures track the underlying closely and are liquid, so a tight buffer fills reliably without giving away price.',
    ],
    defaultValue: '1 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Buffer = 1%. NIFTY FUT LTP = ₹24,000. A BUY MARKET order is sent as a LIMIT at ₹24,240; a SELL MARKET order as a LIMIT at ₹23,760.',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageEquity',
      'brokerExchangeConfig.limitOrderBufferPercentageOptions',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures',
    ],
  }),

  'brokerExchangeConfig.limitOrderBufferPercentageOptions': bc({
    fieldKey: 'brokerExchangeConfig.limitOrderBufferPercentageOptions',
    title: 'Limit Order Buffer % — Options',
    category: 'Broker Exchange Config',
    description: [
      'How far past the live premium an **options** MARKET order is priced when it is converted to a marketable LIMIT order. Buy limit = `LTP × (1 + buffer%)`, sell limit = `LTP × (1 - buffer%)`.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **15%** — options are the widest segment because thin premiums and wide spreads need room to fill.',
      '**Low-premium escalation:** when the premium is at or under ₹5 the engine ignores this value and uses **40% for BUY / 20% for SELL** instead, with a ₹0.10 price floor so a rounded-down price is never sent.',
    ],
    defaultValue: '15 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Buffer = 15%. Premium = ₹120 → BUY LIMIT at ₹138, SELL LIMIT at ₹102. Premium = ₹4 (low-premium escalation kicks in) → BUY LIMIT at ₹5.60 (40%), SELL LIMIT at ₹3.20 (20%).',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageEquity',
      'brokerExchangeConfig.limitOrderBufferPercentageFutures',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions',
    ],
  }),

  'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity': bc({
    fieldKey: 'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity',
    title: 'SL Trigger→Limit Gap % — Equity',
    category: 'Broker Exchange Config',
    description: [
      'The gap between trigger and limit price for **equity** stop-loss orders. An SL-M is converted to an SL-LIMIT at `trigger × (1 + gap%)` for buy-side stops and `trigger × (1 - gap%)` for sell-side stops; an SL-LIMIT that already carries a limit price beyond the band is pulled back into it.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **1%**.',
    ],
    defaultValue: '1 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Gap = 1%. Sell SL on INFY with trigger ₹1,500 → limit ₹1,485. The order triggers at ₹1,500 and fills at ₹1,485 or better.',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageEquity',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions',
    ],
    warning:
      'Keep this tight. NSE enforces a ~3% permissible execution range on equity SL orders — an options-sized gap puts the limit outside the band and the exchange rejects the order outright.',
  }),

  'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures': bc({
    fieldKey: 'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures',
    title: 'SL Trigger→Limit Gap % — Futures',
    category: 'Broker Exchange Config',
    description: [
      'The gap between trigger and limit price for **futures** stop-loss orders. Buy-side stop limit = `trigger × (1 + gap%)`, sell-side stop limit = `trigger × (1 - gap%)`; a limit already outside the band is clamped back into it.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **1%**.',
    ],
    defaultValue: '1 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Gap = 1%. Sell SL on NIFTY FUT with trigger ₹24,000 → limit ₹23,760, leaving 1% of slippage room before the stop stops filling.',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageFutures',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions',
    ],
    warning:
      'Keep this tight — the exchange permissible-execution-range check applies to futures SL orders too, and a wide gap gets the order rejected rather than filled.',
  }),

  'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions': bc({
    fieldKey: 'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions',
    title: 'SL Trigger→Limit Gap % — Options',
    category: 'Broker Exchange Config',
    description: [
      'The gap between trigger and limit price for **options** stop-loss orders. Buy-side stop limit = `trigger × (1 + gap%)`, sell-side stop limit = `trigger × (1 - gap%)`; a limit already outside the band is clamped back into it.',
      'Only used when **Market Orders Allowed** is off (the default). Leave at `0` to use the code default of **18%** — the widest of the three segments, because an options stop that does not fill leaves a naked position.',
      'A ₹0.10 floor applies so a deep-discount stop limit is never rounded down to zero.',
    ],
    defaultValue: '18 (code default when left at 0)',
    example: {
      title: 'Example',
      content:
        'Gap = 18%. Sell SL on a premium of ₹200 → trigger ₹200, limit ₹164. The wide band means the stop still fills when the premium gaps down through the trigger.',
    },
    relatedFields: [
      'brokerExchangeConfig.marketOrdersAllowed',
      'brokerExchangeConfig.limitOrderBufferPercentageOptions',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures',
    ],
    warning:
      'The identically-named SL Trigger-Limit Gap % on the **strategy config tree** is a different, strategy-level setting that overrides this broker-level value when set.',
  }),

  'brokerExchangeConfig.naicCode': bc({
    fieldKey: 'brokerExchangeConfig.naicCode',
    title: 'NAIC Code (override)',
    category: 'Broker Exchange Config',
    description: [
      'Per-exchange **override** of the broker-level NAIC Code (exchange algo-tagging: `1` for algo + 2-digit exchange-issued vendor code). Set this only when the vendor code issued by THIS exchange differs from the broker-level global.',
      'Resolution at order time: this override → broker-level NAIC Code → omitted from the order payload when both are empty.',
    ],
    relatedFields: ['brokerExchangeConfig.algoId'],
  }),

  'brokerExchangeConfig.algoId': bc({
    fieldKey: 'brokerExchangeConfig.algoId',
    title: 'Algo ID (override)',
    category: 'Broker Exchange Config',
    description: [
      'Per-exchange **override** of the broker-level exchange-approved Algo ID. Set this only when the algo registration for THIS exchange carries a different id from the broker-level global.',
      'Resolution at order time: this override → broker-level Algo ID → omitted from the order payload when both are empty.',
    ],
    relatedFields: ['brokerExchangeConfig.naicCode'],
  }),

  'brokerExchangeConfig.marketOrdersAllowed': bc({
    fieldKey: 'brokerExchangeConfig.marketOrdersAllowed',
    title: 'Market Orders Allowed',
    category: 'Broker Exchange Config',
    description: [
      'The master switch for **market protection**. It **defaults to OFF**, and a broker-exchange combination with no config row at all is treated as OFF too — protected is the safe posture and raw market orders are the explicit opt-in.',
      'When **off**, every MARKET order is converted to a marketable **LIMIT** and every SL-M to an **SL-LIMIT** before it reaches the broker, priced with the per-segment buffers below (equity / futures / options each have their own). An SL-LIMIT whose limit price sits outside the permitted trigger→limit band is pulled back into it. This applies to entries, exits, square-off and emergency exits alike.',
      'When **on**, MARKET and SL-M orders go to the broker untouched and the buffers are ignored entirely.',
      'Brokers have moved to limit-only entry — **Zerodha requires this to be off**, because the Kite API rejects every raw market order with "Market orders without market protection are not allowed via API". Turn it on only for a broker you have confirmed still accepts raw MARKET / SL-M.',
    ],
    defaultValue: 'false',
    example: {
      title: 'Impact',
      content:
        'Off (default): a BUY MARKET on an option at ₹120 premium leaves as a LIMIT at ₹138 (15% options buffer); an equity BUY MARKET at ₹1,500 leaves as a LIMIT at ₹1,515 (1% equity buffer). On: both go out as true MARKET orders and fill at whatever the book offers.',
    },
    relatedFields: [
      'brokerExchangeConfig.limitOrderBufferPercentageEquity',
      'brokerExchangeConfig.limitOrderBufferPercentageFutures',
      'brokerExchangeConfig.limitOrderBufferPercentageOptions',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageEquity',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageFutures',
      'brokerExchangeConfig.slTriggerToLimitGapPercentageOptions',
    ],
    warning:
      'Enabling this on a broker whose API rejects raw market orders makes every market-order exit fail — including square-off, which leaves positions open.',
  }),

  // ==================== BROKER STRATEGY CONFIG ====================

  'brokerStrategyConfig.broker': bc({
    fieldKey: 'brokerStrategyConfig.broker',
    title: 'Broker',
    category: 'Broker Strategy Config',
    description: [
      'The **broker** for this strategy-specific configuration. Allows per-broker overrides of square-off timing for individual strategies.',
    ],
    relatedFields: ['brokerStrategyConfig.strategy'],
    warning: 'Cannot be changed after creation.',
  }),

  'brokerStrategyConfig.strategy': bc({
    fieldKey: 'brokerStrategyConfig.strategy',
    title: 'Strategy',
    category: 'Broker Strategy Config',
    description: [
      'The **strategy** this broker-specific configuration applies to. Together with the broker, this forms the unique key.',
      'This allows different square-off timings per strategy per broker — useful when certain strategies need earlier/later exits than the exchange-level defaults.',
    ],
    relatedFields: ['brokerStrategyConfig.broker'],
    warning: 'Cannot be changed after creation.',
  }),

  'brokerStrategyConfig.intradaySquareOffMinutes': bc({
    fieldKey: 'brokerStrategyConfig.intradaySquareOffMinutes',
    title: 'Intraday Square-off Minutes',
    category: 'Broker Strategy Config',
    description: [
      'Strategy-level override for **intraday square-off timing** for this specific broker. Minutes before market close at which intraday positions for this strategy are squared off.',
      'This overrides the broker exchange config setting for this specific strategy. If not set or set to default, the exchange-level setting is used.',
    ],
    defaultValue: '15',
    example: {
      title: 'Example',
      content:
        'Broker exchange config has intraday square-off at 15 mins before close. But for a high-gamma strategy like BANKNIFTY_STRADDLE, you may want 20 mins to allow more time for orderly exit.',
    },
    relatedFields: [
      'brokerExchangeConfig.intradaySquareOffMinutesBeforeClose',
      'brokerStrategyConfig.positionalSquareOffMinutes',
    ],
  }),

  'brokerStrategyConfig.positionalSquareOffMinutes': bc({
    fieldKey: 'brokerStrategyConfig.positionalSquareOffMinutes',
    title: 'Positional Square-off Minutes',
    category: 'Broker Strategy Config',
    description: [
      'Strategy-level override for **positional square-off timing** for this specific broker. Minutes before market close at which positional positions for this strategy are squared off.',
      'This overrides the broker exchange config setting for this specific strategy.',
    ],
    defaultValue: '15',
    example: {
      title: 'Example',
      content:
        'For an expiry-day strategy, set to 20 mins before close to ensure all positions are closed well before the expiry settlement window.',
    },
    relatedFields: [
      'brokerExchangeConfig.positionalSquareOffMinutesBeforeClose',
      'brokerStrategyConfig.intradaySquareOffMinutes',
    ],
  }),
};
