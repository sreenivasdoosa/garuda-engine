import type { HelpArticle } from '@/types/help';

const bill = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const billingHelpContent: Record<string, HelpArticle> = {
  // ==================== BILLING PLAN ====================

  'billingPlan.planName': bill({
    fieldKey: 'billingPlan.planName',
    title: 'Plan Name',
    category: 'Billing Plan',
    description: [
      'Unique identifier for the billing plan. Auto-converted to **uppercase** with spaces replaced by underscores. Used as the primary key and referenced by user accounts.',
      'The name is **immutable** after creation. Users are assigned billing plans through their user profile settings.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Examples: `FREE`, `BASIC_MONTHLY`, `PRO_QUARTERLY`, `ENTERPRISE_ANNUAL`. Input "Pro Quarterly" auto-converts to `PRO_QUARTERLY`.',
    },
    warning:
      'Cannot be changed after creation. Changing a user\'s plan does not retroactively affect existing bills — only future billing periods.',
  }),

  'billingPlan.displayName': bill({
    fieldKey: 'billingPlan.displayName',
    title: 'Display Name',
    category: 'Billing Plan',
    description: [
      'A user-friendly name for the billing plan, displayed in the UI and on invoices. Unlike the plan name (which is a system identifier), this can be any readable text.',
    ],
    example: {
      title: 'Examples',
      content:
        'Plan name `PRO_QUARTERLY` → Display name "Pro Plan (Quarterly)"\nPlan name `FREE` → Display name "Free Tier"',
    },
  }),

  'billingPlan.description': bill({
    fieldKey: 'billingPlan.description',
    title: 'Description',
    category: 'Billing Plan',
    description: [
      'A free-text description of what this billing plan includes. Shown in the UI for admin reference.',
    ],
  }),

  'billingPlan.billingPeriodDays': bill({
    fieldKey: 'billingPlan.billingPeriodDays',
    title: 'Billing Period (Days)',
    category: 'Billing Plan',
    description: [
      'The number of days in each billing cycle. At the end of each period, the system generates a bill based on the user\'s trading activity during that period.',
      'Common values: **30** (monthly), **90** (quarterly), **365** (annual).',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `90` (quarterly). User activated on Jan 1. First bill generated on Apr 1, covering Jan 1 - Mar 31. Second bill on Jul 1, and so on.',
    },
    defaultValue: '90',
    relatedFields: ['billingPlan.fixedCostPercentage', 'billingPlan.profitSharingPercentage'],
  }),

  'billingPlan.fixedCostPercentage': bill({
    fieldKey: 'billingPlan.fixedCostPercentage',
    title: 'Fixed Cost %',
    category: 'Billing Plan',
    description: [
      'The **fixed cost** charged as a percentage of the user\'s average deployed capital for the billing period. This is charged regardless of whether the user made a profit or loss.',
      'Formula: `Fixed Cost = Average Capital × (fixedCostPercentage / 100)`',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `1.0` (1%). User\'s average capital during the quarter = ₹10,00,000. Fixed cost = ₹10,00,000 × 1% = ₹10,000 for the quarter.',
    },
    defaultValue: '0 (no fixed cost)',
    relatedFields: ['billingPlan.profitSharingPercentage', 'billingPlan.billingPeriodDays'],
  }),

  'billingPlan.profitSharingPercentage': bill({
    fieldKey: 'billingPlan.profitSharingPercentage',
    title: 'Profit Sharing %',
    category: 'Billing Plan',
    description: [
      'The percentage of **net profits** shared with the platform during each billing period. Only charged when the user is profitable (after adjustments for previous losses and unaccounted P&L).',
      'Formula: `Variable Cost = Net Profit After Adjustments × (profitSharingPercentage / 100)`',
      'If the user has a net loss for the period, no profit sharing is charged. The loss may carry forward to offset future profits (depending on plan configuration).',
    ],
    example: {
      title: 'Example',
      content:
        'Set to `20` (20%). User\'s net profit for the quarter = ₹1,00,000. Profit share = ₹1,00,000 × 20% = ₹20,000.\n\nIf user has a net loss of ₹50,000 — profit sharing = ₹0. The ₹50,000 loss carries forward.',
    },
    relatedFields: ['billingPlan.fixedCostPercentage', 'billingPlan.noCostProfitSharingPercentage'],
  }),

  'billingPlan.noCostProfitSharingPercentage': bill({
    fieldKey: 'billingPlan.noCostProfitSharingPercentage',
    title: 'No Cost Profit Sharing %',
    category: 'Billing Plan',
    description: [
      'An alternative profit sharing percentage used when the **fixed cost is zero**. This allows offering a plan with no upfront fixed cost but a higher profit share instead.',
      'The system selects between `profitSharingPercentage` and `noCostProfitSharingPercentage` based on the effective fixed cost for the billing period.',
    ],
    example: {
      title: 'Example',
      content:
        'Plan with fixedCost = 0%, profitSharing = 20%, noCostProfitSharing = 30%. Since fixed cost is 0, the system uses 30% profit sharing instead of 20%. The user pays no fixed fee but shares a larger portion of profits.',
    },
    relatedFields: ['billingPlan.fixedCostPercentage', 'billingPlan.profitSharingPercentage'],
  }),

  // ==================== BROKERAGE PLAN ====================

  'brokeragePlan.planName': bill({
    fieldKey: 'brokeragePlan.planName',
    title: 'Plan Name',
    category: 'Brokerage Plan',
    description: [
      'Unique identifier for the brokerage plan. Auto-converted to **uppercase** with spaces replaced by underscores. Used as the primary key and referenced by user-broker connections.',
      'The name is **immutable** after creation.',
    ],
    example: {
      title: 'Naming Convention',
      content:
        'Examples: `ZERODHA_20_PER_ORDER`, `FLAT_10_PER_LOT`, `FYERS_UNLIMITED`. Name should reflect the broker and fee structure.',
    },
    warning:
      'Cannot be changed after creation.',
  }),

  'brokeragePlan.unitType': bill({
    fieldKey: 'brokeragePlan.unitType',
    title: 'Unit Type',
    category: 'Brokerage Plan',
    description: [
      'Defines **how brokerage is calculated** — per order or per lot. This determines the billing unit for computing brokerage charges.',
    ],
    validValues: [
      '**order** (Per Order) — A flat fee is charged for each order placed, regardless of the quantity. This is the most common model for discount brokers.',
      '**lot** (Per Lot) — The fee is charged per lot in the order. An order for 5 lots incurs 5× the per-unit charge.',
    ],
    example: {
      title: 'Comparison',
      content:
        '**Per Order** at ₹20: Order for 1 lot = ₹20, Order for 10 lots = ₹20 (same flat fee).\n**Per Lot** at ₹10: Order for 1 lot = ₹10, Order for 10 lots = ₹100 (10 × ₹10).',
    },
    relatedFields: ['brokeragePlan.brokeragePerUnit'],
  }),

  'brokeragePlan.brokeragePerUnit': bill({
    fieldKey: 'brokeragePlan.brokeragePerUnit',
    title: 'Brokerage Per Unit (₹)',
    category: 'Brokerage Plan',
    description: [
      'The brokerage charge in INR per unit (as defined by `unitType`). This cost is used in P&L calculations and billing reports.',
    ],
    example: {
      title: 'Common Values',
      content:
        'Zerodha: ₹20 per order (unit type = order)\nFlat brokerage: ₹10 per lot (unit type = lot)\nZero brokerage plans: ₹0 per unit',
    },
    relatedFields: ['brokeragePlan.unitType'],
  }),

  'brokeragePlan.description': bill({
    fieldKey: 'brokeragePlan.description',
    title: 'Description',
    category: 'Brokerage Plan',
    description: [
      'A free-text description of this brokerage plan. Useful for documenting the plan\'s applicability, restrictions, or source.',
    ],
    example: {
      title: 'Examples',
      content:
        '"Zerodha standard F&O plan — flat ₹20 per executed order"\n"IIFL unlimited trading plan — zero per order for premium clients"',
    },
  }),
};
