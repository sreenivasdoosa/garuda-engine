import type { HelpArticle } from '@/types/help';

const sc = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const strategyConfigTreeHelpContent: Record<string, HelpArticle> = {
  // ==================== SCOPE ====================

  'strategyConfig.strategy': sc({
    fieldKey: 'strategyConfig.strategy',
    title: 'Strategy',
    category: 'Config Scope',
    description: [
      'The **strategy definition** this configuration applies to. Every config entry must be associated with exactly one strategy.',
    ],
    warning: 'Cannot be changed after creation.',
  }),

  'strategyConfig.cloneFrom': sc({
    fieldKey: 'strategyConfig.cloneFrom',
    title: 'Clone From',
    category: 'Config Scope',
    description: [
      'Copy all configuration values from another strategy\'s **P0 Base** config. This is a one-time copy — subsequent changes to the source config do not propagate.',
      'Only P0 Base configs (no user/broker/tranch/day overrides) from other strategies are available to clone from.',
    ],
    example: {
      title: 'Example',
      content:
        'Creating a new `BNF_STRADDLE_V2` strategy and want the same SL/Target/Trail settings as `NIFTY_STRADDLE`. Clone from NIFTY_STRADDLE\'s P0 Base config, then customize only the strike selection.',
    },
  }),

  'strategyConfig.user': sc({
    fieldKey: 'strategyConfig.user',
    title: 'User',
    category: 'Config Scope',
    description: [
      'Select a user to create a **user-level override** for this strategy. Adds **+16** to the config priority.',
      'Leave empty for a strategy-level default that applies to all users.',
    ],
    example: {
      title: 'Example',
      content:
        'Strategy P0 Base has SL=25%. Setting user-level override for "john" with SL=20% means john gets 20% SL while all other users get 25%.',
    },
    relatedFields: ['strategyConfig.broker', 'strategyConfig.tranchNumber', 'strategyConfig.dayCondition'],
  }),

  'strategyConfig.broker': sc({
    fieldKey: 'strategyConfig.broker',
    title: 'Broker',
    category: 'Config Scope',
    description: [
      'Select a broker to create a **broker-level override**. Adds **+8** to the config priority. Only shows brokers mapped to the selected user.',
      'Requires a user to be selected first.',
    ],
    relatedFields: ['strategyConfig.user'],
  }),

  'strategyConfig.tranchNumber': sc({
    fieldKey: 'strategyConfig.tranchNumber',
    title: 'Tranch Number',
    category: 'Config Scope',
    description: [
      'Specify a tranch number to create a **tranch-specific override**. Adds **+4** to the config priority.',
      '**0 or empty** = applies to all tranches / non-tranch mode. Enter **1, 2, 3...** for specific tranch configuration.',
      'Only available when the selected strategy supports tranches.',
    ],
    example: {
      title: 'Example',
      content:
        'Tranch 1 at 9:20 with SL=30% (more aggressive early), Tranch 3 at 11:00 with SL=20% (tighter after trend establishes).',
    },
    relatedFields: ['strategyConfig.tranchTiming', 'strategyConfig.tranchCutoffTime', 'strategyConfig.lotsPerTranch'],
  }),

  'strategyConfig.dayCondition': sc({
    fieldKey: 'strategyConfig.dayCondition',
    title: 'Day Condition',
    category: 'Config Scope',
    description: [
      'Apply this configuration only on **specific days**. Adds **+2** to the config priority.',
      'Supports both day-of-week (Monday through Friday) and expiry-related conditions (Expiry Day, DT-1, DT-2).',
    ],
    validValues: [
      '**E** — Expiry Day',
      '**DT1** — Day before expiry (DT-1)',
      '**DT2** — Two days before expiry (DT-2)',
      '**M** — Monday',
      '**T** — Tuesday',
      '**W** — Wednesday',
      '**TH** — Thursday',
      '**F** — Friday',
    ],
    example: {
      title: 'Example',
      content:
        'Expiry day (E): tighten SL to 20% and disable re-entry. DT-1: switch to aggressive strike selection.',
    },
  }),

  // ==================== HEDGING ====================

  'strategyConfig.hedgingEnabled': sc({
    fieldKey: 'strategyConfig.hedgingEnabled',
    title: 'Hedging',
    category: 'Hedging Configuration',
    description: [
      'Enable or disable **automatic hedge management** for this config level. When enabled, the engine places OTM hedge orders to limit downside risk on short positions.',
    ],
    relatedFields: ['strategyConfig.hedgeStrikeRoundingMinDistance'],
  }),

  'strategyConfig.hedgeStrikeRoundingMinDistance': sc({
    fieldKey: 'strategyConfig.hedgeStrikeRoundingMinDistance',
    title: 'Hedge Strike Rounding Min Dist %',
    category: 'Hedging Configuration',
    description: [
      'The **minimum hedge distance percentage** (from the short trade strike) required to apply symbol-level rounding to hedge strike selection.',
      'When hedge distance is below this threshold, exact calculated strike is used without rounding. Leave empty for no rounding.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to 2.0. If hedge distance calculates to 1.5% — no rounding applied (below threshold). If hedge distance is 4% — rounding is applied to snap to the nearest valid strike.',
    },
    defaultValue: 'Not set (no rounding)',
    relatedFields: ['strategyConfig.hedgingEnabled'],
  }),

  // ==================== TRANCH-LEVEL SETTINGS ====================

  'strategyConfig.tranchTiming': sc({
    fieldKey: 'strategyConfig.tranchTiming',
    title: 'Tranch Timing',
    category: 'Tranch Configuration',
    description: [
      'The **entry time** for this specific tranch in **HH:mm:ss** format. The engine evaluates and potentially enters positions for this tranch at the specified time.',
    ],
    example: {
      title: 'Example',
      content: '`09:20:00` — Evaluate this tranch at 9:20 AM. `10:00:00` — Evaluate at 10:00 AM.',
    },
    relatedFields: ['strategyConfig.tranchCutoffTime', 'strategyConfig.lotsPerTranch'],
  }),

  'strategyConfig.tranchCutoffTime': sc({
    fieldKey: 'strategyConfig.tranchCutoffTime',
    title: 'Tranch CutOff Time',
    category: 'Tranch Configuration',
    description: [
      'The **latest time** (HH:mm:ss) after which no new trades are initiated for this tranch. If the tranch entry is delayed (e.g., breakout watch), it will not trigger after this time.',
    ],
    example: {
      title: 'Example',
      content: '`15:00:00` — No new entries for this tranch after 3:00 PM.',
    },
    relatedFields: ['strategyConfig.tranchTiming'],
  }),

  'strategyConfig.lotsPerTranch': sc({
    fieldKey: 'strategyConfig.lotsPerTranch',
    title: 'Lots Per Tranch',
    category: 'Tranch Configuration',
    description: [
      'Override the **calculated lot count** for this specific tranch. When set, this fixed lot count is used instead of the capital-based calculation from the sequential lot allocator.',
      'Leave empty to auto-calculate lots from the user\'s subscription capital.',
    ],
    relatedFields: ['strategyConfig.tranchNumber'],
  }),

  // ==================== STRATEGY-LEVEL SETTINGS ====================

  'strategyConfig.minTranchGap': sc({
    fieldKey: 'strategyConfig.minTranchGap',
    title: 'Min Tranch Gap',
    category: 'Tranch Gap Configuration',
    description: [
      'The **minimum compressed gap** (in minutes) between tranch entries when time is running out. When remaining time cannot fit all tranches at the normal Tranch Gap, the gap is compressed down to this value to fit as many tranches as possible.',
    ],
    defaultValue: '1 minute',
    example: {
      title: 'Example',
      content: 'Tranch Gap=5, Min Gap=2, 10 min left, 12 tranches remaining. Normal gap can\'t fit all → compressed gap = max(10/12, 2) = 2 min. Can fit 5 tranches instead of 2.',
    },
    relatedFields: ['strategyConfig.tranchGap', 'strategyConfig.maxTranches'],
  }),

  'strategyConfig.tranchGap': sc({
    fieldKey: 'strategyConfig.tranchGap',
    title: 'Tranch Gap',
    category: 'Tranch Gap Configuration',
    description: [
      'The **gap** (in minutes) between consecutive tranch entries. Each signal must wait this many minutes after the previous tranch before being accepted.',
      'When time is running out near strategy stop time, the gap is automatically compressed down to Min Tranch Gap to fit more tranches.',
    ],
    example: {
      title: 'Example',
      content: 'Set to 5. If Tranch 1 enters at 10:00, Tranch 2 cannot enter before 10:05 even if signaled earlier.',
    },
    relatedFields: ['strategyConfig.minTranchGap', 'strategyConfig.maxTranches'],
  }),

  'strategyConfig.maxTranches': sc({
    fieldKey: 'strategyConfig.maxTranches',
    title: 'Max Tranches',
    category: 'Tranch Gap Configuration',
    description: [
      'The **maximum number of tranches** to execute per day. Once this limit is reached, no more tranch entries are initiated for the day.',
      'Set at the strategy or day level only (not tranch level).',
    ],
    example: {
      title: 'Example',
      content: 'Set to 8. Even if 12 tranch signals arrive, only the first 8 are executed.',
    },
    relatedFields: ['strategyConfig.minTranchGap', 'strategyConfig.tranchGap'],
  }),

  'strategyConfig.lotAllocationMode': sc({
    fieldKey: 'strategyConfig.lotAllocationMode',
    title: 'Lot Allocation Mode',
    category: 'Tranch Gap Configuration',
    description: [
      'Controls how subscription lots are distributed when the strategy has day-specific tranche windows.',
      '`Day Local` keeps the current behavior: today\'s lots are split only across today\'s tranches.',
      '`Global Shared` allocates lots across a shared global tranche pool, then the active day uses only its configured tranche slice.',
    ],
    example: {
      title: 'Example',
      content: 'Global pool = 8 tranches. DT-2 uses tranche 1-2, DT-1 uses tranche 3-8. Total lots are allocated across all 8 first, then each day gets its slice.',
    },
    relatedFields: ['strategyConfig.globalAllocationTranches', 'strategyConfig.allocationStartTranch', 'strategyConfig.maxTranches'],
  }),

  'strategyConfig.globalAllocationTranches': sc({
    fieldKey: 'strategyConfig.globalAllocationTranches',
    title: 'Global Allocation Tranches',
    category: 'Tranch Gap Configuration',
    description: [
      'Total size of the shared tranche pool used when `Lot Allocation Mode` is `Global Shared`.',
      'This is the denominator for lot distribution before the active day slice is selected.',
    ],
    example: {
      title: 'Example',
      content: 'Capital gives 30 lots, Global Allocation Tranches = 8. Engine allocates 30 lots across tranche 1-8, then DT-2 or DT-1 uses its configured subset.',
    },
    relatedFields: ['strategyConfig.lotAllocationMode', 'strategyConfig.allocationStartTranch'],
  }),

  'strategyConfig.allocationStartTranch': sc({
    fieldKey: 'strategyConfig.allocationStartTranch',
    title: 'Allocation Start Tranch',
    category: 'Tranch Gap Configuration',
    description: [
      'The first global tranche number owned by this day-level config when `Lot Allocation Mode` is `Global Shared`.',
      'The active day uses the range: `Allocation Start Tranch` through `Allocation Start Tranch + Max Tranches - 1`.',
    ],
    example: {
      title: 'Example',
      content: 'Global pool = 8, DT-2 has Max Tranches = 2 and Start = 1, DT-1 has Max Tranches = 6 and Start = 3. DT-2 uses tranche 1-2, DT-1 uses tranche 3-8.',
    },
    relatedFields: ['strategyConfig.lotAllocationMode', 'strategyConfig.globalAllocationTranches', 'strategyConfig.maxTranches'],
  }),

  // ==================== POLICY TEMPLATES ====================

  'strategyConfig.strikeSelectionTemplate': sc({
    fieldKey: 'strategyConfig.strikeSelectionTemplate',
    title: 'Strike Selection Template',
    category: 'Load from Template',
    description: [
      'Load strike selection values from a saved **Strike Selection Policy**. Auto-fills Strike Type, Strike Value, and Premium fields.',
      'You can customize individual fields after loading. This is a one-time copy, not a live link.',
    ],
  }),

  'strategyConfig.slTargetTemplate': sc({
    fieldKey: 'strategyConfig.slTargetTemplate',
    title: 'SL & Target Template',
    category: 'Load from Template',
    description: [
      'Load SL and target values from a saved **SL & Target Policy**. Auto-fills SL %, Target %, Combined SL/Target %, SL Gap %, and SL Buffer %.',
    ],
  }),

  'strategyConfig.trailingSLTemplate': sc({
    fieldKey: 'strategyConfig.trailingSLTemplate',
    title: 'Trailing SL Template',
    category: 'Load from Template',
    description: [
      'Load trailing stop-loss values from a saved **Trailing SL Policy**. Auto-fills Trail SL enabled, Trail Type, Trail Config JSON, Trail to Cost, and Combined Trail.',
    ],
  }),

  'strategyConfig.orderFillTemplate': sc({
    fieldKey: 'strategyConfig.orderFillTemplate',
    title: 'Order Fill Template',
    category: 'Load from Template',
    description: [
      'Load order fill escalation values from a saved **Order Fill Policy**. Auto-fills Escalation Mode, Seconds, and Steps.',
    ],
  }),

  'strategyConfig.exitTemplate': sc({
    fieldKey: 'strategyConfig.exitTemplate',
    title: 'Exit Template',
    category: 'Load from Template',
    description: [
      'Load exit configuration from a saved **Exit Policy**. Auto-fills Exit Mode, Exit Days, and Exit Time.',
    ],
  }),

  // ==================== STRIKE CONFIGURATION ====================

  'strategyConfig.strikeType': sc({
    fieldKey: 'strategyConfig.strikeType',
    title: 'Strike Type',
    category: 'Strike Configuration',
    description: [
      'The method used to **select option strikes** for this strategy config. Each type uses different criteria to find the appropriate strike.',
    ],
    validValues: [
      '**MoneyNess** — Select by position relative to ATM (e.g., ATM, OTM+1, ITM-2)',
      '**FixedPremium** — Select the strike closest to a specific premium value',
      '**PremiumRange** — Select a strike within a premium range (lower to upper)',
      '**PremiumRange_OIRanked** — Within a premium range, rank strikes by Open Interest and select the Nth highest',
      '**CandleLow_NearPremium** — Find the strike near the target premium whose candle LOW over the lookback period is closest to the current price',
    ],
    relatedFields: [
      'strategyConfig.strikeValue',
      'strategyConfig.optionPremium',
      'strategyConfig.optionPremiumUpper',
    ],
  }),

  'strategyConfig.strikeValue': sc({
    fieldKey: 'strategyConfig.strikeValue',
    title: 'Strike Value',
    category: 'Strike Configuration',
    description: [
      'For **MoneyNess** strike type — the specific strike position relative to ATM.',
      'ITM strikes are in-the-money (higher premium, closer to spot), OTM strikes are out-of-the-money (lower premium, further from spot).',
    ],
    validValues: [
      '**ITM-5** to **ITM-1** — In The Money (5 to 1 strikes deep)',
      '**ATM** — At The Money',
      '**OTM+1** to **OTM+5** — Out of The Money (1 to 5 strikes out)',
    ],
    relatedFields: ['strategyConfig.strikeType'],
  }),

  'strategyConfig.optionPremium': sc({
    fieldKey: 'strategyConfig.optionPremium',
    title: 'Option Premium',
    category: 'Strike Configuration',
    description: [
      'The **premium value** used for strike selection. Its meaning depends on the Strike Type:',
      '**FixedPremium** — The target premium. Engine selects the strike whose current premium is closest to this value.',
      '**PremiumRange / PremiumRange_OIRanked** — The lower bound of the premium range.',
      '**CandleLow_NearPremium** — The target premium around which to search for candle low opportunities.',
    ],
    example: {
      title: 'Example',
      content:
        'FixedPremium with value 100: selects the strike whose premium is closest to ₹100. PremiumRange with lower=80, upper=120: considers only strikes with premium between ₹80 and ₹120.',
    },
    relatedFields: ['strategyConfig.strikeType', 'strategyConfig.optionPremiumUpper'],
  }),

  'strategyConfig.optionPremiumUpper': sc({
    fieldKey: 'strategyConfig.optionPremiumUpper',
    title: 'Premium Upper',
    category: 'Strike Configuration',
    description: [
      'The **upper bound** of the premium range for **PremiumRange** and **PremiumRange_OIRanked** strike types. Only strikes with premium between the lower and upper bounds are considered.',
    ],
    relatedFields: ['strategyConfig.optionPremium', 'strategyConfig.strikeType'],
  }),

  'strategyConfig.useATMIfITM': sc({
    fieldKey: 'strategyConfig.useATMIfITM',
    title: 'Use ATM if ITM',
    category: 'Strike Configuration',
    description: [
      'For **FixedPremium** and **PremiumRange** strike types — if the strike selected by premium matching turns out to be In-The-Money (ITM), **use the ATM strike instead**.',
      'This ensures the strategy always trades OTM or ATM options, avoiding deep ITM positions.',
    ],
    defaultValue: 'Not set (no fallback)',
    relatedFields: ['strategyConfig.strikeType', 'strategyConfig.optionPremium'],
  }),

  'strategyConfig.volumeFilter': sc({
    fieldKey: 'strategyConfig.volumeFilter',
    title: 'Volume Filter',
    category: 'Strike Configuration',
    description: [
      'Minimum **traded volume** (today) a strike must have to be tradable. Applies to **all** strike-selection scenarios.',
      'When traversing the option chain (FixedPremium, PremiumRange, OI-ranked, CandleLow), any strike below this volume is **skipped** and the search continues to the next strike.',
      'For ATM / ITM±N / OTM±N, if the selected strike is below this volume the trade signal is **not generated** for that tranch.',
      'For **breakout watches**, the check runs when the breakout fires (signal generation), not at watch creation.',
      'Leave blank to inherit; **0** disables the filter (existing behaviour).',
    ],
    defaultValue: 'Blank / 0 = not configured (no filtering)',
    relatedFields: ['strategyConfig.oiFilter', 'strategyConfig.applyVolumeFilterToHedge'],
  }),

  'strategyConfig.oiFilter': sc({
    fieldKey: 'strategyConfig.oiFilter',
    title: 'OI Filter',
    category: 'Strike Configuration',
    description: [
      'Minimum **open interest** a strike must have to be tradable. Behaves exactly like the Volume Filter but on OI.',
      'Both filters are applied together — a strike must satisfy **both** to be selected. Independent of the RMS-level volume/OI floor, which still applies at order placement.',
      'Leave blank to inherit; **0** disables the filter.',
    ],
    defaultValue: 'Blank / 0 = not configured (no filtering)',
    relatedFields: ['strategyConfig.volumeFilter', 'strategyConfig.applyOIFilterToHedge'],
  }),

  'strategyConfig.applyVolumeFilterToHedge': sc({
    fieldKey: 'strategyConfig.applyVolumeFilterToHedge',
    title: 'Apply Volume Filter to Hedge',
    category: 'Strike Configuration',
    description: [
      'When **Yes**, hedge legs must also pass the Volume Filter. If a hedge leg is too illiquid, the **entire entry is blocked** (no naked main).',
      'Default **No** — hedge legs are exempt (acceptable on liquid exchanges). Turn on for exchanges like **MCX** where an illiquid hedge is risky.',
    ],
    defaultValue: 'No (hedges exempt)',
    relatedFields: ['strategyConfig.volumeFilter', 'strategyConfig.applyOIFilterToHedge'],
  }),

  'strategyConfig.applyOIFilterToHedge': sc({
    fieldKey: 'strategyConfig.applyOIFilterToHedge',
    title: 'Apply OI Filter to Hedge',
    category: 'Strike Configuration',
    description: [
      'When **Yes**, hedge legs must also pass the OI Filter. If a hedge leg fails, the **entire entry is blocked**.',
      'Default **No** — hedge legs are exempt. Turn on for exchanges like **MCX**.',
    ],
    defaultValue: 'No (hedges exempt)',
    relatedFields: ['strategyConfig.oiFilter', 'strategyConfig.applyVolumeFilterToHedge'],
  }),

  'strategyConfig.oiRank': sc({
    fieldKey: 'strategyConfig.oiRank',
    title: 'OI Rank',
    category: 'Strike Configuration',
    description: [
      'For **PremiumRange_OIRanked** strike type — within the premium range, strikes are ranked by **Open Interest** (highest first). This field selects which rank to trade.',
      '**1** = highest OI strike in the range, **2** = second highest, etc.',
    ],
    defaultValue: '1 (highest OI)',
    validValues: [
      '**1** — Highest OI (most liquid)',
      '**2** to **5** — 2nd through 5th highest OI',
    ],
    relatedFields: ['strategyConfig.strikeType', 'strategyConfig.ignoreITMStrikes'],
  }),

  'strategyConfig.ignoreITMStrikes': sc({
    fieldKey: 'strategyConfig.ignoreITMStrikes',
    title: 'Ignore ITM Strikes',
    category: 'Strike Configuration',
    description: [
      'For **PremiumRange_OIRanked** strike type — whether to **exclude ITM strikes** from the OI ranking. When enabled, only OTM and ATM strikes within the premium range are considered.',
    ],
    defaultValue: 'true (OTM only)',
    relatedFields: ['strategyConfig.oiRank', 'strategyConfig.strikeType'],
  }),

  'strategyConfig.lookbackMinutes': sc({
    fieldKey: 'strategyConfig.lookbackMinutes',
    title: 'Lookback Minutes',
    category: 'Strike Configuration',
    description: [
      'For **CandleLow_NearPremium** strike type — the number of **minutes to look back** for candle history when identifying the candle LOW values for each OTM strike.',
    ],
    defaultValue: '60',
    example: {
      title: 'Example',
      content: 'Set to 60: looks at the last 60 minutes of 1-min candle data to find the LOW for each option strike near the target premium.',
    },
    relatedFields: ['strategyConfig.otmLevels', 'strategyConfig.strikeType'],
  }),

  'strategyConfig.otmLevels': sc({
    fieldKey: 'strategyConfig.otmLevels',
    title: 'Strike Levels',
    category: 'Strike Configuration',
    description: [
      'For **CandleLow_NearPremium** strike type — the number of **strike levels** to check on each side of ATM (both ITM and OTM) when searching for candle low opportunities. For example, 10 means ATM-10 to ATM+10 strikes will be scanned.',
    ],
    defaultValue: '10',
    relatedFields: ['strategyConfig.lookbackMinutes', 'strategyConfig.strikeType'],
  }),

  // ==================== SL & TARGET ====================

  'strategyConfig.slPercentage': sc({
    fieldKey: 'strategyConfig.slPercentage',
    title: 'SL %',
    category: 'SL & Target',
    description: [
      'The **individual leg stop-loss percentage**. When a single option position\'s loss exceeds this percentage of its entry premium, the SL order triggers.',
    ],
    example: {
      title: 'Example',
      content: 'SL=25%. Entry premium ₹100. SL triggers at ₹125 (for short positions, premium rises by 25%).',
    },
    relatedFields: ['strategyConfig.targetPercentage', 'strategyConfig.slBufferPercentage', 'strategyConfig.slTriggerToLimitGapPercentage'],
  }),

  'strategyConfig.slBufferPercentage': sc({
    fieldKey: 'strategyConfig.slBufferPercentage',
    title: 'SL Buffer %',
    category: 'SL & Target',
    description: [
      'An additional **buffer percentage** added to the SL calculation. This provides a small cushion to prevent premature SL triggers due to minor price fluctuations.',
    ],
    example: {
      title: 'Example',
      content: 'SL=25%, Buffer=0.5%. Effective SL trigger = 25.5% loss from entry.',
    },
    relatedFields: ['strategyConfig.slPercentage'],
  }),

  'strategyConfig.slTriggerToLimitGapPercentage': sc({
    fieldKey: 'strategyConfig.slTriggerToLimitGapPercentage',
    title: 'SL Gap %',
    category: 'SL & Target',
    description: [
      'The **gap between SL trigger price and SL limit order price**. When SL is triggered, the limit order is placed at a price this percentage above the trigger to improve fill probability.',
      'Higher values increase fill probability but may result in worse execution prices.',
    ],
    example: {
      title: 'Example',
      content: 'SL trigger at ₹125, Gap=6%. Limit order placed at ₹132.50 (6% above trigger). This ensures the order fills even if price gaps through the trigger.',
    },
    relatedFields: ['strategyConfig.slPercentage'],
  }),

  'strategyConfig.targetPercentage': sc({
    fieldKey: 'strategyConfig.targetPercentage',
    title: 'Target %',
    category: 'SL & Target',
    description: [
      'The **individual leg target percentage**. When a single option position\'s profit reaches this percentage of its entry premium, the target order triggers.',
    ],
    example: {
      title: 'Example',
      content: 'Target=50%. Entry premium ₹100. Target triggers at ₹50 (for short positions, premium drops by 50%).',
    },
    relatedFields: ['strategyConfig.slPercentage'],
  }),

  'strategyConfig.combinedSLPercentage': sc({
    fieldKey: 'strategyConfig.combinedSLPercentage',
    title: 'Combined SL %',
    category: 'SL & Target',
    description: [
      'The **combined/portfolio-level stop-loss percentage**. Applied to the total premium of all legs in a strategy (e.g., both CE and PE legs of a straddle). Triggers exit of all legs when the combined loss exceeds this percentage.',
    ],
    example: {
      title: 'Example',
      content: 'Straddle entry: CE ₹100 + PE ₹100 = ₹200 total. Combined SL=15%. Triggers when combined loss exceeds ₹30 (15% of ₹200).',
    },
    relatedFields: ['strategyConfig.combinedTargetPercentage', 'strategyConfig.slPercentage'],
  }),

  'strategyConfig.combinedTargetPercentage': sc({
    fieldKey: 'strategyConfig.combinedTargetPercentage',
    title: 'Combined Target %',
    category: 'SL & Target',
    description: [
      'The **combined/portfolio-level target percentage**. Applied to the total premium of all legs. Triggers exit of all legs when the combined profit reaches this percentage.',
    ],
    relatedFields: ['strategyConfig.combinedSLPercentage', 'strategyConfig.targetPercentage'],
  }),

  'strategyConfig.riskCalculationMode': sc({
    fieldKey: 'strategyConfig.riskCalculationMode',
    title: 'Risk Calculation Mode',
    category: 'SL & Target',
    description: [
      'Controls how the **risk-aware lot allocator** computes risk per lot for position sizing.',
      '**STOP_LOSS** (default): Risk = entry premium × SL percentage. Traditional SL-based risk calculation.',
      '**WING_WIDTH_MAX_LOSS**: Risk = wing width − net premium collected. For hedged strategies (iron butterfly/condor) where max loss is bounded by the hedge structure. Backend computes this from strategy legs at runtime.',
    ],
    relatedFields: ['strategyConfig.slPercentage', 'strategyConfig.combinedSLPercentage'],
  }),

  'strategyConfig.noStopLoss': sc({
    fieldKey: 'strategyConfig.noStopLoss',
    title: 'No Stop Loss',
    category: 'SL & Target',
    description: [
      'When enabled, **no individual stop-loss order is placed** for trades in this strategy. The engine skips SL order placement entirely.',
      'Use for **wing-width max loss strategies** (e.g., iron butterfly/condor) where the maximum loss is bounded by the hedge structure rather than an explicit SL order.',
    ],
    relatedFields: ['strategyConfig.riskCalculationMode', 'strategyConfig.slPercentage'],
  }),

  // ==================== TRAILING SL ====================

  'strategyConfig.trailSL': sc({
    fieldKey: 'strategyConfig.trailSL',
    title: 'Trail SL',
    category: 'Trailing SL',
    description: [
      'Enable or disable **trailing stop-loss** for individual legs. When enabled, the SL level dynamically adjusts as the position moves into profit, locking in gains.',
    ],
    relatedFields: ['strategyConfig.trailSLType', 'strategyConfig.trailConfig', 'strategyConfig.combinedTrailSL'],
  }),

  'strategyConfig.combinedTrailSL': sc({
    fieldKey: 'strategyConfig.combinedTrailSL',
    title: 'Combined Trail SL',
    category: 'Trailing SL',
    description: [
      'Enable **trailing stop-loss at the combined/portfolio level**. When enabled, the combined SL dynamically adjusts as the overall position moves into profit.',
      'Adds `combinedProfitGap`, `combinedSlMoveGap`, and `combinedTrailMode` parameters to the Trail Config JSON.',
    ],
    relatedFields: ['strategyConfig.trailSL', 'strategyConfig.trailConfig'],
  }),

  'strategyConfig.trailSLType': sc({
    fieldKey: 'strategyConfig.trailSLType',
    title: 'Trail SL Type',
    category: 'Trailing SL',
    description: [
      'The **calculation method** for the trailing stop-loss. Each type uses a different algorithm to determine the trail level.',
    ],
    validValues: [
      '**RISK_MULTIPLE** — Trail in R-multiples of initial risk. Uses profitGap and slMoveGap parameters',
      '**SUPER_TREND** — Uses the SuperTrend indicator (period + multiplier)',
      '**ATR** — Uses Average True Range indicator (period + multiplier)',
      '**EMA** — Uses Exponential Moving Average (period + bufferPercentage)',
      '**HEIKIN_ASHI** — Uses Heikin Ashi candle reversal (maxDistancePercentage)',
      '**CUSTOM** — Custom logic, all parameters specified in Trail Config JSON',
    ],
    relatedFields: ['strategyConfig.trailSL', 'strategyConfig.trailConfig'],
  }),

  'strategyConfig.trailSLToCost': sc({
    fieldKey: 'strategyConfig.trailSLToCost',
    title: 'Trail SL to Cost',
    category: 'Trailing SL',
    description: [
      'Move the stop-loss to **entry price (cost)** once a profit threshold is reached. This guarantees a break-even exit at minimum.',
      'Configure the profit threshold in Trail Config using `trailToCostProfitGap` and `trailToCostMode`.',
    ],
    example: {
      title: 'Example',
      content:
        'trailToCostMode=`risk_multiple`, trailToCostProfitGap=1.0. Once profit reaches 1x the initial risk (1R), SL moves to entry price.',
    },
    relatedFields: ['strategyConfig.trailSL', 'strategyConfig.trailConfig'],
  }),

  'strategyConfig.trailConfig': sc({
    fieldKey: 'strategyConfig.trailConfig',
    title: 'Trail Config (JSON)',
    category: 'Trailing SL',
    description: [
      'JSON configuration for the trailing SL calculator. Keys depend on the selected **Trail SL Type**.',
      'Common keys per type:\n**ATR**: `period`, `multiplier`\n**SuperTrend**: `period`, `multiplier`\n**EMA**: `period`, `bufferPercentage`\n**Heikin Ashi**: `maxDistancePercentage`\n**Risk Multiple**: `profitGap`, `slMoveGap`, `trailMode` (absolute/percentage)',
      'Combined trail adds: `combinedProfitGap`, `combinedSlMoveGap`, `combinedTrailMode`\nTrail-to-cost adds: `trailToCostProfitGap`, `trailToCostMode` (risk_multiple/absolute/percentage)',
    ],
    example: {
      title: 'Risk Multiple Example',
      content:
        '`{"profitGap": 10, "slMoveGap": 5, "trailMode": "absolute"}` — When profit increases by 10 points, SL moves up by 5 points.',
    },
    warning: 'Must be valid JSON. Invalid JSON will cause trail SL evaluation to fail.',
    relatedFields: ['strategyConfig.trailSLType', 'strategyConfig.trailSL'],
  }),

  // ==================== ORDER FILL ESCALATION ====================

  'strategyConfig.orderFillEscalationMode': sc({
    fieldKey: 'strategyConfig.orderFillEscalationMode',
    title: 'Order Fill Escalation',
    category: 'Order Fill',
    description: [
      'What to do when a **limit order doesn\'t fill** within the expected time. Escalation helps ensure orders get filled even in fast-moving markets.',
    ],
    validValues: [
      '**NONE** — No escalation. Order stays as placed',
      '**MARKET** — Convert to market order after the specified seconds',
      '**STEP_ESCALATION** — Multi-step escalation with progressive price adjustments defined in JSON',
    ],
    relatedFields: ['strategyConfig.orderFillEscalationSeconds', 'strategyConfig.orderFillEscalationSteps'],
  }),

  'strategyConfig.orderFillEscalationSeconds': sc({
    fieldKey: 'strategyConfig.orderFillEscalationSeconds',
    title: 'Escalation Seconds',
    category: 'Order Fill',
    description: [
      'For **MARKET** escalation mode — the number of **seconds to wait** before converting the unfilled limit order to a market order.',
    ],
    example: {
      title: 'Example',
      content: 'Set to 30. If the limit order is not filled within 30 seconds, it\'s canceled and replaced with a market order.',
    },
    relatedFields: ['strategyConfig.orderFillEscalationMode'],
  }),

  'strategyConfig.orderFillEscalationSteps': sc({
    fieldKey: 'strategyConfig.orderFillEscalationSteps',
    title: 'Escalation Steps (JSON)',
    category: 'Order Fill',
    description: [
      'For **STEP_ESCALATION** mode — a JSON array defining progressive escalation steps. Each step specifies when to escalate and what action to take.',
    ],
    example: {
      title: 'Example',
      content:
        '`[{"afterSeconds":3,"type":"PERCENTAGE","value":1.0},{"afterSeconds":5,"type":"MARKET"}]` — After 3s: adjust price by 1%. After 5s: convert to market.',
    },
    warning: 'Must be valid JSON array. Each step requires `afterSeconds` and `type` fields.',
    relatedFields: ['strategyConfig.orderFillEscalationMode'],
  }),

  // ==================== EXIT CONFIGURATION ====================

  'strategyConfig.exitMode': sc({
    fieldKey: 'strategyConfig.exitMode',
    title: 'Exit Mode',
    category: 'Exit Configuration',
    description: [
      'Determines **when positional trades should be exited**. This controls the exit timing logic for non-intraday strategies.',
    ],
    validValues: [
      '**SAME_DAY** — Exit on the same day at the specified exit time',
      '**DAYS_FROM_ENTRY** — Exit N trading days after entry',
      '**DTE** — Exit N trading days before expiry (Days To Expiry)',
      '**EXPIRY** — Exit on expiry day',
      '**MINUTES_FROM_ENTRY** — Exit N trading minutes after entry (spans across trading days, excludes non-trading time)',
    ],
    relatedFields: ['strategyConfig.exitDays', 'strategyConfig.exitTime'],
  }),

  'strategyConfig.exitDays': sc({
    fieldKey: 'strategyConfig.exitDays',
    title: 'Exit Days',
    category: 'Exit Configuration',
    description: [
      'The number of **days/minutes parameter** for the selected exit mode.',
      '**DAYS_FROM_ENTRY**: exit this many trading days after entry. **DTE**: exit this many trading days before expiry. **MINUTES_FROM_ENTRY**: exit this many trading minutes after entry (spans across days).',
    ],
    example: {
      title: 'Example',
      content: 'DAYS_FROM_ENTRY with exitDays=2: entered on Monday → exit on Wednesday. DTE with exitDays=3: if expiry is Thursday → exit on Monday.',
    },
    relatedFields: ['strategyConfig.exitMode', 'strategyConfig.exitTime'],
  }),

  'strategyConfig.exitTime': sc({
    fieldKey: 'strategyConfig.exitTime',
    title: 'Exit Time',
    category: 'Exit Configuration',
    description: [
      'The **time of day** to execute the exit, in **HH:mm:ss** format. Use the special value `ENTRY_TIME` to exit at the same time as signal generation (current system time).',
    ],
    example: {
      title: 'Example',
      content: '`15:15:00` — Exit at 3:15 PM. `ENTRY_TIME` — Exit at the same time the entry signal was generated.',
    },
    relatedFields: ['strategyConfig.exitMode', 'strategyConfig.exitDays'],
  }),

  'strategyConfig.reEntry': sc({
    fieldKey: 'strategyConfig.reEntry',
    title: 'Re-Entry',
    category: 'Exit Configuration',
    description: [
      'Enable or disable **automatic re-entry** after a stop-loss exit. When enabled, the engine can re-enter the same position after an SL hit, up to the configured maximum number of re-entries.',
    ],
    relatedFields: ['strategyConfig.maxReentries', 'strategyConfig.minReentryLossPercentage'],
  }),

  'strategyConfig.maxReentries': sc({
    fieldKey: 'strategyConfig.maxReentries',
    title: 'Max Re-Entries',
    category: 'Exit Configuration',
    description: [
      'The **maximum number of re-entry attempts** allowed after stop-loss exits within a single session.',
    ],
    defaultValue: '2',
    relatedFields: ['strategyConfig.reEntry', 'strategyConfig.minReentryLossPercentage'],
  }),

  'strategyConfig.minReentryLossPercentage': sc({
    fieldKey: 'strategyConfig.minReentryLossPercentage',
    title: 'Min Loss % for Re-Entry',
    category: 'Exit Configuration',
    description: [
      'The **minimum loss percentage** the exited position must have incurred for a re-entry to be triggered. Prevents re-entry on small SL hits that may be due to noise.',
    ],
    defaultValue: '0 (any loss qualifies)',
    example: {
      title: 'Example',
      content: 'Set to 5.0%. If SL exit results in only 3% loss — no re-entry. If 8% loss — re-entry is triggered. Leave unconfigured (default 0%) to allow re-entry on any loss.',
    },
    relatedFields: ['strategyConfig.reEntry', 'strategyConfig.maxReentries'],
  }),

  // ==================== BREAKOUT WATCH ====================

  'strategyConfig.breakoutEnabled': sc({
    fieldKey: 'strategyConfig.breakoutEnabled',
    title: 'Breakout Watch',
    category: 'Breakout Watch',
    description: [
      'Instead of immediate entry at the scheduled time, **create a watch** that triggers entry when price conditions are met.',
      'Useful for waiting for premium drop or underlying price movement before entering.',
    ],
    relatedFields: [
      'strategyConfig.breakoutWatchType',
      'strategyConfig.breakoutDirection',
      'strategyConfig.breakoutTriggerMode',
    ],
  }),

  'strategyConfig.breakoutWatchType': sc({
    fieldKey: 'strategyConfig.breakoutWatchType',
    title: 'Watch Type',
    category: 'Breakout Watch',
    description: [
      'What to **monitor** for the breakout trigger.',
      '**Option Premium**: Watch the selected option premium (strike is chosen at watch creation time).',
      '**Underlying**: Watch the index/futures price. Fresh strike selection happens at trigger time using current market prices.',
    ],
    validValues: [
      '**OPTION_SYMBOL** — Watch option premium (strike selected at watch creation)',
      '**UNDERLYING** — Watch index/futures price (fresh strike selection at trigger)',
    ],
    relatedFields: ['strategyConfig.breakoutEnabled', 'strategyConfig.breakoutDirection'],
  }),

  'strategyConfig.breakoutDirection': sc({
    fieldKey: 'strategyConfig.breakoutDirection',
    title: 'Breakout Direction',
    category: 'Breakout Watch',
    description: [
      'The **direction of price movement** that triggers entry.',
    ],
    validValues: [
      '**BELOW** — Trigger when price drops below threshold (common for premium decay entry)',
      '**ABOVE** — Trigger when price rises above threshold',
      '**EITHER** — Trigger on movement in either direction',
    ],
    relatedFields: ['strategyConfig.breakoutWatchType', 'strategyConfig.breakoutTriggerMode'],
  }),

  'strategyConfig.breakoutTriggerMode': sc({
    fieldKey: 'strategyConfig.breakoutTriggerMode',
    title: 'Trigger Mode',
    category: 'Breakout Watch',
    description: [
      'How the **trigger threshold** is calculated.',
    ],
    validValues: [
      '**PERCENTAGE** — Trigger based on percentage change from reference price (e.g., 20% drop)',
      '**ABSOLUTE** — Trigger based on absolute price change in points (e.g., 50 points)',
      '**CANDLE_LOW** — Trigger at identified candle low (auto-set for CandleLow_NearPremium strike type)',
    ],
    relatedFields: ['strategyConfig.breakoutTriggerValue', 'strategyConfig.breakoutDirection'],
  }),

  'strategyConfig.breakoutTriggerValue': sc({
    fieldKey: 'strategyConfig.breakoutTriggerValue',
    title: 'Trigger Value',
    category: 'Breakout Watch',
    description: [
      'The **threshold value** for the breakout trigger. Interpretation depends on the Trigger Mode.',
      '**PERCENTAGE**: percentage change (e.g., 20 = 20% change). **ABSOLUTE**: absolute points change (e.g., 50 = 50 points).',
    ],
    example: {
      title: 'Example',
      content:
        'Watch Type=OPTION_SYMBOL, Direction=BELOW, Mode=PERCENTAGE, Value=20. Entry triggers when option premium drops 20% from its value at watch creation.',
    },
    relatedFields: ['strategyConfig.breakoutTriggerMode'],
  }),

  'strategyConfig.breakoutSelectFreshStrikes': sc({
    fieldKey: 'strategyConfig.breakoutSelectFreshStrikes',
    title: 'Fresh Strike Selection',
    category: 'Breakout Watch',
    description: [
      'For **UNDERLYING** watch type — when the breakout triggers, select strikes using **current market prices** at trigger time instead of using strikes chosen at watch creation time.',
      'This ensures optimal strike selection after potentially significant underlying movement.',
    ],
    relatedFields: ['strategyConfig.breakoutWatchType', 'strategyConfig.breakoutEnabled'],
  }),

  // ==================== NOTES ====================

  'strategyConfig.description': sc({
    fieldKey: 'strategyConfig.description',
    title: 'Description',
    category: 'Notes',
    description: [
      'Optional **free-text description** for this configuration entry. Use it to document the purpose or reasoning for this specific override.',
    ],
    example: {
      title: 'Example',
      content: '"Expiry day override: tighter SL for user John on BankNifty due to higher gamma risk."',
    },
  }),
};
