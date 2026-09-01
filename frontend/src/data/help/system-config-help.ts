import type { HelpArticle } from '@/types/help';

const sc = (article: Omit<HelpArticle, 'fieldKey'> & { fieldKey: string }): HelpArticle => article;

export const systemConfigHelpContent: Record<string, HelpArticle> = {
  'systemConfig.property': sc({
    fieldKey: 'systemConfig.property',
    title: 'Property',
    category: 'System Config',
    description: [
      'The **configuration key** identifying this setting. Uses **dot notation** for hierarchical organization (e.g., `auto.login`, `enable.scanner`).',
      'Properties are loaded from the `SYSTEM_CONFIG` database table and can be changed at runtime without restarting the application.',
    ],
    example: {
      title: 'Common Properties',
      content:
        '`auto.login` — Enable automatic broker login at market open\n`enable.scanner` — Enable the market scanner module\n`rms.enabled` — Enable the Risk Management System\n`max.users` — Maximum number of users allowed\n`supported.brokers` — Comma-separated list of supported broker names',
    },
    warning:
      'Property names cannot be changed after creation. To rename a property, delete and recreate it. Changing system properties may affect runtime behavior immediately.',
  }),

  'systemConfig.value': sc({
    fieldKey: 'systemConfig.value',
    title: 'Value',
    category: 'System Config',
    description: [
      'The **configuration value** for this property. Values are stored as strings and interpreted by the application based on the property name.',
      'Supported value types: **boolean** (`true`/`false`), **number** (integer or decimal), **string** (text, URLs, comma-separated lists), **JSON** (for complex configurations).',
    ],
    example: {
      title: 'Value Types',
      content:
        'Boolean: `true` or `false`\nNumber: `30`, `1.5`\nList: `ZERODHA,FINVASIA,ANGEL`\nURL: `https://api.example.com/webhook`',
    },
    warning:
      'Changes take effect immediately on the running system. Incorrect values may cause unexpected behavior. Verify the expected format before saving.',
  }),
};
