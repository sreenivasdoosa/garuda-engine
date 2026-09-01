import type { HelpArticle } from '@/types/help';

const ca = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const corporateActionHelpContent: Record<string, HelpArticle> = {
  // ==================== CORPORATE ACTIONS (admin page) ====================

  'corporateAction.lifecycle': ca({
    fieldKey: 'corporateAction.lifecycle',
    title: 'Corporate Action Lifecycle',
    category: 'Corporate Actions',
    description: [
      'A scheduled **split** or **bonus** on an equity symbol goes through `PENDING → APPROVED → APPLIED` (or `CANCELLED`). Schedule it as soon as the exchange announces the ex-date, then **approve it before the ex-date** after verifying the ratio.',
      'Only **APPROVED** actions are applied — automatically at pre-market on the ex-date. Applying adjusts every open carry-forward equity trade (CashBuy, MTF, equity positional) on the symbol: quantities multiply by the factor, prices divide by it, so rupee value and P&L are unchanged.',
      'Original trade details are never lost: the first application freezes the original entry/quantity on the trade, and every application writes a full before/after snapshot to the journal (view it per action, and per trade in the trade-details drawer).',
    ],
    warning:
      'If the ex-date arrives while the action is still PENDING, the symbol is FROZEN — no new entries and no algo exits — until you approve or cancel. Manual square-off remains available as an explicit override.',
  }),

  'corporateAction.ratio': ca({
    fieldKey: 'corporateAction.ratio',
    title: 'Ratio & Quantity Factor',
    category: 'Corporate Actions',
    description: [
      '**SPLIT** — enter the face values: from → to. Factor = from ÷ to. Example: FV ₹10 → ₹2 means every share becomes 5 (quantities ×5, prices ÷5).',
      '**BONUS** — enter A:B (A new shares for every B held). Factor = (A+B) ÷ B. Example: bonus 1:1 → ×2; bonus 1:2 → ×1.5.',
      'Quantities are floored to whole shares; any fractional residue is recorded on the journal row so nothing disappears silently.',
    ],
    example: {
      title: 'Bonus credit window',
      content:
        'Bonus shares reach the demat account only ~2 days after the record date. Until the broker shows the new quantity, the journal row stays "Awaiting demat credit" and exits are capped at the broker-reported open quantity.',
    },
  }),

  'corporateAction.tradeBadge': ca({
    fieldKey: 'corporateAction.tradeBadge',
    title: 'Trade Adjustment Badge (⑂ ×N)',
    category: 'Corporate Actions',
    description: [
      'A `⑂ ×N` badge beside a trade\'s quantity means a corporate action adjusted this trade: quantities were multiplied by N and prices divided by N (value unchanged).',
      'The trade-details drawer shows the conversion: original quantity @ original entry → adjusted quantity @ adjusted entry. The full field-by-field before/after snapshot lives in the corporate-action journal on the admin Corporate Actions page.',
    ],
  }),
};
