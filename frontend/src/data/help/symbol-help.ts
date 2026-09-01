import type { HelpArticle } from '@/types/help';

const sym = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const symbolHelpContent: Record<string, HelpArticle> = {
  // ==================== SYMBOL INFO ====================

  'symbol.symbol': sym({
    fieldKey: 'symbol.symbol',
    title: 'Symbol',
    category: 'Symbol Info',
    description: [
      'The trading symbol or scrip name as defined by the exchange. This is **synced from the market data service** and cannot be edited manually.',
      'Symbols are the base instruments on which F&O contracts (futures, call options, put options) are derived.',
    ],
    example: {
      title: 'Common Symbols',
      content:
        '`NIFTY` — Nifty 50 Index\n`BANKNIFTY` — Bank Nifty Index\n`FINNIFTY` — Fin Nifty Index\n`RELIANCE` — Reliance Industries (equity)\n`MIDCPNIFTY` — Midcap Nifty Index',
    },
  }),

  'symbol.exchange': sym({
    fieldKey: 'symbol.exchange',
    title: 'Exchange',
    category: 'Symbol Info',
    description: [
      'The exchange this symbol belongs to. **Synced from market data** and cannot be edited. Determines which exchange\'s trading hours, holidays, and rules apply.',
    ],
    example: {
      title: 'Common Mappings',
      content:
        'NIFTY, BANKNIFTY, RELIANCE → `NSE`\nCRUDEOIL, GOLD, SILVER → `MCX`\nUSDBINR → `CDS`',
    },
  }),

  'symbol.indexSymbol': sym({
    fieldKey: 'symbol.indexSymbol',
    title: 'Index Symbol',
    category: 'Symbol Info',
    description: [
      'The underlying index symbol used for spot price reference. **Synced from market data** and cannot be edited.',
      'For index derivatives (NIFTY, BANKNIFTY options), this is the index itself. For stock options, this may reference the equity symbol.',
    ],
  }),

  'symbol.isIndex': sym({
    fieldKey: 'symbol.isIndex',
    title: 'Type (Index/Stock)',
    category: 'Symbol Info',
    description: [
      'Indicates whether this symbol is an **Index** or a **Stock**. Synced from market data.',
      'Index symbols (NIFTY, BANKNIFTY) have F&O derivatives but no equity segment. Stock symbols (RELIANCE, TCS) may have both equity and F&O segments.',
    ],
  }),

  'symbol.strikeGap': sym({
    fieldKey: 'symbol.strikeGap',
    title: 'Strike Gap',
    category: 'Symbol Info',
    description: [
      'The price difference between consecutive option strike prices. **Synced from market data** and cannot be edited.',
      'This determines the granularity of available option strikes. Smaller strike gaps mean more strike choices.',
    ],
    example: {
      title: 'Common Strike Gaps',
      content:
        '`NIFTY`: 50 (strikes at 18000, 18050, 18100...)\n`BANKNIFTY`: 100 (strikes at 45000, 45100, 45200...)\n`FINNIFTY`: 50\n`MIDCPNIFTY`: 25',
    },
  }),

  'symbol.freezeLimitQty': sym({
    fieldKey: 'symbol.freezeLimitQty',
    title: 'Freeze Limit (Qty)',
    category: 'Symbol Info',
    description: [
      'The exchange-mandated **freeze quantity** — the maximum number of units (not lots) allowed in a single order before it triggers exchange-level scrutiny. **Synced from market data**.',
      'Orders exceeding freeze quantity get held for manual exchange approval, causing significant delays. The RMS `enableFreezeQtyCheck` setting uses this value to preemptively block oversized orders.',
    ],
    example: {
      title: 'Common Freeze Quantities',
      content:
        '`NIFTY` options: 1800 units (72 lots × 25 lot size)\n`BANKNIFTY` options: 900 units (60 lots × 15 lot size)\nThese values are updated by the exchange periodically.',
    },
    relatedFields: ['symbolBrokerConfig.freezeLimitQty'],
  }),

  'symbol.contractMultiplier': sym({
    fieldKey: 'symbol.contractMultiplier',
    title: 'Contract Multiplier',
    category: 'Symbol Info',
    description: [
      'The multiplier applied to the contract price to determine the actual monetary value. **Synced from market data**.',
      'For most equity/index derivatives, this equals the lot size. For commodities, it may differ based on the underlying unit (e.g., barrels, grams).',
    ],
  }),

  // ==================== CONFIGURABLE FIELDS ====================

  'symbol.maxOptionChainLevels': sym({
    fieldKey: 'symbol.maxOptionChainLevels',
    title: 'Max OC Levels',
    category: 'Configuration',
    description: [
      'The maximum number of **option chain levels** to fetch and display for this symbol. This controls how many strikes above and below the ATM (at-the-money) strike are loaded.',
      'Higher values load more strikes but consume more memory and API bandwidth. Lower values are faster but may miss far OTM/ITM strikes.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `20`. If NIFTY ATM is 18000 with strike gap 50, the system loads 20 strikes above (18050 to 19000) and 20 strikes below (17950 to 17000) = 41 total strikes.',
    },
    defaultValue: 'Varies by symbol',
    validValues: ['Range: 1 to 50'],
  }),

  'symbol.straddleMaxPremiumDiff': sym({
    fieldKey: 'symbol.straddleMaxPremiumDiff',
    title: 'Straddle Max Premium Diff',
    category: 'Configuration',
    description: [
      'Maximum allowed **premium difference** (in INR) between the call and put side of a straddle for ATM strike identification. When the premium difference between a CE and PE at the same strike exceeds this value, that strike is not considered a valid ATM straddle.',
      'Used by the system to find the true ATM strike where call and put premiums are approximately equal.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `50`. At strike 18000: CE premium = 200, PE premium = 180. Difference = 20 (< 50), so this is a valid ATM straddle. At strike 18100: CE premium = 120, PE premium = 250. Difference = 130 (> 50), so this is not considered ATM.',
    },
    validValues: ['Range: 1 to 200, step: 5'],
  }),

  'symbol.hedgeStrikeRoundingMultiple': sym({
    fieldKey: 'symbol.hedgeStrikeRoundingMultiple',
    title: 'Hedge Strike Rounding',
    category: 'Configuration',
    description: [
      'The **rounding multiple** used when calculating hedge strike prices. Hedge strikes are rounded to the nearest multiple of this value to ensure they align with available exchange strikes.',
      'Set to `0` to disable rounding (use the exact calculated strike).',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `100` for NIFTY. If the calculated hedge strike is 17,870, it rounds to 17,900 (nearest 100). This ensures the hedge order targets a strike that actually exists on the exchange.',
    },
    validValues: ['Range: 0 to 1000, step: 50'],
    defaultValue: 'Varies by symbol',
  }),

  // ==================== EXPIRY FLAGS ====================

  'symbol.hasOptionsWeeklyExpiry': sym({
    fieldKey: 'symbol.hasOptionsWeeklyExpiry',
    title: 'Options Weekly Expiry',
    category: 'Expiry Configuration',
    description: [
      'Whether this symbol has **weekly option expiry** contracts available. Synced from market data and cannot be edited.',
      'Symbols with weekly expiry have options expiring every Thursday (or the previous trading day if Thursday is a holiday).',
    ],
    example: {
      title: 'Examples',
      content:
        'NIFTY, BANKNIFTY, FINNIFTY — have weekly options expiry.\nMost stock options — only monthly expiry.',
    },
  }),

  'symbol.hasOptionsMonthlyExpiry': sym({
    fieldKey: 'symbol.hasOptionsMonthlyExpiry',
    title: 'Options Monthly Expiry',
    category: 'Expiry Configuration',
    description: [
      'Whether this symbol has **monthly option expiry** contracts available. Synced from market data. Most F&O symbols have at least monthly expiry.',
    ],
  }),

  'symbol.hasFuturesWeeklyExpiry': sym({
    fieldKey: 'symbol.hasFuturesWeeklyExpiry',
    title: 'Futures Weekly Expiry',
    category: 'Expiry Configuration',
    description: [
      'Whether this symbol has **weekly futures** contracts available. Synced from market data. Weekly futures are less common than weekly options.',
    ],
  }),

  'symbol.hasFuturesMonthlyExpiry': sym({
    fieldKey: 'symbol.hasFuturesMonthlyExpiry',
    title: 'Futures Monthly Expiry',
    category: 'Expiry Configuration',
    description: [
      'Whether this symbol has **monthly futures** contracts available. Synced from market data. Standard F&O symbols typically have current, next, and far month futures.',
    ],
  }),

  // ==================== SYMBOL BROKER CONFIG ====================

  'symbolBrokerConfig.broker': sym({
    fieldKey: 'symbolBrokerConfig.broker',
    title: 'Broker',
    category: 'Symbol Broker Config',
    description: [
      'The broker for which this symbol-specific configuration applies. Each symbol can have different configurations per broker (e.g., different freeze quantities).',
      'The broker is **immutable** after creation — to change it, delete and recreate the configuration.',
    ],
    relatedFields: ['symbolBrokerConfig.freezeLimitQty'],
  }),

  'symbolBrokerConfig.freezeLimitQty': sym({
    fieldKey: 'symbolBrokerConfig.freezeLimitQty',
    title: 'Freeze Limit (Qty)',
    category: 'Symbol Broker Config',
    description: [
      'The broker-specific **freeze quantity** for this symbol. This overrides the exchange-level freeze limit when a specific broker has different limits.',
      'The RMS freeze quantity check uses this value (when set) instead of the exchange default. Orders exceeding this quantity are pre-emptively rejected to avoid exchange-level freeze holds.',
    ],
    example: {
      title: 'Example',
      content:
        'Exchange freeze limit for NIFTY options is 1800 units. But broker X allows max 900 units per order. Set broker freeze limit to `900` so the system splits orders appropriately.',
    },
    defaultValue: '1800',
    relatedFields: ['symbol.freezeLimitQty'],
  }),
};
