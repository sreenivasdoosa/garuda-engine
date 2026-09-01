import type { HelpArticle } from '@/types/help';

const ir = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const indicatorRuleHelpContent: Record<string, HelpArticle> = {
  // ==================== ENTRY RULES ====================

  'indicatorRule.entryRules': ir({
    fieldKey: 'indicatorRule.entryRules',
    title: 'Entry Rules',
    category: 'Indicator Rules',
    description: [
      'Defines the conditions that must be **TRUE** to trigger a strategy entry. These are evaluated at each trigger event (scheduled, tick, periodic, or signal).',
      'Rules are organized as a **tree** of AND/OR groups containing conditions. An AND group requires all conditions to be true; an OR group requires at least one.',
      'For non-directional strategies, when entry rules are satisfied, both CE and PE are sold. For directional strategies, direction rules determine which side to trade.',
    ],
    example: {
      title: 'Example',
      content:
        'AND group with: RSI(14) on 15min > 30, SuperTrend(10,3) on 5min = GREEN. Both conditions must be true for entry to trigger.',
    },
  }),

  'indicatorRule.directionRules': ir({
    fieldKey: 'indicatorRule.directionRules',
    title: 'Direction Rules',
    category: 'Indicator Rules',
    description: [
      'Defines conditions for determining **trade direction** (LONG or SHORT) when the strategy is directional. Only shown when the strategy\'s `Directional` flag is enabled.',
      'Has two rule sets: **LONG rules** (sell PE / bullish) and **SHORT rules** (sell CE / bearish).',
      'Evaluation order: (1) Check LONG rules → if TRUE, go LONG. (2) Else check SHORT rules → if TRUE, go SHORT. (3) If neither matches, use the Direction Provider as fallback.',
    ],
  }),

  'indicatorRule.exitRules': ir({
    fieldKey: 'indicatorRule.exitRules',
    title: 'Exit Rules',
    category: 'Indicator Rules',
    description: [
      'Optional indicator-based exit conditions. When enabled and conditions are TRUE, all positions are exited. These work **in addition to** SL/target exits configured in the strategy config tree.',
      'Toggle the **Enable** switch to activate indicator-based exits.',
    ],
    example: {
      title: 'Example',
      content:
        'Exit when: SuperTrend(10,3) flips from GREEN to RED (for a long position). This provides a trend-reversal-based exit alongside the fixed SL/target.',
    },
  }),

  'indicatorRule.useIndicatorExit': ir({
    fieldKey: 'indicatorRule.useIndicatorExit',
    title: 'Enable Indicator Exit',
    category: 'Indicator Rules',
    description: [
      'Toggle to enable or disable **indicator-based exit rules**. When disabled, the strategy only uses SL/target exits from the config tree.',
      'When enabled, you can define exit conditions using the same indicator condition builder.',
    ],
    defaultValue: 'false',
  }),

  // ==================== CONDITION FIELDS ====================

  'indicatorRule.indicator': ir({
    fieldKey: 'indicatorRule.indicator',
    title: 'Indicator',
    category: 'Indicator Condition',
    description: [
      'The **technical indicator** to evaluate in this condition. Each indicator has its own parameters that control its calculation.',
    ],
    validValues: [
      '**SuperTrend** — Trend-following indicator that shows GREEN (bullish) or RED (bearish) state. Parameters: period, multiplier.',
      '**SMA** — Simple Moving Average. Parameter: period.',
      '**EMA** — Exponential Moving Average. Parameter: period. More responsive to recent prices than SMA.',
      '**RSI** — Relative Strength Index. Parameter: period. Oscillates between 0-100; >70 overbought, <30 oversold.',
      '**Bollinger Upper/Middle/Lower** — Bollinger Bands. Parameters: period, stdDev. Upper/lower bands define volatility range.',
      '**ATR** — Average True Range. Parameter: period. Measures market volatility; higher values indicate more volatile markets.',
      '**VWAP** — Volume Weighted Average Price. No parameters. Intraday benchmark for fair value.',
      '**Price** — The current market price of the underlying. No parameters.',
    ],
  }),

  'indicatorRule.params': ir({
    fieldKey: 'indicatorRule.params',
    title: 'Indicator Parameters',
    category: 'Indicator Condition',
    description: [
      'Configuration parameters specific to the selected indicator. These control how the indicator value is calculated.',
    ],
    example: {
      title: 'Common Parameters',
      content:
        'SuperTrend: `period=10, multiplier=3` (standard settings)\nRSI: `period=14` (standard), `period=7` (faster)\nEMA: `period=20` (short-term), `period=50` (medium-term)\nBollinger: `period=20, stdDev=2` (standard)\nATR: `period=14` (standard), `period=7` (faster reaction to volatility changes)',
    },
  }),

  'indicatorRule.interval': ir({
    fieldKey: 'indicatorRule.interval',
    title: 'Candle Interval',
    category: 'Indicator Condition',
    description: [
      'The **candlestick timeframe** on which the indicator is calculated. Shorter intervals react faster to price changes but produce more noise.',
    ],
    validValues: [
      '**1 minute** — Fastest, most volatile. For scalping or very short-term signals.',
      '**3 minutes** — Short-term timeframe.',
      '**5 minutes** — Common for intraday strategies. Good balance of speed and noise filtering.',
      '**10 minutes** — Medium-term intraday.',
      '**15 minutes** — Common for swing/position entries.',
      '**30 minutes** — Slower, more reliable signals.',
      '**1 hour** — For longer-term intraday or positional strategies.',
      '**1 day** — For positional strategies based on daily data.',
    ],
    example: {
      title: 'Example',
      content:
        'SuperTrend on 5-minute candles reacts quickly to intraday trends. SuperTrend on 15-minute candles gives fewer but more reliable signals.',
    },
  }),

  'indicatorRule.comparator': ir({
    fieldKey: 'indicatorRule.comparator',
    title: 'Comparator',
    category: 'Indicator Condition',
    description: [
      'The **comparison operator** that defines the condition logic between the indicator value and the target value (or reference indicator).',
      'All numeric comparators (>, <, ≥, ≤, =, ≠, Cross Above, Cross Below) support comparing against **another indicator** instead of a fixed value. Use the **[123 | f(x)]** toggle to switch between value and indicator comparison modes.',
    ],
    validValues: [
      '**> (Greater Than)** — Indicator value must be above the target. Supports reference indicator via toggle.',
      '**< (Less Than)** — Indicator value must be below the target. Supports reference indicator via toggle.',
      '**≥ (Greater or Equal)** — Indicator value must be at or above the target. Supports reference indicator via toggle.',
      '**≤ (Less or Equal)** — Indicator value must be at or below the target. Supports reference indicator via toggle.',
      '**= (Equal)** — Indicator value must equal the target (exact match). Supports reference indicator via toggle.',
      '**≠ (Not Equal)** — Indicator value must not equal the target. Supports reference indicator via toggle.',
      '**Cross Above** — Indicator has just crossed above the reference indicator. Always uses a reference indicator.',
      '**Cross Below** — Indicator has just crossed below the reference indicator. Always uses a reference indicator.',
      '**Flip** — For SuperTrend only. Detects a state change (e.g., RED → GREEN flip). Value specifies the new state.',
    ],
    example: {
      title: 'Examples',
      content:
        'RSI > 70 (overbought condition)\nRSI(14) on 5min > RSI(20) on 1hr (multi-timeframe comparison)\nEMA(9) Cross Above EMA(21) (golden cross)\nSuperTrend Flip GREEN (trend turns bullish)',
    },
  }),

  'indicatorRule.value': ir({
    fieldKey: 'indicatorRule.value',
    title: 'Value',
    category: 'Indicator Condition',
    description: [
      'The **target value** to compare the indicator against. The type depends on the indicator:',
      '- For numeric indicators (RSI, SMA, EMA, Bollinger, VWAP, Price): a number.',
      '- For state indicators (SuperTrend): a state value (GREEN or RED).',
      'Not used when comparing against a reference indicator (Cross Above/Cross Below, or when toggled to f(x) mode).',
      'For numeric comparators, you can alternatively compare against **another indicator** using the [123 | f(x)] toggle next to the comparator.',
    ],
    example: {
      title: 'Examples',
      content:
        'RSI > `70` (numeric value)\nSuperTrend = `GREEN` (state value)\nPrice > `18000` (absolute price level)\nOr toggle to f(x) mode: RSI(14) on 5min > RSI(20) on 1hr',
    },
  }),

  'indicatorRule.referenceIndicator': ir({
    fieldKey: 'indicatorRule.referenceIndicator',
    title: 'Reference Indicator',
    category: 'Indicator Condition',
    description: [
      'Any numeric comparator (>, <, ≥, ≤, =, ≠, Cross Above, Cross Below) can compare against another indicator instead of a fixed value.',
      'Use the **[123 | f(x)]** toggle button next to the comparator to switch between comparing against a fixed value (123) or a reference indicator (f(x)). Cross Above and Cross Below always use a reference indicator.',
      'The reference indicator can use a **different timeframe** from the primary indicator, enabling multi-timeframe analysis.',
    ],
    example: {
      title: 'Examples',
      content:
        'RSI(14) on 5min > RSI(20) on 1hr — Multi-timeframe RSI comparison.\nEMA(9) Cross Above EMA(21) — Golden cross detection.\nPrice > EMA(200) on Daily — Price above long-term trend.',
    },
    relatedFields: ['indicatorRule.comparator'],
  }),

  // ==================== RULE STRUCTURE ====================

  'indicatorRule.operator': ir({
    fieldKey: 'indicatorRule.operator',
    title: 'Rule Group Operator',
    category: 'Rule Structure',
    description: [
      'Defines how conditions within a group are combined:',
      '- **AND** — All conditions in the group must be TRUE for the group to be TRUE.',
      '- **OR** — At least one condition in the group must be TRUE.',
      'Groups can be nested for complex logic: e.g., `(A AND B) OR (C AND D)`.',
    ],
    example: {
      title: 'Nested Example',
      content:
        'OR group containing:\n  AND group: [RSI > 30, SuperTrend = GREEN]\n  AND group: [EMA(9) Cross Above EMA(21), Price > VWAP]\n\nEntry triggers when EITHER set of conditions is fully met.',
    },
  }),
};
