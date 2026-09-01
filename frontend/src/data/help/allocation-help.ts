import type { HelpArticle } from '@/types/help';

const alloc = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const allocationHelpContent: Record<string, HelpArticle> = {
  // ==================== ALLOCATION MODEL ====================

  'allocation.name': alloc({
    fieldKey: 'allocation.name',
    title: 'Name',
    category: 'Allocation Model',
    description: [
      'Unique identifier for the allocation model. This name is referenced by user-broker connections when assigning a capital allocation template.',
      'The name is **immutable** after creation. Used as the primary key and linked to strategy mappings.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Use descriptive names that reflect the strategy or risk profile. Examples: `CONSERVATIVE_5L`, `AGGRESSIVE_10L`, `NIFTY_ONLY_2L`, `FULL_PORTFOLIO_20L`.',
    },
    warning:
      'Cannot be changed after creation. Deleting an allocation model cascades — all strategy mappings within it are also deleted.',
  }),

  'allocation.intradayCapital': alloc({
    fieldKey: 'allocation.intradayCapital',
    title: 'Intraday Capital',
    category: 'Allocation Model',
    description: [
      'The total capital (in INR) allocated for **intraday (MIS) strategies** in this model. Intraday capital is used for positions that are opened and closed within the same trading day.',
      'This value represents the capital pool from which intraday strategy subscriptions draw their capital when this model is applied to a user-broker.',
    ],
    example: {
      title: 'Example',
      content:
        'Model `BALANCED_10L` with Intraday Capital = `500000` (5 lakhs). When applied, all intraday strategies in this model draw from the 5L pool. The system calculates per-strategy capital as `numOfLots × capitalPerLot` for each strategy.',
    },
    relatedFields: ['allocation.positionalCapital', 'allocation.capital'],
  }),

  'allocation.positionalCapital': alloc({
    fieldKey: 'allocation.positionalCapital',
    title: 'Positional Capital',
    category: 'Allocation Model',
    description: [
      'The total capital (in INR) allocated for **positional (NRML/CNC) strategies** in this model. Positional capital is used for overnight and multi-day positions.',
      'Positional strategies require higher margin as positions are carried forward. This capital is locked until positions are squared off.',
    ],
    example: {
      title: 'Example',
      content:
        'Model `BALANCED_10L` with Positional Capital = `500000` (5 lakhs). Combined with 5L intraday, the total model capital is 10 lakhs.',
    },
    relatedFields: ['allocation.intradayCapital', 'allocation.capital'],
    warning:
      'Positional capital is blocked until positions are closed. Ensure sufficient capital for margin requirements of overnight positions.',
  }),

  'allocation.capital': alloc({
    fieldKey: 'allocation.capital',
    title: 'Total Capital',
    category: 'Allocation Model',
    description: [
      'The **total capital** for this allocation model, automatically calculated as `Intraday Capital + Positional Capital`. This is a read-only computed field.',
      'Represents the complete capital footprint when this model is applied to a user-broker connection.',
    ],
    defaultValue: 'Auto-calculated (Intraday + Positional)',
    relatedFields: ['allocation.intradayCapital', 'allocation.positionalCapital'],
  }),

  // ==================== STRATEGY MAPPING ====================

  'allocation.strategyName': alloc({
    fieldKey: 'allocation.strategyName',
    title: 'Strategy Name',
    category: 'Strategy Mapping',
    description: [
      'The strategy included in this allocation model. Each model can contain **multiple strategies**, each with its own lot count.',
      'When the model is applied to a user-broker, strategy subscriptions are created or updated for each mapped strategy.',
    ],
    relatedFields: ['allocation.numOfLots'],
  }),

  'allocation.numOfLots': alloc({
    fieldKey: 'allocation.numOfLots',
    title: 'Number of Lots',
    category: 'Strategy Mapping',
    description: [
      'The number of lots to allocate for this strategy within the model. The system calculates the **total capital** for each strategy as: `numOfLots × capitalPerLot`.',
      'The `capitalPerLot` is determined by the strategy definition and depends on whether **hedging is enabled** at the P0 (base strategy) level:',
      '- If hedging enabled: uses `capitalPerLotHedged` (default: ₹1,00,000)\n- If hedging disabled: uses `capitalPerLotNaked` (default: ₹2,50,000)',
    ],
    example: {
      title: 'Capital Calculation Example',
      content:
        'Strategy `NIFTY_STRADDLE` with hedging enabled: capitalPerLot = ₹1,00,000.\nSet numOfLots = `3`. Total capital = 3 × ₹1,00,000 = ₹3,00,000.\n\nSame strategy without hedging: capitalPerLot = ₹2,50,000.\nnumOfLots = `3`. Total capital = 3 × ₹2,50,000 = ₹7,50,000.',
    },
    relatedFields: ['allocation.strategyName'],
  }),
};
