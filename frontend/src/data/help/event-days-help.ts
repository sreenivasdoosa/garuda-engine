import type { HelpArticle } from '@/types/help';

const ed = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const eventDaysHelpContent: Record<string, HelpArticle> = {
  'eventDays.overview': ed({
    fieldKey: 'eventDays.overview',
    title: 'Event Days',
    category: 'Overview',
    description: [
      'An event day is a date you want traded at **reduced size** — a budget, an election, a policy decision. The exchange is open and the strategy would trade; you simply want less on the table.',
      'There are two levels, and the more specific one wins:',
      '**Global** — one exchange, one date, one percentage. Every strategy trading that exchange is scaled by it.',
      '**Strategy** — one named strategy on the same date and exchange. It replaces the global figure for that strategy alone; every other strategy keeps the global one.',
      'A strategy override does not need a global day underneath it. On its own it scales just that strategy on that date.',
    ],
    example: {
      title: 'Global 50%, one strategy at 60%',
      content:
        'Global → `NSE` `2026-02-02` "Union Budget" `50%`\nStrategy → `short-strangle` `NSE` `2026-02-02` `60%`\n\nOn that date, on NSE:\n\n`short-strangle` trades **60%** of its normal size\nevery other strategy trades **50%**\nother exchanges and other dates are unaffected',
    },
    warning:
      'The percentage scales **lots, not capital**. Halving the capital given to an allocator does not halve its answer — a risk-aware allocator sizes off the stop distance, and a fixed allocator ignores capital entirely. Scaling the lots it returned is the only reading of "50%" that means half the size whichever allocator a strategy uses.',
    relatedFields: [
      'eventDays.global.capitalPercentage',
      'eventDays.strategy.capitalPercentage',
      'eventDays.rounding',
    ],
  }),

  'eventDays.rounding': ed({
    fieldKey: 'eventDays.rounding',
    title: 'How the reduction rounds',
    category: 'Overview',
    description: [
      'Lots are whole things, so a percentage has to round — and it rounds **down**.',
      'Rounding up would trade full size on a day you asked for less, and that is the direction of error that costs money. So 1 lot at 60% becomes **none**, not one.',
      'A consequence worth knowing: a small position can scale to nothing, and the entry is then refused with the event day named rather than silently skipped. **0% is the same mechanism** — it is how you sit a day out entirely.',
    ],
    example: {
      title: 'What the engine does with 10 lots',
      content:
        '`100%` → 10 lots\n`60%`  → 6 lots\n`50%`  → 5 lots\n`25%`  → 2 lots (2.5 rounded down)\n`0%`   → no entry; the refusal names the event day',
    },
    relatedFields: ['eventDays.overview'],
  }),

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




};
