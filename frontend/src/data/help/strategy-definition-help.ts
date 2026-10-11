import type { HelpArticle } from '@/types/help';

const sd = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const strategyDefinitionHelpContent: Record<string, HelpArticle> = {
  // ==================== BASIC INFORMATION ====================

  'strategyDef.strategyName': sd({
    fieldKey: 'strategyDef.strategyName',
    title: 'Strategy Name',
    category: 'Basic Information',
    description: [
      'Unique identifier for the strategy across the system. Used as the primary reference in subscriptions, config trees, tranch schedules, indicator rules, and all trading operations.',
      'Must contain only **alphanumeric characters, hyphens (-), and underscores (_)**. No spaces or special characters.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Use descriptive names: `NIFTY_STRADDLE_INTRADAY`, `BNF_IRON_FLY_WEEKLY`, `MIDCAP_MOMENTUM_V2`. Include the symbol, strategy type, and variant for clarity.',
    },
    warning:
      'Cannot be changed after creation. All subscriptions, config trees, and tranch schedules reference this name.',
  }),

  'strategyDef.displayName': sd({
    fieldKey: 'strategyDef.displayName',
    title: 'Display Name',
    category: 'Basic Information',
    description: [
      'A user-friendly name shown in the UI. Unlike the strategy name (which is a system identifier), this can contain spaces and readable text.',
    ],
    example: {
      title: 'Example',
      content:
        'Strategy name: `NIFTY_STRADDLE_INTRADAY` → Display name: "Nifty Straddle (Intraday)"',
    },
  }),

  'strategyDef.templateName': sd({
    fieldKey: 'strategyDef.templateName',
    title: 'Strategy Engine (derived)',
    category: 'Strategy Engine',
    description: [
      'The engine that runs this strategy is **derived automatically** from what you describe — trade mode, direction settings, indicator gating, combo legs. You never pick a generic engine by hand; this field shows the result and updates live as you fill in the form.',
      'The **only** manual choice is the optional *Custom logic* picker below it, and it lists only strategies with bespoke coded logic (**Sixth Sense**, **ZeroDT**). Everything non-coded derives. Even a custom pick is validated against the rest of your settings — choosing custom logic that cannot run your configuration is rejected with an explanation.',
      'If the field shows a warning instead of an engine name, the settings describe something no engine can run yet — the message says exactly what is unsupported.',
    ],
    example: {
      title: 'How Derivation Works',
      content:
        'Trade mode OPTION_SELLING, non-directional → **Advanced Options**. Add "gate entries on indicator rules" → **Indicator Advanced Options**. Directional + N-Bars breakout + max re-entries → **Adaptive Options**. Multi-leg combo (Futures + Option hedge) → **Advanced Options** (the ComboSpec decides the shape; the engine just runs it).',
    },
    relatedFields: ['strategyDef.tradeMode', 'strategyDef.isDirectional', 'strategyDef.comboSpec'],
    warning:
      'The engine derives from your settings, so changing trade mode / direction / indicator gating after configuring the strategy tree can move the strategy to a different engine. The field always shows the current result.',
  }),

  'strategyDef.comboSpec': sd({
    fieldKey: 'strategyDef.comboSpec',
    title: 'Multi-leg Combo',
    category: 'What It Trades',
    description: [
      'Declares a strategy whose legs span **instruments or products**. Combo shapes are picked directly in the **Trade Mode** dropdown — **Long Equity + Short Futures**, **Futures + Options**, **Covered Call**, **Protective Put** — and picking one creates that shape’s legs here. Picking a plain trade mode removes them.',
      '**Strike sources follow one rule**: a hedge leg\u2019s strike comes from the hedge-distance settings; a MAIN option leg\u2019s strike (the covered call\u2019s sold call) comes from the tranch Strike Type / Strike Value — so the covered call is the one combo whose strike block stays visible in the strategy config tree.',
      '**Direction is declared per leg** in the combo — a long/short pair holds both directions at once — so the strategy-level Directional flag and direction providers do not apply and are disabled.',
      'For **Futures + Option hedge**: the option leg needs no configuration. Its CE/PE derives from the futures direction (protection for a SHORT future is a CE above spot; for a LONG future a PE below), and its **strike comes from the strategy\u2019s hedge-distance settings** — the same fields hedged option selling uses. Strike types (MoneyNess) are a main-leg concept and never apply to hedges.',
      '**SL/Target percentages change meaning for combos**: they apply to the MAIN leg and are % of its **price** (a futures price, not an option premium). Combined SL measures the whole combo\u2019s net MTM against the main leg\u2019s entry value — for pairs, combined SL is the risk control that matters.',
    ],
    example: {
      title: 'Futures + Option Hedge on MCX Crude',
      content:
        'Trade mode FUTURES_OPTIONS, Expiry MONTHLY, Underlying Type FUTURE, trade mode "Futures + Options" (short future + long CE by default), hedge distance 4% on the definition, tranch SL/target as % of the futures price, tick trigger enabled (combined SL evaluates on ticks). Entry buys the option hedge first; exit takes the future out first and the hedge follows automatically.',
    },
    relatedFields: ['strategyDef.templateName', 'strategyDef.hedgeDistancePercentage', 'strategyDef.entryLegOrder'],
    warning:
      'The option hedge expires on the option calendar — on MCX a few days before the future — so a positional combo carries a short unhedged tail near expiry. Monthly expiry keeps hedge and future aligned; weekly hedges under a positional future expire mid-position and are not re-hedged automatically.',
  }),

  'strategyDef.entryLegOrder': sd({
    fieldKey: 'strategyDef.entryLegOrder',
    title: 'Entry Leg Order',
    category: 'Direction & Execution',
    description: [
      'Which leg goes on the book first. Blank keeps the long-standing default, which differs by shape: **protection first** for hedged options (the bought hedge is on before any short exposure exists) and **derivative first** for combos (the futures fill is the uncertain one, so it goes on while the book is still flat).',
      'EXPOSURE_FIRST inverts protection-first, for platforms that demand the position before its protection. CASH_FIRST inverts derivative-first, for shapes where the cash side is the harder fill — a covered call sells the call only after the stock is held.',
    ],
    relatedFields: ['strategyDef.exitLegOrder', 'strategyDef.comboSpec'],
  }),

  'strategyDef.exitLegOrder': sd({
    fieldKey: 'strategyDef.exitLegOrder',
    title: 'Exit Leg Order',
    category: 'Direction & Execution',
    description: [
      'Which leg comes off first at square-off. Blank = REVERSE_ENTRY (last on, first off) — correct wherever one leg protects another, since the protection entered first and must outlive the exposure.',
      'For a **peer pair** (long/short cash-vs-futures) prefer **SAME_AS_ENTRY**: the derivative went on first because its fill was uncertain, and that has not changed by the time you want out — taking the liquid cash leg off first would strand the illiquid future.',
      'PROTECTION_LAST states the hedge intent directly regardless of entry order — useful when legs were entered across separate events (hedge replaces, re-entries).',
    ],
    relatedFields: ['strategyDef.entryLegOrder', 'strategyDef.comboSpec'],
  }),

  'strategyDef.displayOrder': sd({
    fieldKey: 'strategyDef.displayOrder',
    title: 'Display Order',
    category: 'Basic Information',
    description: [
      'Numeric ordering value used to sort strategies in the UI. Lower numbers appear first. Strategies with the same order are sorted alphabetically by name.',
    ],
    defaultValue: 'null (sorted alphabetically)',
  }),

  'strategyDef.expiryType': sd({
    fieldKey: 'strategyDef.expiryType',
    title: 'Expiry Type',
    category: 'Basic Information',
    description: [
      'The choices offered follow what the selected underlying **actually lists** (weekly/monthly flags on its Symbols entry, synced from market-data): NIFTY/SENSEX offer Weekly + Monthly; MCX contracts and stocks are Monthly only. Watchlist-driven strategies are always Monthly. An unsupported choice is also rejected at save.',
      'Determines which F&O expiry contracts the strategy trades — **weekly** or **monthly**. This affects which option chain and futures contracts are selected for order placement.',
    ],
    validValues: [
      '**WEEKLY** — Trades the current week\'s expiry. On the last day of weekly expiry, rolls to the next week. Most common for intraday strategies.',
      '**MONTHLY** — Trades the current month\'s expiry. Provides more liquidity and time value but wider strikes.',
    ],
    defaultValue: 'WEEKLY',
    relatedFields: ['strategyDef.excludeMonthlyExpiry'],
  }),

  'strategyDef.underlyingType': sd({
    fieldKey: 'strategyDef.underlyingType',
    title: 'Underlying Type',
    category: 'Basic Information',
    description: [
      'Determines whether to use the **spot/index price** or the **futures price** as the reference for strike selection and ATM calculation.',
    ],
    validValues: [
      '**INDEX** — Uses the spot/index price (e.g., Nifty 50 index value) for strike selection. Most common for index option strategies.',
      '**FUTURE** — Uses the current futures price for strike selection. Useful when futures premium is significant and you want strike selection relative to futures.',
      '**SYNTHETIC_FUTURE** — Uses synthetic future price derived from options (reserved for future use).',
    ],
    defaultValue: 'INDEX',
    example: {
      title: 'Impact on Strike Selection',
      content:
        'Nifty spot = 18000, Nifty futures = 18050. With INDEX: ATM strike = 18000. With FUTURE: ATM strike = 18050. The 50-point difference affects which strikes are selected as ATM.',
    },
  }),

  'strategyDef.excludeMonthlyExpiry': sd({
    fieldKey: 'strategyDef.excludeMonthlyExpiry',
    title: 'Exclude Monthly Expiry Week',
    category: 'Basic Information',
    description: [
      'When enabled and expiry type is WEEKLY, the strategy **skips trading during the monthly expiry week**. This is useful because monthly expiry weeks often have different volatility characteristics.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyDef.expiryType'],
    example: {
      title: 'Example',
      content:
        'Monthly expiry is the last Thursday of the month. If enabled, the strategy will not trade during that week (Monday to Thursday). It resumes on Friday or the next Monday.',
    },
  }),

  'strategyDef.usePremiumBalancing': sd({
    fieldKey: 'strategyDef.usePremiumBalancing',
    title: 'Premium Balanced Selection',
    category: 'Basic Information',
    description: [
      'When enabled, uses a **3-step premium-balanced strike selection** algorithm instead of simple ATM selection. This ensures the call and put premiums are approximately equal, which is critical for non-directional strategies like straddles.',
      'Without this, simple ATM selection may result in a premium imbalance between the CE and PE legs.',
    ],
    defaultValue: 'false',
  }),

  // ==================== INSTRUMENT & PRODUCT ====================

  'strategyDef.fnoSymbolName': sd({
    fieldKey: 'strategyDef.fnoSymbolName',
    title: 'Underlying Symbol',
    category: 'Instrument & Product',
    description: [
      'The **F&O symbol** this strategy trades. Determines which option chain is loaded, which futures contracts are available, and the lot size for position calculations.',
    ],
    example: {
      title: 'Common Symbols',
      content:
        '`NIFTY` — Nifty 50 Index (lot size 25)\n`BANKNIFTY` — Bank Nifty (lot size 15)\n`FINNIFTY` — Financial Nifty (lot size 25)\n`MIDCPNIFTY` — Midcap Nifty (lot size 50)',
    },
    relatedFields: ['strategyDef.exchange'],
  }),

  'strategyDef.exchange': sd({
    fieldKey: 'strategyDef.exchange',
    title: 'Exchange',
    category: 'Instrument & Product',
    description: [
      'The exchange this strategy operates on. **Auto-populated** based on the selected symbol. Determines market hours, holidays, and algo timing.',
    ],
    relatedFields: ['strategyDef.fnoSymbolName'],
  }),

  'strategyDef.product': sd({
    fieldKey: 'strategyDef.product',
    title: 'Product Type',
    category: 'Instrument & Product',
    description: [
      'For **multi-leg combos** this field is hidden: each leg declares its own product in the combo editor (a long/short pair holds CASHBUY and INTRADAY at once), and the strategy-level value is derived — POSITIONAL if any leg is positional, else INTRADAY.',
      'Defines whether positions are **intraday** (closed same day) or **positional** (carried overnight). This affects square-off timing, capital requirements, and margin calculations.',
    ],
    validValues: [
      '**INTRADAY** — All positions squared off before market close (at the time configured by `intradaySquareOffMinutesBeforeClose`). Uses MIS product type for lower margin.',
      '**POSITIONAL** — Positions can be carried overnight. Uses NRML product type. Requires full margin.',
      '**CASHBUY** — Cash equity buy & hold. No automatic square-off.',
    ],
    defaultValue: 'INTRADAY',
    relatedFields: ['strategyDef.hedgeReplaceEnabled'],
  }),

  'strategyDef.tradeMode': sd({
    fieldKey: 'strategyDef.tradeMode',
    title: 'Trade Mode',
    category: 'Instrument & Product',
    description: [
      'Defines **what the strategy trades** — single-instrument modes and multi-leg combo shapes side by side in one list. This is orthogonal to Product (which defines holding period); the Strategy Engine is derived from this and the rest of your settings.',
      'Picking a **combo shape** creates that shape’s legs (editable below); picking a plain mode removes any combo legs.',
    ],
    validValues: [
      '**Option Selling** — Sell/write options (straddle, strangle, directional selling). Main trades are SHORT. This is the default and matches all existing strategy behavior.',
      '**Option Buying** — Buy options (long calls, long puts, debit spreads). Main trades are LONG. Direction semantics are inverted: LONG bias = buy CE, SHORT bias = buy PE.',
      '**Futures** — Trade futures contracts (long or short based on direction). No option chain involved.',
      '**Futures + Options** *(combo)* — a futures position protected by a bought option; CE/PE follows the futures direction, strike from the hedge-distance settings.',
      '**Equity** — Cash equity / stock trading (long only).',
      '**Long Equity + Short Futures** *(combo)* — shorts the future and holds the cash equity of the same underlying.',
      '**Covered Call (Long Equity + Short Call)** *(combo)* — long stock with a sold call for income; the call’s strike comes from the tranch strike settings.',
      '**Protective Put (Long Equity + Long Put)** *(combo)* — long stock with a bought put as protection; strike from the hedge-distance settings.',
    ],
    defaultValue: 'OPTION_SELLING',
    relatedFields: ['strategyDef.product', 'strategyDef.isDirectional'],
  }),

  // ==================== TRIGGER TYPES ====================

  'strategyDef.scheduledTriggerEnabled': sd({
    fieldKey: 'strategyDef.scheduledTriggerEnabled',
    title: 'Scheduled Trigger',
    category: 'Trigger Types',
    description: [
      'When enabled, the strategy is evaluated at **specific scheduled times** defined by tranch schedules. Each tranch has a scheduled time and the engine triggers evaluation at that time.',
      'This is the most common trigger type — strategies with defined entry times use scheduled triggers.',
    ],
    defaultValue: 'true',
    relatedFields: ['strategyDef.tickTriggerEnabled', 'strategyDef.signalTriggerEnabled', 'strategyDef.periodicTriggerEnabled'],
  }),

  'strategyDef.tickTriggerEnabled': sd({
    fieldKey: 'strategyDef.tickTriggerEnabled',
    title: 'Tick Trigger',
    category: 'Trigger Types',
    description: [
      'When enabled, the strategy is evaluated on **every price tick** (real-time market data update). This enables tick-by-tick evaluation for high-frequency or breakout-style strategies.',
    ],
    defaultValue: 'false',
    warning:
      'Tick-based evaluation is computationally expensive. Only enable if the strategy logic requires real-time price monitoring.',
    relatedFields: ['strategyDef.scheduledTriggerEnabled'],
  }),

  'strategyDef.signalTriggerEnabled': sd({
    fieldKey: 'strategyDef.signalTriggerEnabled',
    title: 'Signal Trigger',
    category: 'Trigger Types',
    description: [
      'There is no external signal in this engine. Conditions on synthetic instruments are written as ordinary rules and evaluated here.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyDef.scheduledTriggerEnabled'],
  }),

  'strategyDef.periodicTriggerEnabled': sd({
    fieldKey: 'strategyDef.periodicTriggerEnabled',
    title: 'Periodic Trigger',
    category: 'Trigger Types',
    description: [
      'When enabled, the strategy is evaluated at **regular intervals** defined by `periodicIntervalMinutes`. Unlike scheduled triggers (fixed times), periodic triggers repeat at a fixed cadence.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyDef.periodicIntervalMinutes', 'strategyDef.periodicOffsetSeconds'],
  }),

  // ==================== TIMING ====================

  'strategyDef.startTime': sd({
    fieldKey: 'strategyDef.startTime',
    title: 'Start Time',
    category: 'Timing',
    description: [
      'The earliest time the strategy can place orders. No signals or orders are generated before this time, even if triggers fire. Format: **HH:mm:ss** (24-hour).',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `09:20:00`. Even if a scheduled tranch is at 09:16, the strategy waits until 09:20 to process it. This avoids trading during the volatile opening minutes.',
    },
    relatedFields: ['strategyDef.stopTime'],
  }),

  'strategyDef.stopTime': sd({
    fieldKey: 'strategyDef.stopTime',
    title: 'Stop Time',
    category: 'Timing',
    description: [
      'The latest time the strategy can place **new entry** orders. After this time, only exit orders are allowed. Format: **HH:mm:ss** (24-hour).',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `15:00:00` for an intraday strategy. No new entries after 3:00 PM. Exit/square-off orders can still be placed until the intraday square-off time.',
    },
    relatedFields: ['strategyDef.startTime'],
  }),

  'strategyDef.tradableDays': sd({
    fieldKey: 'strategyDef.tradableDays',
    title: 'Tradable Days',
    category: 'Timing',
    description: [
      'Defines which days of the week or special day types the strategy is allowed to trade. The strategy is **only active** on selected days.',
    ],
    validValues: [
      '**M** — Monday',
      '**T** — Tuesday',
      '**W** — Wednesday',
      '**TH** — Thursday',
      '**F** — Friday',
      '**E** — Expiry Day (weekly or monthly)',
      '**DT1** — Day before expiry (Expiry - 1)',
      '**DT2** — Two days before expiry (Expiry - 2)',
    ],
    example: {
      title: 'Example',
      content:
        'An expiry-day-only strategy: select only `E`. A strategy that trades Monday to Wednesday: select `M`, `T`, `W`. An everyday strategy: select all.',
    },
  }),

  'strategyDef.excludedDays': sd({
    fieldKey: 'strategyDef.excludedDays',
    title: 'Excluded Days',
    category: 'Timing',
    description: [
      'Days on which the strategy should **not** trade, acting as a blacklist. Takes precedence over tradable days — if a day is both tradable and excluded, it is excluded.',
    ],
    example: {
      title: 'Example',
      content:
        'Tradable days = all weekdays. Excluded days = `E` (expiry). Result: strategy trades every day except expiry days.',
    },
    relatedFields: ['strategyDef.tradableDays'],
  }),

  // ==================== CAPITAL & HEDGE ====================

  'strategyDef.capitalPerLot': sd({
    fieldKey: 'strategyDef.capitalPerLot',
    title: 'Capital Per Lot (Default)',
    category: 'Capital & Hedge',
    description: [
      'The **default capital** required per lot for this strategy. Used as a fallback when neither hedged nor naked capital-per-lot values are applicable.',
      'A subscription\'s capital is sized in lots of this amount: `numOfLots × capitalPerLot`.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `150000` (1.5L per lot). A user subscribed with 3 lots needs: 3 × ₹1,50,000 = ₹4,50,000 capital.',
    },
    relatedFields: ['strategyDef.capitalPerLotHedged', 'strategyDef.capitalPerLotNaked'],
  }),

  'strategyDef.capitalPerLotHedged': sd({
    fieldKey: 'strategyDef.capitalPerLotHedged',
    title: 'Capital Per Lot (Hedged)',
    category: 'Capital & Hedge',
    description: [
      'Capital required per lot when **hedging is enabled** for this strategy. Hedged positions require less margin because the hedge limits max loss.',
      'Used when the strategy\'s P0-level config has hedging enabled.',
    ],
    example: {
      title: 'Example',
      content:
        'Naked straddle: ₹2,50,000 per lot. Hedged straddle (with OTM protection): ₹1,00,000 per lot. The hedge reduces margin requirement by ~60%.',
    },
    defaultValue: '100000',
    relatedFields: ['strategyDef.capitalPerLotNaked', 'strategyDef.capitalPerLot'],
  }),

  'strategyDef.capitalPerLotNaked': sd({
    fieldKey: 'strategyDef.capitalPerLotNaked',
    title: 'Capital Per Lot (Naked)',
    category: 'Capital & Hedge',
    description: [
      'Capital required per lot when **hedging is disabled** (naked positions). Naked option selling requires significantly more margin due to unlimited risk potential.',
    ],
    defaultValue: '250000',
    relatedFields: ['strategyDef.capitalPerLotHedged', 'strategyDef.capitalPerLot'],
  }),

  'strategyDef.hedgeDistancePercentageIntraday': sd({
    fieldKey: 'strategyDef.hedgeDistancePercentageIntraday',
    title: 'Hedge % (Intraday)',
    category: 'Capital & Hedge',
    description: [
      'The **hedge distance** as a percentage of the **short trade strike price** for intraday positions. This determines how far OTM the hedge strike is placed relative to the sold strike — not from ATM.',
      'A lower percentage means the hedge is closer to the short strike (more protection, higher cost). A higher percentage means cheaper but less protective hedges.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `4.0` (4%). ATM is 25000, short CE strike is 25600. Hedge distance = 25600 × 4% = 1024 points. CE hedge placed at 26624 (rounded to nearest strike). The distance is from 25600 (short strike), not from 25000 (ATM).',
    },
    relatedFields: ['strategyDef.hedgeDistancePercentagePositional'],
  }),

  'strategyDef.hedgeDistancePercentage': sd({
    fieldKey: 'strategyDef.hedgeDistancePercentage',
    title: 'Hedge Distance',
    category: 'Capital & Hedge',
    description: [
      'The **hedge distance** as a percentage of the **short trade strike price**. This determines how far OTM the hedge strike is placed relative to the sold strike — not from ATM.',
      'A lower percentage means the hedge is closer to the short strike (more protection, higher cost). A higher percentage means cheaper but less protective hedges.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `4.0` (4%). ATM is 25000, short CE strike is 25600. Hedge distance = 25600 × 4% = 1024 points. CE hedge placed at 26624 (rounded to nearest strike). The distance is from 25600 (short strike), not from 25000 (ATM).',
    },
    relatedFields: ['strategyDef.hedgeDistancePercentageIntraday', 'strategyDef.hedgeDistancePercentagePositional'],
  }),

  'strategyDef.hedgeDistancePercentagePositional': sd({
    fieldKey: 'strategyDef.hedgeDistancePercentagePositional',
    title: 'Hedge % (Positional)',
    category: 'Capital & Hedge',
    description: [
      'The **hedge distance** as a percentage of the **short trade strike price** for positional (overnight) positions. Calculated from the sold strike, not from ATM.',
      'Typically wider than intraday hedges to account for overnight gap risk while keeping hedge cost manageable.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `8.0` (8%). Short CE strike is 25600. Hedge distance = 25600 × 8% = 2048 points. CE hedge at ~27650. Wider than intraday hedge because overnight risk is higher.',
    },
    relatedFields: ['strategyDef.hedgeDistancePercentageIntraday'],
  }),

  // ==================== RISK SETTINGS ====================

  'strategyDef.riskPercentage': sd({
    fieldKey: 'strategyDef.riskPercentage',
    title: 'Risk % of Capital',
    category: 'Risk Settings',
    description: [
      'The default **risk percentage** per day for this strategy, expressed as a percentage of allocated capital. This determines the stop-loss amount for the day.',
      'Users can override this per-subscription within the min/max bounds.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `1.5` (1.5%). User allocated ₹10,00,000. Daily risk = ₹10,00,000 × 1.5% = ₹15,000. If the strategy loses ₹15,000, it stops trading for the day.',
    },
    relatedFields: ['strategyDef.absoluteMaxRisk', 'strategyDef.minRiskPercentage', 'strategyDef.maxRiskPercentage'],
  }),

  'strategyDef.absoluteMaxRisk': sd({
    fieldKey: 'strategyDef.absoluteMaxRisk',
    title: 'Absolute Max Risk (₹)',
    category: 'Risk Settings',
    description: [
      'An alternative to percentage-based risk — sets the **absolute maximum risk amount** in INR per day. When set, this takes precedence over the percentage calculation.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `25000` (₹25,000). Regardless of capital allocated, the max daily loss for this strategy is ₹25,000.',
    },
    relatedFields: ['strategyDef.riskPercentage'],
  }),

  'strategyDef.minRiskPercentage': sd({
    fieldKey: 'strategyDef.minRiskPercentage',
    title: 'Min Risk %',
    category: 'Risk Settings',
    description: [
      'The **floor** for user risk override. Users cannot set their per-subscription risk percentage below this value. Prevents users from setting unrealistically tight stops.',
    ],
    relatedFields: ['strategyDef.maxRiskPercentage', 'strategyDef.riskPercentage'],
  }),

  'strategyDef.maxRiskPercentage': sd({
    fieldKey: 'strategyDef.maxRiskPercentage',
    title: 'Max Risk %',
    category: 'Risk Settings',
    description: [
      'The **ceiling** for user risk override. Users cannot set their per-subscription risk percentage above this value. Prevents excessive risk-taking.',
    ],
    relatedFields: ['strategyDef.minRiskPercentage', 'strategyDef.riskPercentage'],
  }),

  'strategyDef.portfolioSLPercentage': sd({
    fieldKey: 'strategyDef.portfolioSLPercentage',
    title: 'Portfolio SL %',
    category: 'Risk Settings',
    description: [
      'Portfolio-level **stop-loss** as a percentage of capital. When the combined P&L of all positions in this strategy hits this loss threshold, all positions are exited.',
      'TODO: Confirm exact interaction with per-trade SL from strategy config tree.',
    ],
    relatedFields: ['strategyDef.portfolioTargetPercentage'],
  }),

  'strategyDef.portfolioTargetPercentage': sd({
    fieldKey: 'strategyDef.portfolioTargetPercentage',
    title: 'Portfolio Target %',
    category: 'Risk Settings',
    description: [
      'Portfolio-level **target** as a percentage of capital. When the combined P&L of all positions in this strategy reaches this profit threshold, all positions are exited to lock in gains.',
      'TODO: Confirm exact interaction with per-trade target from strategy config tree.',
    ],
    relatedFields: ['strategyDef.portfolioSLPercentage'],
  }),

  // ==================== OPTIONS & ADVANCED ====================

  'strategyDef.catchUpMissedTranches': sd({
    fieldKey: 'strategyDef.catchUpMissedTranches',
    title: 'Catch Up Missed Tranches',
    category: 'Advanced Options',
    description: [
      'When enabled, if the strategy missed scheduled tranch times, it will **attempt to execute those missed tranches** when the strategy becomes active again, provided the market is still open.',
      'This applies when the engine was down, the strategy was inactive, or when the strategy transitions from **wind-down back to active** state — any missed tranches in the current session will be caught up.',
    ],
    defaultValue: 'false',
    warning:
      'Missed tranches are executed with a **1-minute gap** between each, not all at once. Ensure risk controls are adequate for multiple sequential entries.',
  }),

  'strategyDef.adaptiveTranchesEnabled': sd({
    fieldKey: 'strategyDef.adaptiveTranchesEnabled',
    title: 'Adaptive Tranches Enabled',
    category: 'Advanced Options',
    description: [
      'When enabled, activates the **adaptive/cascading tranch mode**. Instead of fixed scheduled tranches, the next tranch is triggered dynamically based on the outcome of the previous tranch.',
      'Used by the **Zero-DT (0DTE) Options** evaluator. After each tranch completes, the engine evaluates whether to trigger the next tranch based on these rules:',
      '- **Stop** if 3 or more tranches resulted in a loss.',
      '- **Stop** if 3 or more tranches resulted in a profit.',
      '- **Stop** if 5 tranches have already been completed (maximum limit).',
      '- **Stop** if the current time is past the strategy\'s stop time.',
      '- Otherwise, **trigger the next tranch** immediately.',
    ],
    defaultValue: 'false',
    example: {
      title: 'Example',
      content:
        'Tranch 1: Loss, Tranch 2: Profit, Tranch 3: Loss, Tranch 4: Profit → triggers Tranch 5 (2 losses, 2 profits — both below the 3 limit).\nTranch 1: Loss, Tranch 2: Loss, Tranch 3: Loss → STOPS (3 loss tranches reached).',
    },
  }),

  'strategyDef.periodicIntervalMinutes': sd({
    fieldKey: 'strategyDef.periodicIntervalMinutes',
    title: 'Periodic Interval (minutes)',
    category: 'Advanced Options',
    description: [
      'The interval in minutes at which the strategy is re-evaluated when **periodic trigger** is enabled. Must be between 1 and 240 minutes.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `5`. The strategy is evaluated every 5 minutes: 9:20, 9:25, 9:30, ... This is useful for strategies that need regular re-evaluation but not tick-by-tick.',
    },
    relatedFields: ['strategyDef.periodicTriggerEnabled', 'strategyDef.periodicOffsetSeconds'],
    validValues: ['Range: 1 to 240 minutes'],
  }),

  'strategyDef.periodicOffsetSeconds': sd({
    fieldKey: 'strategyDef.periodicOffsetSeconds',
    title: 'Periodic Offset (seconds)',
    category: 'Advanced Options',
    description: [
      'An offset in seconds after the minute boundary for periodic trigger execution. Useful to avoid executing exactly on the minute when many other systems may also be active.',
    ],
    example: {
      title: 'Example',
      content:
        'Interval = 5 min, offset = 5 sec. Evaluations at 9:20:05, 9:25:05, 9:30:05 instead of exactly on the minute.',
    },
    defaultValue: '0',
    validValues: ['Range: 0 to 15 seconds'],
    relatedFields: ['strategyDef.periodicIntervalMinutes'],
  }),

  'strategyDef.isOverlapCapital': sd({
    fieldKey: 'strategyDef.isOverlapCapital',
    title: 'Overlap Capital',
    category: 'Advanced Options',
    description: [
      'When enabled, this strategy\'s capital is **not counted** toward an account\'s total. This is used for strategies that share margin with other strategies (e.g., hedges that reduce margin on the main position).',
    ],
    defaultValue: 'false',
  }),

  'strategyDef.isDirectional': sd({
    fieldKey: 'strategyDef.isDirectional',
    title: 'Directional',
    category: 'Advanced Options',
    description: [
      'When enabled, the strategy takes **directional bets** (bullish or bearish) rather than non-directional positions (like straddles). Requires a direction provider to determine whether to go long or short.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyDef.directionProviderType'],
  }),

  'strategyDef.isPublic': sd({
    fieldKey: 'strategyDef.isPublic',
    title: 'Public',
    category: 'Advanced Options',
    description: [
      'Controls strategy **visibility**. Public strategies are visible to all users in the system. Private strategies are only visible to admins and the creator.',
    ],
    defaultValue: 'false',
  }),

  'strategyDef.scope': sd({
    fieldKey: 'strategyDef.scope',
    title: 'Scope',
    category: 'Advanced Options',
    description: [
      'Defines how users can subscribe to this strategy.',
    ],
    validValues: [
      '**SYSTEM** — Admin-managed. Only admins can assign this strategy to users via subscriptions.',
      '**USER** — User self-service. Users can discover and subscribe to this strategy themselves (if public).',
    ],
    defaultValue: 'SYSTEM',
  }),

  'strategyDef.status': sd({
    fieldKey: 'strategyDef.status',
    title: 'Strategy Status',
    category: 'Advanced Options',
    description: [
      'Controls what operations are allowed for this strategy.',
    ],
    validValues: [
      '**ACTIVE** — Full operation. New trades, hedge operations, and exits are all allowed.',
      '**WIND_DOWN** — No new trades allowed. Only hedge adjustments and exit operations proceed. Use this to gracefully wind down a strategy.',
      '**INACTIVE** — Completely stopped. No operations at all. Subscriptions remain but are dormant.',
    ],
    defaultValue: 'ACTIVE',
  }),

  // ==================== HEDGE REPLACE ====================

  'strategyDef.hedgeReplaceEnabled': sd({
    fieldKey: 'strategyDef.hedgeReplaceEnabled',
    title: 'Hedge Replace Enabled',
    category: 'Hedge Replace',
    description: [
      'Enables **hedge replacement windows** for positional strategies. When enabled, the system can roll/replace hedges during defined morning and evening windows to manage overnight hedge decay.',
      'Only applicable to **POSITIONAL** product type strategies.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyDef.hedgeMorningStartOffset', 'strategyDef.hedgeEveningStartOffset'],
  }),

  'strategyDef.hedgeMorningStartOffset': sd({
    fieldKey: 'strategyDef.hedgeMorningStartOffset',
    title: 'Morning Start (min after open)',
    category: 'Hedge Replace',
    description: [
      'Minutes **after market open** when the morning hedge replacement window starts. During this window, the system checks if hedges need to be rolled or replaced.',
    ],
    defaultValue: '1',
    example: {
      title: 'Example',
      content:
        'Set to `1`. Market opens at 9:15. Morning hedge window starts at 9:16. The system checks existing hedges and replaces any that have decayed significantly overnight.',
    },
    relatedFields: ['strategyDef.hedgeMorningEndOffset'],
  }),

  'strategyDef.hedgeMorningEndOffset': sd({
    fieldKey: 'strategyDef.hedgeMorningEndOffset',
    title: 'Morning End (min after open)',
    category: 'Hedge Replace',
    description: [
      'Minutes **after market open** when the morning hedge replacement window ends.',
    ],
    defaultValue: '15',
    relatedFields: ['strategyDef.hedgeMorningStartOffset'],
  }),

  'strategyDef.hedgeEveningStartOffset': sd({
    fieldKey: 'strategyDef.hedgeEveningStartOffset',
    title: 'Evening Start (min before close)',
    category: 'Hedge Replace',
    description: [
      'Minutes **before market close** when the evening hedge replacement window starts. Used to ensure hedges are in place before the close for overnight protection.',
    ],
    defaultValue: '10',
    relatedFields: ['strategyDef.hedgeEveningEndOffset'],
  }),

  'strategyDef.hedgeEveningEndOffset': sd({
    fieldKey: 'strategyDef.hedgeEveningEndOffset',
    title: 'Evening End (min before close)',
    category: 'Hedge Replace',
    description: [
      'Minutes **before market close** when the evening hedge replacement window ends.',
    ],
    defaultValue: '2',
    relatedFields: ['strategyDef.hedgeEveningStartOffset'],
  }),

  // ==================== DIRECTION PROVIDER ====================

  'strategyDef.directionProviderType': sd({
    fieldKey: 'strategyDef.directionProviderType',
    title: 'Direction Provider Type',
    category: 'Direction Provider',
    description: [
      'The method used to determine **trade direction** (LONG/SHORT) for directional strategies. Only applicable when `Directional` is enabled.',
    ],
    validValues: [
      '**CANDLE** — Uses candle price comparison (e.g., if current price > market open price → LONG).',
      '**PCR** — Uses Put-Call Ratio for direction. Supports **Threshold** mode (PCR vs static value) and **Trend** mode (current PCR vs PCR from N minutes ago).',
      '**IV_SKEW** — Uses Implied Volatility skew between calls and puts.',
      '**INDICATOR** — Uses indicator-based direction rules defined in the Indicator Rules tab. Direction is determined by evaluating LONG/SHORT rule conditions.',
      '**EXTERNAL** — Direction provided by external signal.',
      '**FIXED** — Always the same direction (configured in parameters).',
    ],
    relatedFields: ['strategyDef.isDirectional', 'indicatorRule.directionRules'],
  }),

  // ==================== EQUITY (STOCK UNIVERSE / LEVERAGE / SIZING) ====================

  'strategyDef.universeId': sd({
    fieldKey: 'strategyDef.universeId',
    title: 'Stock Watchlist (Universe)',
    category: 'What It Trades',
    description: [
      'The **stock watchlist (universe)** this strategy trades — either a predefined NSE index list (NIFTY 50, NIFTY 500, F&O stocks, …) or a custom list managed on the Stock Universes page.',
      'Available to **every trade mode**, not just Equity: an option-selling strategy over a watchlist sells each stock\u2019s options, a futures strategy trades each stock\u2019s futures, a covered-call combo runs one combo per stock. The strategy evaluates the members in list order each cycle; for F&O/combo modes at most **Max Active Positions** members enter per tranch, each sized with an equal share of capital.',
      'A member stock must have a **Symbols page entry** (SYMBOL_INFO row: strike gap, expiry flags) to trade derivatives — members without one are skipped with a warning. Stock derivatives are **monthly-expiry only**.',
      'Predefined index universes are refreshed daily from NSE constituent files.',
    ],
    relatedFields: ['strategyDef.underlyingSource', 'strategyDef.maxActivePositions', 'strategyDef.onIndexRemoval', 'strategyDef.equitySizingModel'],
  }),

  'strategyDef.underlyingSource': sd({
    fieldKey: 'strategyDef.underlyingSource',
    title: 'Underlyings',
    category: 'What It Trades',
    description: [
      'What the strategy trades on: **Indices / Contracts** (a single underlying — NIFTY, SENSEX, an MCX contract) or **Stocks** (a watchlist of cash-market stocks, one evaluation per member).',
      'Shapes with a cash-equity leg — Equity, Long Equity + Short Futures, Covered Call, Protective Put — have no index form, so they lock to Stocks. Option Selling/Buying, Futures and Futures + Options offer the choice.',
      'Choosing Stocks sets Expiry Type to **Monthly** (stock derivatives have no weekly expiries) and requires **Max Active Positions**, which caps entries per tranch and defines the per-stock capital share.',
    ],
    relatedFields: ['strategyDef.universeId', 'strategyDef.fnoSymbolName', 'strategyDef.maxActivePositions'],
  }),

  'strategyDef.leverage': sd({
    fieldKey: 'strategyDef.leverage',
    title: 'Leverage',
    category: 'Equity Settings',
    description: [
      'The strategy-level **default leverage** applied to allocated capital, giving the buying power used by the sizing models (buying power = capital × leverage).',
      '**Cash Buy (CNC)** is always forced to 1×. Intraday and MTF honour the configured leverage. Users may override per subscription, clamped to the min/max bounds.',
    ],
    example: {
      title: 'Example',
      content: 'Capital ₹10,00,000 with 2× leverage → ₹20,00,000 buying power spread across universe entries.',
    },
    relatedFields: ['strategyDef.minLeverage', 'strategyDef.maxLeverage', 'strategyDef.equitySizingModel'],
  }),

  'strategyDef.minLeverage': sd({
    fieldKey: 'strategyDef.minLeverage',
    title: 'Min Leverage',
    category: 'Equity Settings',
    description: [
      'The **floor** for a per-subscription leverage override. A user-supplied leverage below this is clamped up to this value.',
    ],
    relatedFields: ['strategyDef.leverage', 'strategyDef.maxLeverage'],
  }),

  'strategyDef.maxLeverage': sd({
    fieldKey: 'strategyDef.maxLeverage',
    title: 'Max Leverage',
    category: 'Equity Settings',
    description: [
      'The **ceiling** for a per-subscription leverage override. A user-supplied leverage above this is clamped down to this value.',
    ],
    relatedFields: ['strategyDef.leverage', 'strategyDef.minLeverage'],
  }),

  'strategyDef.equitySizingModel': sd({
    fieldKey: 'strategyDef.equitySizingModel',
    title: 'Sizing Model',
    category: 'Equity Settings',
    description: [
      'How the quantity for each stock entry is computed from capital and leverage.',
    ],
    validValues: [
      '**Fixed Amount Per Stock** — invest a fixed rupee amount in every stock entered (quantity = amount / price).',
      '**Max Positions Equal Split** — split buying power equally across a maximum number of concurrent positions (quantity = capital × leverage / maxPositions / price).',
      '**Max Risk Per Trade** — size from a per-trade risk budget and the stop distance (quantity = capital × risk% / stop distance, capped by buying power).',
    ],
    relatedFields: ['strategyDef.fixedAmountPerStock', 'strategyDef.maxActivePositions', 'strategyDef.maxRiskPctPerTrade', 'strategyDef.leverage'],
  }),

  'strategyDef.fixedAmountPerStock': sd({
    fieldKey: 'strategyDef.fixedAmountPerStock',
    title: 'Fixed Amount Per Stock (₹)',
    category: 'Equity Settings',
    description: [
      'For the **Fixed Amount Per Stock** sizing model: the rupee amount invested in each stock entry. Quantity = amount / stock price (floor).',
    ],
    relatedFields: ['strategyDef.equitySizingModel'],
  }),

  'strategyDef.maxActivePositions': sd({
    fieldKey: 'strategyDef.maxActivePositions',
    title: 'Max Active Positions',
    category: 'Equity Settings',
    description: [
      'For the equity **Max Positions Equal Split** sizing model: the maximum number of concurrent stock positions. Buying power is split equally across this many slots, and the cap is enforced — no new entries once this many positions are open.',
      'For **watchlist-driven F&O/combo strategies** it is required and plays the same double role: at most this many member stocks enter per tranch, and each member is sized with an equal share of capital (capital ÷ this). Without it the engine refuses to fan out.',
    ],
    example: {
      title: 'Example',
      content: 'Capital ₹10,00,000, 10 max positions, 2× leverage → ₹2,00,000 per stock. A ₹100 stock gets quantity 2000.',
    },
    relatedFields: ['strategyDef.equitySizingModel', 'strategyDef.leverage'],
  }),

  'strategyDef.maxRiskPctPerTrade': sd({
    fieldKey: 'strategyDef.maxRiskPctPerTrade',
    title: 'Max Risk % Per Trade',
    category: 'Equity Settings',
    description: [
      'For the **Max Risk Per Trade** sizing model: the percentage of capital risked on each trade. Quantity = risk budget / stop distance, capped by buying power.',
    ],
    example: {
      title: 'Example',
      content: 'Capital ₹10,00,000 at 1% risk → ₹10,000 budget. Entry ₹100, stop ₹95 → risk ₹5/share → quantity 2000.',
    },
    relatedFields: ['strategyDef.equitySizingModel'],
  }),

  'strategyDef.onIndexRemoval': sd({
    fieldKey: 'strategyDef.onIndexRemoval',
    title: 'On Index Removal',
    category: 'Equity Settings',
    description: [
      'What to do with an **open position** when its stock is removed from a predefined index universe during the daily refresh (index reconstitution). New entries on removed symbols always stop.',
    ],
    validValues: [
      '**Hold Until Exit** — keep the position; normal exit logic (SL/target/EOD) runs its course.',
      '**Exit Immediately** — square off the position on the next refresh cycle that detects the removal.',
    ],
    relatedFields: ['strategyDef.universeId'],
  }),
};
