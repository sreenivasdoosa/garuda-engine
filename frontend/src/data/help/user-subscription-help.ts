import type { HelpArticle } from '@/types/help';

const us = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const userSubscriptionHelpContent: Record<string, HelpArticle> = {
  // ==================== ADD SUBSCRIPTION MODAL ====================

  'userSubscription.strategyName': us({
    fieldKey: 'userSubscription.strategyName',
    title: 'Strategy',
    category: 'User Subscription',
    description: [
      'The **strategy definition** the user is subscribing to. Only active strategies are shown in the dropdown.',
      'A user can have at most one subscription per strategy per broker.',
    ],
    relatedFields: ['userSubscription.brokerName', 'userSubscription.capital'],
  }),

  'userSubscription.brokerName': us({
    fieldKey: 'userSubscription.brokerName',
    title: 'Broker',
    category: 'User Subscription',
    description: [
      'The **broker** through which this subscription\'s orders are placed. Must match one of the user\'s configured broker accounts (from User Broker settings).',
      'Each subscription is tied to a specific user-broker combination.',
    ],
    example: {
      title: 'Example',
      content:
        'User has ZERODHA and FINVASIA brokers configured. Subscribing to `NIFTY_STRADDLE` via ZERODHA means all orders for this strategy go through the ZERODHA account.',
    },
    relatedFields: ['userSubscription.strategyName'],
  }),

  'userSubscription.capital': us({
    fieldKey: 'userSubscription.capital',
    title: 'Capital',
    category: 'User Subscription',
    description: [
      'The **capital allocated** (in INR) for this user-strategy subscription. This determines the number of lots the engine trades for this user.',
      'Capital must be a multiple of the strategy\'s **capitalPerLot** value. The engine calculates lots as: `lots = capital / capitalPerLot`.',
    ],
    example: {
      title: 'Example',
      content:
        'Strategy `capitalPerLot` = ₹1,50,000. User allocates ₹4,50,000. Lots = 4,50,000 / 1,50,000 = 3 lots. If the strategy uses multiple tranches, these 3 lots are distributed across tranches using the sequential lot allocator.',
    },
    relatedFields: ['userSubscription.strategyName'],
    warning:
      'Setting capital to 0 effectively disables the subscription (no lots to trade). Reducing capital during active positions may affect position management.',
  }),

  // ==================== EDIT SUBSCRIPTION MODAL (RISK SECTION) ====================

  'userSubscription.riskPercentage': us({
    fieldKey: 'userSubscription.riskPercentage',
    title: 'Risk Percentage Override',
    category: 'User Subscription - Risk',
    description: [
      'An **optional override** of the strategy\'s default risk percentage for this specific user. When set, this percentage is used instead of the strategy-level default to calculate the daily risk budget.',
      'Daily risk = `capital × riskPercentage / 100`. If the strategy losses exceed this amount, trading stops for the day.',
      'Must be within the strategy\'s configured min/max risk percentage bounds.',
    ],
    example: {
      title: 'Example',
      content:
        'Strategy default: 1.5%. User override: 2.0%. Capital: ₹10,00,000. Daily risk = ₹10,00,000 × 2% = ₹20,000 (instead of ₹15,000 at default).',
    },
    relatedFields: ['userSubscription.absoluteMaxRisk', 'userSubscription.capital'],
  }),

  'userSubscription.absoluteMaxRisk': us({
    fieldKey: 'userSubscription.absoluteMaxRisk',
    title: 'Absolute Max Risk Override',
    category: 'User Subscription - Risk',
    description: [
      'An **optional override** for the absolute maximum risk amount (in INR) for this user\'s subscription. When set, this fixed amount caps the daily risk regardless of the percentage calculation.',
      'This takes precedence over the percentage-based risk calculation if both are set.',
    ],
    example: {
      title: 'Example',
      content:
        'Set to ₹25,000. Even if the percentage-based risk calculates to ₹30,000, the max daily loss is capped at ₹25,000.',
    },
    relatedFields: ['userSubscription.riskPercentage'],
  }),

  // ==================== BULK EDIT MODAL ====================

  'userSubscription.leverage': us({
    fieldKey: 'userSubscription.leverage',
    title: 'Leverage Override',
    category: 'Equity Overrides',
    description: [
      'Optional per-user **leverage override** for an equity strategy. Buying power = capital × leverage. Leave empty to use the strategy default.',
      'The value is clamped to the strategy\'s **min/max leverage** bounds on the server. Cash Buy (CNC) always runs at 1× regardless of this setting.',
    ],
  }),

  'userSubscription.maxActivePositions': us({
    fieldKey: 'userSubscription.maxActivePositions',
    title: 'Max Active Positions Override',
    category: 'Equity Overrides',
    description: [
      'Optional per-user cap on **concurrent stock positions** for an equity strategy. With the Max Positions Equal Split sizing model, buying power is divided across this many slots. Leave empty to use the strategy default.',
    ],
  }),
};
