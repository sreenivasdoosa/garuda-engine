/**
 * Email template and branding types for Admin Console.
 */

export interface EmailTemplateOverride {
  templateKey: string;
  category: string;
  displayName: string;
  description: string;
  placeholders: string; // JSON array: [{key, description}]
  isComplex: boolean;
  enabled: boolean;
  subjectOverride: string | null;
  htmlOverride: string | null;
  textOverride: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface UpdateEmailTemplateRequest {
  subjectOverride: string | null;
  htmlOverride: string | null;
  textOverride: string | null;
}

export interface EmailBrandingConfig {
  configKey?: string;
  brandName: string;
  logoUrl: string;
  brandColor: string;
  accentColor: string;
  greetingPrefix: string;
  footerText: string;
  supportEmail: string;
  dashboardUrl: string;
}

export interface TemplatePlaceholder {
  key: string;
  description: string;
}

export interface UserEmailPreferences {
  username: string;
  dailyReport: boolean;
  riskAlerts: boolean;
  tradeNotifications: boolean;
  engineNotifications: boolean;
  brokerNotifications: boolean;
  accountNotifications: boolean;
}

export interface EmailPreferenceCategory {
  key: string;
  label: string;
  description: string;
}
