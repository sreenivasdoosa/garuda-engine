import type { HelpArticle } from '@/types/help';

const sp = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const strategyPolicyHelpContent: Record<string, HelpArticle> = {
  // ==================== ORDER FILL ESCALATION POLICY ====================

  'strategyPolicy.orderFill.policyName': sp({
    fieldKey: 'strategyPolicy.orderFill.policyName',
    title: 'Policy Name',
    category: 'Order Fill Escalation Policy',
    description: [
      'A unique **name** for this order fill escalation policy. Used to identify the policy when loading it as a template in Strategy Config Tree.',
    ],
    example: {
      title: 'Example',
      content: '"Standard Market 30s", "Aggressive Step Escalation", "No Escalation"',
    },
  }),

  'strategyPolicy.orderFill.escalationMode': sp({
    fieldKey: 'strategyPolicy.orderFill.escalationMode',
    title: 'Escalation Mode',
    category: 'Order Fill Escalation Policy',
    description: [
      'What to do when a **limit order doesn\'t fill** within the expected time.',
    ],
    validValues: [
      '**NONE** — No escalation. Order stays as placed until filled or canceled',
      '**MARKET** — Convert to market order after the specified timeout seconds',
      '**STEP_ESCALATION** — Multi-step progressive escalation with price adjustments defined in JSON',
    ],
    relatedFields: ['strategyPolicy.orderFill.escalationSeconds', 'strategyPolicy.orderFill.escalationSteps'],
  }),

  'strategyPolicy.orderFill.escalationSeconds': sp({
    fieldKey: 'strategyPolicy.orderFill.escalationSeconds',
    title: 'Escalation Seconds',
    category: 'Order Fill Escalation Policy',
    description: [
      'For **MARKET** mode — the number of seconds to wait before converting the unfilled limit order to a market order.',
    ],
    example: {
      title: 'Example',
      content: 'Set to 30. If the limit order is not filled within 30 seconds, it is canceled and replaced with a market order.',
    },
    relatedFields: ['strategyPolicy.orderFill.escalationMode'],
  }),

  'strategyPolicy.orderFill.escalationSteps': sp({
    fieldKey: 'strategyPolicy.orderFill.escalationSteps',
    title: 'Escalation Steps (JSON)',
    category: 'Order Fill Escalation Policy',
    description: [
      'For **STEP_ESCALATION** mode — a JSON array defining progressive escalation steps. Each step has `afterSeconds` (when to escalate) and `type` (what action to take).',
    ],
    example: {
      title: 'Example',
      content:
        '`[{"afterSeconds":3,"type":"PERCENTAGE","value":1.0},{"afterSeconds":5,"type":"MARKET"}]`\nStep 1: After 3 seconds, increase price by 1%.\nStep 2: After 5 seconds, convert to market order.',
    },
    warning: 'Must be valid JSON array.',
    relatedFields: ['strategyPolicy.orderFill.escalationMode'],
  }),

  'strategyPolicy.orderFill.description': sp({
    fieldKey: 'strategyPolicy.orderFill.description',
    title: 'Description',
    category: 'Order Fill Escalation Policy',
    description: [
      'Optional description of the policy\'s purpose and when it should be used.',
    ],
  }),

  // ==================== TRAILING SL POLICY ====================

  'strategyPolicy.trailingSL.policyName': sp({
    fieldKey: 'strategyPolicy.trailingSL.policyName',
    title: 'Policy Name',
    category: 'Trailing SL Policy',
    description: [
      'A unique **name** for this trailing SL policy. Used to identify the policy when loading it as a template in Strategy Config Tree.',
    ],
    example: {
      title: 'Example',
      content: '"Risk Multiple 10/5", "SuperTrend 10x3", "ATR 21x4 with Combined"',
    },
  }),

  'strategyPolicy.trailingSL.trailType': sp({
    fieldKey: 'strategyPolicy.trailingSL.trailType',
    title: 'Trail Type',
    category: 'Trailing SL Policy',
    description: [
      'The **calculation method** for the trailing stop-loss.',
    ],
    validValues: [
      '**RISK_MULTIPLE** — Trail in R-multiples of initial risk. Config: `profitGap`, `slMoveGap`, `trailMode`',
      '**SUPER_TREND** — SuperTrend indicator. Config: `period`, `multiplier`',
      '**ATR** — Average True Range. Config: `period`, `multiplier`',
      '**EMA** — Exponential Moving Average. Config: `period`, `bufferPercentage`',
      '**HEIKIN_ASHI** — Heikin Ashi candle reversal. Config: `maxDistancePercentage`',
      '**CUSTOM** — Custom logic, all parameters in Trail Config',
    ],
    relatedFields: ['strategyPolicy.trailingSL.trailConfig'],
  }),

  'strategyPolicy.trailingSL.trailEnabled': sp({
    fieldKey: 'strategyPolicy.trailingSL.trailEnabled',
    title: 'Trail Enabled',
    category: 'Trailing SL Policy',
    description: [
      'Enable trailing stop-loss for **individual legs**. When enabled, the SL level dynamically adjusts as the position moves into profit.',
    ],
    relatedFields: ['strategyPolicy.trailingSL.trailType', 'strategyPolicy.trailingSL.trailConfig'],
  }),

  'strategyPolicy.trailingSL.trailToCost': sp({
    fieldKey: 'strategyPolicy.trailingSL.trailToCost',
    title: 'Trail to Cost',
    category: 'Trailing SL Policy',
    description: [
      'Move the stop-loss to **entry price (cost)** once a profit threshold is reached. Guarantees a break-even exit at minimum.',
      'Adds `trailToCostProfitGap` and `trailToCostMode` to Trail Config.',
    ],
    relatedFields: ['strategyPolicy.trailingSL.trailConfig'],
  }),

  'strategyPolicy.trailingSL.combinedTrailEnabled': sp({
    fieldKey: 'strategyPolicy.trailingSL.combinedTrailEnabled',
    title: 'Combined Trail Enabled',
    category: 'Trailing SL Policy',
    description: [
      'Enable trailing stop-loss at the **combined/portfolio level**. When enabled, the combined SL dynamically adjusts as the overall position moves into profit.',
      'Adds `combinedProfitGap`, `combinedSlMoveGap`, and `combinedTrailMode` to Trail Config.',
    ],
    relatedFields: ['strategyPolicy.trailingSL.trailConfig'],
  }),

  'strategyPolicy.trailingSL.trailConfig': sp({
    fieldKey: 'strategyPolicy.trailingSL.trailConfig',
    title: 'Trail Config (JSON)',
    category: 'Trailing SL Policy',
    description: [
      'JSON configuration for the trailing SL calculator. Keys depend on the Trail Type:',
      '**ATR**: `period`, `multiplier`\n**SuperTrend**: `period`, `multiplier`\n**EMA**: `period`, `bufferPercentage`\n**Heikin Ashi**: `maxDistancePercentage`\n**Risk Multiple**: `profitGap`, `slMoveGap`, `trailMode`',
      'Combined trail adds: `combinedProfitGap`, `combinedSlMoveGap`, `combinedTrailMode`\nTrail-to-cost adds: `trailToCostProfitGap`, `trailToCostMode` (risk_multiple/absolute/percentage)',
    ],
    warning: 'Must be valid JSON.',
    relatedFields: ['strategyPolicy.trailingSL.trailType'],
  }),

  'strategyPolicy.trailingSL.description': sp({
    fieldKey: 'strategyPolicy.trailingSL.description',
    title: 'Description',
    category: 'Trailing SL Policy',
    description: [
      'Optional description of the policy\'s purpose and when it should be used.',
    ],
  }),

  // ==================== SL & TARGET POLICY ====================

  'strategyPolicy.slTarget.policyName': sp({
    fieldKey: 'strategyPolicy.slTarget.policyName',
    title: 'Policy Name',
    category: 'SL & Target Policy',
    description: [
      'A unique **name** for this SL & Target policy. Used to identify the policy when loading it as a template in Strategy Config Tree.',
    ],
    example: {
      title: 'Example',
      content: '"Conservative 20/40", "Aggressive 30/60", "Tight Combined 10/25"',
    },
  }),

  'strategyPolicy.slTarget.slPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.slPercentage',
    title: 'SL %',
    category: 'SL & Target Policy',
    description: [
      'The **individual leg stop-loss percentage**. When a single option position\'s loss exceeds this percentage of its entry premium, the SL triggers.',
    ],
    relatedFields: ['strategyPolicy.slTarget.targetPercentage', 'strategyPolicy.slTarget.slBufferPercentage'],
  }),

  'strategyPolicy.slTarget.targetPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.targetPercentage',
    title: 'Target %',
    category: 'SL & Target Policy',
    description: [
      'The **individual leg target percentage**. When a single option position\'s profit reaches this percentage of its entry premium, the target triggers.',
    ],
    relatedFields: ['strategyPolicy.slTarget.slPercentage'],
  }),

  'strategyPolicy.slTarget.combinedSLPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.combinedSLPercentage',
    title: 'Combined SL %',
    category: 'SL & Target Policy',
    description: [
      'The **combined/portfolio-level stop-loss percentage**. Applied to the total premium of all legs in a strategy. Triggers exit of all legs when combined loss exceeds this percentage.',
    ],
    relatedFields: ['strategyPolicy.slTarget.combinedTargetPercentage'],
  }),

  'strategyPolicy.slTarget.combinedTargetPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.combinedTargetPercentage',
    title: 'Combined Target %',
    category: 'SL & Target Policy',
    description: [
      'The **combined/portfolio-level target percentage**. Triggers exit of all legs when combined profit reaches this percentage.',
    ],
    relatedFields: ['strategyPolicy.slTarget.combinedSLPercentage'],
  }),

  'strategyPolicy.slTarget.slTriggerToLimitGapPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.slTriggerToLimitGapPercentage',
    title: 'SL Trigger to Limit Gap %',
    category: 'SL & Target Policy',
    description: [
      'The **gap between SL trigger price and SL limit order price**. Higher values increase fill probability but may result in worse execution.',
    ],
    example: {
      title: 'Example',
      content: 'Set to 6. SL triggers at ₹125, limit order placed at ₹132.50 (6% above trigger).',
    },
  }),

  'strategyPolicy.slTarget.slBufferPercentage': sp({
    fieldKey: 'strategyPolicy.slTarget.slBufferPercentage',
    title: 'SL Buffer %',
    category: 'SL & Target Policy',
    description: [
      'An additional **buffer percentage** added to the SL calculation. Provides a small cushion to prevent premature SL triggers due to minor fluctuations.',
    ],
    relatedFields: ['strategyPolicy.slTarget.slPercentage'],
  }),

  'strategyPolicy.slTarget.description': sp({
    fieldKey: 'strategyPolicy.slTarget.description',
    title: 'Description',
    category: 'SL & Target Policy',
    description: [
      'Optional description of the policy\'s purpose and when it should be used.',
    ],
  }),

  // ==================== STRIKE SELECTION POLICY ====================

  'strategyPolicy.strike.policyName': sp({
    fieldKey: 'strategyPolicy.strike.policyName',
    title: 'Policy Name',
    category: 'Strike Selection Policy',
    description: [
      'A unique **name** for this strike selection policy. Used to identify the policy when loading it as a template in Strategy Config Tree.',
    ],
    example: {
      title: 'Example',
      content: '"ATM Straddle", "OTM+2 Strangle", "Premium Range 80-120"',
    },
  }),

  'strategyPolicy.strike.strikeType': sp({
    fieldKey: 'strategyPolicy.strike.strikeType',
    title: 'Strike Type',
    category: 'Strike Selection Policy',
    description: [
      'The method used to **select option strikes**.',
    ],
    validValues: [
      '**MoneyNess** — Select by position relative to ATM (e.g., ATM, OTM+1, ITM-2)',
      '**FixedPremium** — Select the strike closest to a specific premium value',
      '**PremiumRange** — Select a strike within a premium range (lower to upper)',
    ],
    relatedFields: ['strategyPolicy.strike.strikeValue', 'strategyPolicy.strike.premiumLower'],
  }),

  'strategyPolicy.strike.strikeValue': sp({
    fieldKey: 'strategyPolicy.strike.strikeValue',
    title: 'Strike Value',
    category: 'Strike Selection Policy',
    description: [
      'For **MoneyNess** type — the specific strike position relative to ATM.',
    ],
    validValues: [
      '**ITM-3** to **ITM-1** — In The Money',
      '**ATM** — At The Money',
      '**OTM+1** to **OTM+3** — Out of The Money',
    ],
    relatedFields: ['strategyPolicy.strike.strikeType'],
  }),

  'strategyPolicy.strike.premiumLower': sp({
    fieldKey: 'strategyPolicy.strike.premiumLower',
    title: 'Premium Lower',
    category: 'Strike Selection Policy',
    description: [
      'For **FixedPremium** — the target premium value. For **PremiumRange** — the lower bound of the premium range.',
    ],
    relatedFields: ['strategyPolicy.strike.premiumUpper', 'strategyPolicy.strike.strikeType'],
  }),

  'strategyPolicy.strike.premiumUpper': sp({
    fieldKey: 'strategyPolicy.strike.premiumUpper',
    title: 'Premium Upper',
    category: 'Strike Selection Policy',
    description: [
      'For **PremiumRange** type — the upper bound of the premium range. Only strikes with premium between lower and upper bounds are considered.',
    ],
    relatedFields: ['strategyPolicy.strike.premiumLower', 'strategyPolicy.strike.strikeType'],
  }),

  'strategyPolicy.strike.description': sp({
    fieldKey: 'strategyPolicy.strike.description',
    title: 'Description',
    category: 'Strike Selection Policy',
    description: [
      'Optional description of the policy\'s purpose and when it should be used.',
    ],
  }),

  // ==================== EXIT POLICY ====================

  'strategyPolicy.exit.policyName': sp({
    fieldKey: 'strategyPolicy.exit.policyName',
    title: 'Policy Name',
    category: 'Exit Policy',
    description: [
      'A unique **name** for this exit policy. Used to identify the policy when loading it as a template in Strategy Config Tree.',
    ],
    example: {
      title: 'Example',
      content: '"Same Day 15:15", "DTE-3 Positional", "Expiry Day Exit"',
    },
  }),

  'strategyPolicy.exit.exitMode': sp({
    fieldKey: 'strategyPolicy.exit.exitMode',
    title: 'Exit Mode',
    category: 'Exit Policy',
    description: [
      'Determines **when trades should be exited**.',
    ],
    validValues: [
      '**SAME_DAY** — Exit on the same day at the specified exit time',
      '**DAYS_FROM_ENTRY** — Exit N trading days after entry',
      '**DTE** — Exit N trading days before expiry (Days To Expiry)',
      '**EXPIRY** — Exit on expiry day',
      '**MINUTES_FROM_ENTRY** — Exit N trading minutes after entry (spans across trading days, excludes non-trading time)',
    ],
    relatedFields: ['strategyPolicy.exit.exitDays', 'strategyPolicy.exit.exitTime'],
  }),

  'strategyPolicy.exit.exitDays': sp({
    fieldKey: 'strategyPolicy.exit.exitDays',
    title: 'Exit Days',
    category: 'Exit Policy',
    description: [
      'The **days/minutes parameter** for the exit mode. For DAYS_FROM_ENTRY: days after entry. For DTE: days before expiry. For MINUTES_FROM_ENTRY: trading minutes after entry.',
    ],
    relatedFields: ['strategyPolicy.exit.exitMode'],
  }),

  'strategyPolicy.exit.exitTime': sp({
    fieldKey: 'strategyPolicy.exit.exitTime',
    title: 'Exit Time',
    category: 'Exit Policy',
    description: [
      'The **time of day** to execute the exit in **HH:mm:ss** format.',
    ],
    example: {
      title: 'Example',
      content: '`15:15:00` — Exit at 3:15 PM.',
    },
    relatedFields: ['strategyPolicy.exit.exitMode'],
  }),

  'strategyPolicy.exit.description': sp({
    fieldKey: 'strategyPolicy.exit.description',
    title: 'Description',
    category: 'Exit Policy',
    description: [
      'Optional description of the policy\'s purpose and when it should be used.',
    ],
  }),
};
