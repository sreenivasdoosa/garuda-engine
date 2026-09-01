import type { HelpArticle } from '@/types/help';

const ts = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const tranchScheduleHelpContent: Record<string, HelpArticle> = {
  // ==================== TRANCH SCHEDULE FIELDS ====================

  'tranchSchedule.strategyName': ts({
    fieldKey: 'tranchSchedule.strategyName',
    title: 'Strategy',
    category: 'Tranch Schedule',
    description: [
      'The **strategy definition** this tranch schedule belongs to. A strategy can have multiple tranch schedules, each defining a separate entry time window.',
      'Only strategies with the **Tranches** capability enabled (from the template) can have tranch schedules.',
    ],
    example: {
      title: 'Example',
      content:
        'Strategy `NIFTY_STRADDLE_INTRADAY` with 3 tranches: T1 at 9:20, T2 at 10:00, T3 at 11:00. Each tranch independently evaluates entry conditions at its scheduled time.',
    },
    relatedFields: ['tranchSchedule.tranchNumber', 'tranchSchedule.scheduledTime'],
  }),

  'tranchSchedule.tranchNumber': ts({
    fieldKey: 'tranchSchedule.tranchNumber',
    title: 'Tranch Number',
    category: 'Tranch Schedule',
    description: [
      'The sequential number identifying this tranch within the strategy. Tranches are executed in order of their **scheduled time**, but the number serves as a label for identification.',
      'Must be a positive integer starting from 1.',
    ],
    example: {
      title: 'Example',
      content:
        'Tranch 1 = first entry (e.g., 9:20), Tranch 2 = second entry (e.g., 10:00), Tranch 3 = third entry (e.g., 11:00). Capital may be split equally or weighted across tranches based on the strategy configuration.',
    },
  }),

  'tranchSchedule.scheduledTime': ts({
    fieldKey: 'tranchSchedule.scheduledTime',
    title: 'Scheduled Time',
    category: 'Tranch Schedule',
    description: [
      'The exact time at which this tranch should be evaluated for entry. Format: **HH:mm:ss** (24-hour). The engine triggers strategy evaluation at this time.',
      'The scheduled time must fall within the strategy\'s start/stop time window and the exchange\'s market hours.',
    ],
    example: {
      title: 'Example',
      content:
        '`09:20:00` — Tranch evaluates at 9:20 AM. If market opens at 9:15, this gives 5 minutes for the opening volatility to settle before the first entry.',
    },
    relatedFields: ['tranchSchedule.strategyName', 'tranchSchedule.minGapSeconds'],
    warning:
      'Ensure the scheduled time is after the exchange market open time and within the strategy\'s start/stop window.',
  }),

  'tranchSchedule.minGapSeconds': ts({
    fieldKey: 'tranchSchedule.minGapSeconds',
    title: 'Min Gap (seconds)',
    category: 'Tranch Schedule',
    description: [
      'The minimum time gap in **seconds** between this tranch\'s entry and the previous tranch\'s entry. If the previous tranch was delayed (e.g., due to processing), the engine waits at least this many seconds before executing the next tranch.',
      'Set to `0` to disable the gap requirement (execute at exact scheduled time regardless of prior tranch timing).',
    ],
    defaultValue: '0',
    example: {
      title: 'Example',
      content:
        'Set to `300` (5 minutes). If Tranch 1 actually executed at 9:22 (2 min late), Tranch 2 won\'t execute until at least 9:27 (5 min gap), even if its scheduled time was 9:25.',
    },
  }),

  'tranchSchedule.maxPositionsPerTranch': ts({
    fieldKey: 'tranchSchedule.maxPositionsPerTranch',
    title: 'Max Positions',
    category: 'Tranch Schedule',
    description: [
      'The maximum number of **positions** this tranch can open. Leave empty for unlimited positions (subject to capital and risk constraints).',
      'This limits position count per tranch — useful for strategies where each tranch should only open a specific number of legs.',
    ],
    defaultValue: 'Unlimited (no limit)',
    example: {
      title: 'Example',
      content:
        'Set to `2` for a straddle strategy — each tranch opens exactly 1 CE and 1 PE position (2 positions total per tranch).',
    },
  }),

  'tranchSchedule.validFrom': ts({
    fieldKey: 'tranchSchedule.validFrom',
    title: 'Valid From',
    category: 'Tranch Schedule',
    description: [
      'The **start date** from which this tranch schedule is active. If not set, the schedule is active from creation. Format: **YYYY-MM-DD**.',
      'Useful for scheduling future tranch changes or seasonal strategy adjustments.',
    ],
    relatedFields: ['tranchSchedule.validUntil'],
  }),

  'tranchSchedule.validUntil': ts({
    fieldKey: 'tranchSchedule.validUntil',
    title: 'Valid Until',
    category: 'Tranch Schedule',
    description: [
      'The **end date** until which this tranch schedule is active. After this date, the schedule becomes inactive. If not set, the schedule remains active indefinitely.',
      'Useful for temporary tranch configurations or expiry-specific schedules.',
    ],
    relatedFields: ['tranchSchedule.validFrom'],
  }),
};
