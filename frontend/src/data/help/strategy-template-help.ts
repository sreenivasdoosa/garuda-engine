import type { HelpArticle } from '@/types/help';

const st = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const strategyTemplateHelpContent: Record<string, HelpArticle> = {
  // ==================== BASIC INFORMATION ====================

  'strategyTemplate.templateName': st({
    fieldKey: 'strategyTemplate.templateName',
    title: 'Template Name',
    category: 'Strategy Template',
    description: [
      'Unique identifier for the strategy template. Used as the primary reference in strategy definitions that reference this template.',
      'Must contain only **alphanumeric characters, hyphens (-), and underscores (_)**.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Use descriptive names: `straddle_premium_v2`, `iron_fly_directional`, `momentum_breakout`. Include strategy type and version for clarity.',
    },
    warning:
      'Cannot be changed after creation. All strategy definitions reference this template name.',
  }),

  'strategyTemplate.displayName': st({
    fieldKey: 'strategyTemplate.displayName',
    title: 'Display Name',
    category: 'Strategy Template',
    description: [
      'A user-friendly name shown in the UI when selecting templates for strategy definitions.',
    ],
    example: {
      title: 'Example',
      content:
        'Template name: `straddle_premium_v2` → Display name: "Straddle Premium V2"',
    },
  }),

  'strategyTemplate.description': st({
    fieldKey: 'strategyTemplate.description',
    title: 'Description',
    category: 'Strategy Template',
    description: [
      'A textual description of what this template does — the trading logic it implements, when it enters/exits, and any special behaviors.',
    ],
    example: {
      title: 'Example',
      content:
        '"Premium-balanced straddle strategy with configurable SL/target. Enters at scheduled times using 3-step premium balancing for strike selection. Supports tranched entries and adaptive cascading."',
    },
  }),

  'strategyTemplate.evaluatorClass': st({
    fieldKey: 'strategyTemplate.evaluatorClass',
    title: 'Evaluator Class',
    category: 'Strategy Template',
    description: [
      'The **fully qualified Java class name** of the strategy evaluator implementation. This class contains the core trading logic — entry conditions, exit rules, position management, and hedge handling.',
      'The class must implement the strategy evaluator interface and be available in the server classpath.',
    ],
    example: {
      title: 'Example',
      content:
        'the reference engine',
    },
    warning:
      'Only sysadmin can modify this field. An incorrect class name will cause strategy evaluation to fail at runtime.',
  }),

  // ==================== CAPABILITIES ====================

  'strategyTemplate.supportsTickTrigger': st({
    fieldKey: 'strategyTemplate.supportsTickTrigger',
    title: 'Tick Trigger',
    category: 'Template Capabilities',
    description: [
      'When enabled, strategies using this template can be configured to evaluate on **every price tick** (real-time market data update). The evaluator class must implement tick-based evaluation logic.',
    ],
    defaultValue: 'false',
    relatedFields: ['strategyTemplate.supportsScheduledTrigger'],
  }),

  'strategyTemplate.supportsScheduledTrigger': st({
    fieldKey: 'strategyTemplate.supportsScheduledTrigger',
    title: 'Scheduled Trigger',
    category: 'Template Capabilities',
    description: [
      'When enabled, strategies using this template can be evaluated at **specific scheduled times** defined by tranch schedules. This is the most common trigger type.',
    ],
    defaultValue: 'true',
  }),

  'strategyTemplate.supportsSignalTrigger': st({
    fieldKey: 'strategyTemplate.supportsSignalTrigger',
    title: 'Signal Trigger',
    category: 'Template Capabilities',
    description: [
      'There is no external signal in this engine. Conditions on synthetic instruments -- a rolling straddle, implied volatility, put-call ratio -- are written as ordinary rules and evaluated here.',
    ],
    defaultValue: 'false',
  }),

  'strategyTemplate.supportsPeriodicTrigger': st({
    fieldKey: 'strategyTemplate.supportsPeriodicTrigger',
    title: 'Periodic Trigger',
    category: 'Template Capabilities',
    description: [
      'When enabled, strategies using this template can be evaluated at **regular intervals** (e.g., every 5 minutes). Unlike scheduled triggers which fire at fixed times, periodic triggers repeat at a configurable cadence.',
    ],
    defaultValue: 'false',
  }),

  'strategyTemplate.supportsHedgeManagement': st({
    fieldKey: 'strategyTemplate.supportsHedgeManagement',
    title: 'Hedge Management',
    category: 'Template Capabilities',
    description: [
      'When enabled, the evaluator class supports **automatic hedge management** — buying/rolling OTM options to limit downside risk on naked short positions. The evaluator handles hedge placement, monitoring, and replacement.',
    ],
    defaultValue: 'false',
  }),

  'strategyTemplate.isFnO': st({
    fieldKey: 'strategyTemplate.isFnO',
    title: 'F&O Strategy',
    category: 'Template Capabilities',
    description: [
      'Indicates this template is for **Futures & Options** strategies. F&O templates use the options chain, futures contracts, strike selection, and expiry management. Non-F&O templates are for equity/cash strategies.',
    ],
    defaultValue: 'false',
  }),

  'strategyTemplate.assetClass': st({
    fieldKey: 'strategyTemplate.assetClass',
    title: 'Asset Class',
    category: 'Template Capabilities',
    description: [
      'Top-level asset class of strategies built from this template: **Equity** (cash/MTF stock trading over a stock universe) or **F&O** (futures & options on an index/underlying).',
      'Equity templates size positions by rupee amount/leverage over a stock universe; F&O templates use lots, strikes, and expiries. The app deployment mode (`app.trading.mode`) controls which asset classes are available.',
    ],
    defaultValue: 'FNO',
  }),

  'strategyTemplate.supportTranches': st({
    fieldKey: 'strategyTemplate.supportTranches',
    title: 'Tranches',
    category: 'Template Capabilities',
    description: [
      'When enabled, strategies using this template support **multiple tranch entries** — the ability to enter positions in batches at different scheduled times rather than all at once.',
      'Tranch schedules are configured separately in the Tranch Schedules tab.',
    ],
    defaultValue: 'false',
    example: {
      title: 'Example',
      content:
        'A straddle strategy with 3 tranches: Tranch 1 at 9:20 (30% capital), Tranch 2 at 10:00 (40% capital), Tranch 3 at 11:00 (30% capital). This spreads entry risk across multiple time points.',
    },
  }),

  // ==================== DEFAULT CONFIG ====================

  'strategyTemplate.defaultConfig': st({
    fieldKey: 'strategyTemplate.defaultConfig',
    title: 'Default Configuration (JSON)',
    category: 'Strategy Template',
    description: [
      'A JSON string containing the **default configuration** for strategies created from this template. These values serve as baseline defaults that can be overridden at the strategy definition level or per-user config level.',
      'The structure depends on the evaluator class implementation.',
    ],
    example: {
      title: 'Example',
      content:
        '`{"slPercentage": 25, "targetPercentage": 50, "reEntryCount": 1, "reEntryType": "PREMIUM_BASED"}`',
    },
    warning:
      'Must be valid JSON. Invalid JSON will cause strategy creation or evaluation to fail.',
  }),
};
