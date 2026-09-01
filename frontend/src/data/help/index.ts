import type { HelpArticle } from '@/types/help';
import { rmsHelpContent } from './rms-help';
import { brokerHelpContent } from './broker-help';
import { exchangeHelpContent } from './exchange-help';
import { symbolHelpContent } from './symbol-help';
import { allocationHelpContent } from './allocation-help';
import { billingHelpContent } from './billing-help';
import { strategyDefinitionHelpContent } from './strategy-definition-help';
import { strategyTemplateHelpContent } from './strategy-template-help';
import { tranchScheduleHelpContent } from './tranch-schedule-help';
import { userSubscriptionHelpContent } from './user-subscription-help';
import { indicatorRuleHelpContent } from './indicator-rule-help';
import { faqHelpContent } from './faq-help';
import { systemConfigHelpContent } from './system-config-help';
import { brokerConfigHelpContent } from './broker-config-help';
import { strategyConfigTreeHelpContent } from './strategy-config-tree-help';
import { strategyPolicyHelpContent } from './strategy-policy-help';
import { eventDaysHelpContent } from './event-days-help';
import { terminalHelpContent } from './terminal-help';
import { corporateActionHelpContent } from './corporate-action-help';
import { specialTradingDaysHelpContent } from './special-trading-days-help';

export {
  rmsHelpContent,
  brokerHelpContent,
  exchangeHelpContent,
  symbolHelpContent,
  allocationHelpContent,
  billingHelpContent,
  strategyDefinitionHelpContent,
  strategyTemplateHelpContent,
  tranchScheduleHelpContent,
  userSubscriptionHelpContent,
  indicatorRuleHelpContent,
  faqHelpContent,
  systemConfigHelpContent,
  brokerConfigHelpContent,
  strategyConfigTreeHelpContent,
  strategyPolicyHelpContent,
  eventDaysHelpContent,
  terminalHelpContent,
  specialTradingDaysHelpContent,
  corporateActionHelpContent,
};

export const allHelpContent: Record<string, HelpArticle> = {
  ...rmsHelpContent,
  ...brokerHelpContent,
  ...exchangeHelpContent,
  ...symbolHelpContent,
  ...allocationHelpContent,
  ...billingHelpContent,
  ...strategyDefinitionHelpContent,
  ...strategyTemplateHelpContent,
  ...tranchScheduleHelpContent,
  ...userSubscriptionHelpContent,
  ...indicatorRuleHelpContent,
  ...faqHelpContent,
  ...systemConfigHelpContent,
  ...brokerConfigHelpContent,
  ...strategyConfigTreeHelpContent,
  ...strategyPolicyHelpContent,
  ...eventDaysHelpContent,
  ...terminalHelpContent,
  ...corporateActionHelpContent,
  ...specialTradingDaysHelpContent,
};
