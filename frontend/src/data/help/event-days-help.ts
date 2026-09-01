import type { HelpArticle } from '@/types/help';

const ed = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const eventDaysHelpContent: Record<string, HelpArticle> = {
  // ==================== GLOBAL EVENT DAYS ====================

  'eventDays.global.exchanges': ed({
    fieldKey: 'eventDays.global.exchanges',
    title: 'Exchanges',
    category: 'Global Event Days',
    description: [
      'Select which **exchanges** this event day applies to. You can select multiple exchanges — a separate event day entry will be created for each.',
    ],
    example: {
      title: 'Example',
      content: 'Select NSE and BSE for a budget day event that affects both exchanges.',
    },
  }),

  'eventDays.global.eventDate': ed({
    fieldKey: 'eventDays.global.eventDate',
    title: 'Event Date',
    category: 'Global Event Days',
    description: [
      'The **date** of the high-impact event. Event days are dates like elections, Fed rate announcements, budget days, monthly expiries, etc. where market volatility is expected to be significantly higher.',
    ],
  }),

  'eventDays.global.capitalPercentage': ed({
    fieldKey: 'eventDays.global.capitalPercentage',
    title: 'Capital %',
    category: 'Global Event Days',
    description: [
      'The **percentage of normal capital** to deploy on this event day. Set below 100% to reduce position sizes on volatile days.',
      'This is the **global baseline** — strategy-level and user-level overrides can further adjust this value.',
    ],
    example: {
      title: 'Example',
      content: 'Set to 50 for an election day → strategies will only use 50% of their allocated capital. A strategy normally trading 3 lots will trade only 1-2 lots.',
    },
    validValues: [
      '**0** — No trading (complete halt)',
      '**1-99** — Reduced capital allocation',
      '**100** — Normal trading (event day logged but no capital reduction)',
    ],
  }),

  'eventDays.global.eventName': ed({
    fieldKey: 'eventDays.global.eventName',
    title: 'Event Name',
    category: 'Global Event Days',
    description: [
      'A descriptive **name** for the event. Used for identification in logs, alerts, and the event days table.',
    ],
    example: {
      title: 'Example',
      content: '"Monthly Expiry", "Union Budget 2026", "US Fed Rate Decision", "General Election Results"',
    },
  }),

  // ==================== STRATEGY EVENT DAY OVERRIDES ====================

  'eventDays.product.product': ed({
    fieldKey: 'eventDays.product.product',
    title: 'Product',
    category: 'Product Event Day Override',
    description: [
      'The **product** to create a capital override for: INTRADAY, POSITIONAL, CASHBUY or MTF.',
      'This override applies to all strategies using that product for the selected exchange and event day.',
    ],
  }),

  'eventDays.product.exchangeCode': ed({
    fieldKey: 'eventDays.product.exchangeCode',
    title: 'Exchange',
    category: 'Product Event Day Override',
    description: [
      'The **exchange** for this product-level override. Event days are exchange-specific, so product overrides are also scoped by exchange.',
    ],
  }),

  'eventDays.product.eventDate': ed({
    fieldKey: 'eventDays.product.eventDate',
    title: 'Event Date',
    category: 'Product Event Day Override',
    description: [
      'Select a **global event day** to override for this product. Only today or future event days for the selected exchange are shown.',
      'Dates already configured for the same product and exchange are excluded.',
    ],
  }),

  'eventDays.product.capitalPercentage': ed({
    fieldKey: 'eventDays.product.capitalPercentage',
    title: 'Capital %',
    category: 'Product Event Day Override',
    description: [
      'The **overridden capital percentage** for this product on the event day. This replaces the global capital % for all strategies of that product, unless a strategy-level or user-level override exists.',
      'Hierarchy is: Global → Product → Strategy → User.',
    ],
    example: {
      title: 'Example',
      content: 'Global event day is 50%. Product INTRADAY override is 30%. A specific strategy can still override again to 20%, and a user can override finally to 10%.',
    },
    relatedFields: ['eventDays.global.capitalPercentage', 'eventDays.strategy.capitalPercentage', 'eventDays.user.capitalPercentage'],
  }),

  'eventDays.strategy.strategyName': ed({
    fieldKey: 'eventDays.strategy.strategyName',
    title: 'Strategy',
    category: 'Strategy Event Day Override',
    description: [
      'The **strategy** to create a capital override for. Only active and wind-down strategies (excluding CAPITAL product) are shown.',
      'The exchange is automatically determined from the strategy definition.',
    ],
  }),

  'eventDays.strategy.eventDate': ed({
    fieldKey: 'eventDays.strategy.eventDate',
    title: 'Event Date',
    category: 'Strategy Event Day Override',
    description: [
      'Select a **global event day** to override for this strategy. Only future event days that haven\'t already been overridden for this strategy are shown.',
      'The dropdown shows the event name and global capital % for reference.',
    ],
  }),

  'eventDays.strategy.capitalPercentage': ed({
    fieldKey: 'eventDays.strategy.capitalPercentage',
    title: 'Capital %',
    category: 'Strategy Event Day Override',
    description: [
      'The **overridden capital percentage** for this specific strategy on the event day. This replaces the global capital % for this strategy only.',
    ],
    example: {
      title: 'Example',
      content: 'Global event day is set to 50%. A conservative strategy overrides to 25%. An aggressive strategy overrides to 75%.',
    },
    relatedFields: ['eventDays.global.capitalPercentage'],
  }),

  // ==================== USER EVENT DAY OVERRIDES ====================

  'eventDays.user.username': ed({
    fieldKey: 'eventDays.user.username',
    title: 'User',
    category: 'User Event Day Override',
    description: [
      'The **user** to create a capital override for. This allows per-user adjustments on event days.',
    ],
  }),

  'eventDays.user.exchangeCode': ed({
    fieldKey: 'eventDays.user.exchangeCode',
    title: 'Exchange',
    category: 'User Event Day Override',
    description: [
      'The **exchange** for this user override. Only exchanges that have global event days configured will have effect.',
    ],
  }),

  'eventDays.user.eventDate': ed({
    fieldKey: 'eventDays.user.eventDate',
    title: 'Event Date',
    category: 'User Event Day Override',
    description: [
      'Select a **global event day** to override for this user. Only future event days for the selected exchange are shown.',
    ],
  }),

  'eventDays.user.capitalPercentage': ed({
    fieldKey: 'eventDays.user.capitalPercentage',
    title: 'Capital %',
    category: 'User Event Day Override',
    description: [
      'The **overridden capital percentage** for this specific user on the event day. This replaces the global (or strategy-level) capital % for this user only.',
      'User-level overrides take the highest priority in the hierarchy: Global → Product → Strategy → User.',
    ],
    example: {
      title: 'Example',
      content: 'Global: 50%, Strategy override: 75%, User override: 30% → This user trades with 30% capital.',
    },
    relatedFields: ['eventDays.global.capitalPercentage', 'eventDays.strategy.capitalPercentage'],
  }),
};
