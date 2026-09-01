/**
 * System and Administrative type definitions
 * Covers audit logs, analytics, FAQ, and system configuration
 */

// ==================== AUDIT LOGS ====================

export interface AuditLog {
  id: number;
  entityType: string;
  entityId: string;
  entityName: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'ENABLE' | 'DISABLE' | 'LOGIN' | 'LOGOUT';
  oldData: string | null;
  newData: string | null;
  changedBy: string;
  changedTimestamp: number; // epoch millis
}

export interface AuditLogFilter {
  [key: string]: string | number | undefined;
  entityType?: string;
  entityTypes?: string;
  action?: string;
  username?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  days?: number;
  limit?: number;
  offset?: number;
  page?: number;
  pageSize?: number;
}

// ==================== ANALYTICS ====================

export interface AdminAnalytics {
  totalUsers: number;
  activeUsers: number;
  newUsersThisMonth: number;
  totalTrades: number;
  totalPnl: number;
  activeStrategies: number;
  activeBrokers: number;
  monthlyRevenue: number;
  userGrowth: { date: string; count: number }[];
  revenueGrowth: { date: string; amount: number }[];
  strategyUsage: { strategy: string; users: number; trades: number }[];
  brokerDistribution: { broker: string; users: number }[];
  tradeVolume: { date: string; count: number; pnl: number }[];
}

// ==================== FAQ ====================

export interface FAQ {
  sno: number;
  question: string;
  answer: string;
}

export interface CreateFAQRequest {
  question: string;
  answer: string;
}

// ==================== SYSTEM CONFIG ====================

export interface SystemConfig {
  systemName: string;
  supportEmail: string;
  prepaidModeDefault: boolean;
  newUserRegistrationEnabled: boolean;
  marketStartTime: string;
  marketEndTime: string;
  defaultMaxLoss: number;
  autoSquareOffEnabled: boolean;
  emailNotificationsEnabled: boolean;
  smsNotificationsEnabled: boolean;
  alertRecipients: string[];
  maintenanceMode: boolean;
  maintenanceMessage?: string;
}
